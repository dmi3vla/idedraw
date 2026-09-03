// Tests for the chat-turn tool budget helper (main/tool-budget.mjs). The budget
// caps how many model-turns-that-end-in-a-tool_use (`rounds`) and how many total
// tool_use calls (`calls`) a single chat turn may issue, so a runaway live model
// stops with a bounded, observable TOOL_BUDGET_EXHAUSTED instead of hanging.
//
// The key conversation invariant: the check MUST be performed BEFORE the assistant
// tool_use block is appended, so a budget violation never leaves a dangling
// tool_use in the history (which a real Anthropic-style API would reject on the
// next turn). The helper is a pure predicate so this invariant is testable without
// Electron.
//
// Pure ESM — no fs, no Electron, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wouldExceedToolBudget, DEFAULT_TOOL_BUDGET } from '../main/tool-budget.mjs';

test('DEFAULT_TOOL_BUDGET caps at 20 rounds / 50 calls', () => {
  assert.equal(DEFAULT_TOOL_BUDGET.maxRounds, 20);
  assert.equal(DEFAULT_TOOL_BUDGET.maxCalls, 50);
});

test('a turn that stays under budget is allowed (returns false)', () => {
  // 5 rounds so far, 10 calls; next turn adds 1 call -> still under.
  assert.equal(wouldExceedToolBudget({ rounds: 5, calls: 10, nextCalls: 1 }, DEFAULT_TOOL_BUDGET), false);
  // Exactly at the limit for both is allowed (not "exceeded").
  assert.equal(wouldExceedToolBudget({ rounds: 19, calls: 49, nextCalls: 1 }, DEFAULT_TOOL_BUDGET), false);
});

test('exceeding maxRounds is rejected BEFORE the assistant tool_use is recorded', () => {
  // 20 rounds already used; one more tool_use turn exceeds the 20-round cap.
  assert.equal(wouldExceedToolBudget({ rounds: 20, calls: 5, nextCalls: 1 }, DEFAULT_TOOL_BUDGET), true);
});

test('exceeding maxCalls is rejected (cumulative tool_use calls)', () => {
  // 49 calls already; next turn wants 2 -> 51 > 50.
  assert.equal(wouldExceedToolBudget({ rounds: 3, calls: 49, nextCalls: 2 }, DEFAULT_TOOL_BUDGET), true);
  // 50 calls already; even one more exceeds.
  assert.equal(wouldExceedToolBudget({ rounds: 3, calls: 50, nextCalls: 1 }, DEFAULT_TOOL_BUDGET), true);
});

test('a 0-call next turn does not count as a new round', () => {
  // stopReason != tool_use (or empty toolUses) never happens in the tool branch,
  // but the helper must not count a text-only turn as a round.
  assert.equal(wouldExceedToolBudget({ rounds: 20, calls: 5, nextCalls: 0 }, DEFAULT_TOOL_BUDGET), false);
});

test('custom budgets are honored (e.g. an Archify profile with maxRepairRounds=1)', () => {
  const budget = { maxRounds: 3, maxCalls: 10 };
  // rounds=2 -> nextRounds=3 (== maxRounds, allowed); calls=9 + 1 = 10 (== maxCalls, allowed).
  assert.equal(wouldExceedToolBudget({ rounds: 2, calls: 9, nextCalls: 1 }, budget), false);
  // rounds=3 -> nextRounds=4 (> maxRounds) -> rejected.
  assert.equal(wouldExceedToolBudget({ rounds: 3, calls: 2, nextCalls: 1 }, budget), true);
  // calls=9, nextCalls=2 -> 11 > 10 -> rejected (rounds well under).
  assert.equal(wouldExceedToolBudget({ rounds: 1, calls: 9, nextCalls: 2 }, budget), true);
});

test('non-numeric / negative inputs are normalized (never crash)', () => {
  assert.equal(wouldExceedToolBudget({}, {}), false);
  assert.equal(wouldExceedToolBudget({ rounds: NaN, calls: 'x', nextCalls: -1 }, {}), false);
  assert.equal(wouldExceedToolBudget({ rounds: -5, calls: -5, nextCalls: 1 }, {}), false);
});
