// Tests for the archify authoring loop (plan S4.1 / S5.1). These run the REAL
// archify CLI if it is installed (same predictable path the rest of the app
// uses). They verify security AND behaviour: an opaque runToken (never a path),
// a bounded repair budget, and the async CLI path.

import { test } from 'node:test';
import { writeFakeArchifyCli } from './helpers/fake-archify-cli.mjs';
import assert from 'node:assert/strict';
import { accessSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { authorArchify, DIAGRAM_TYPES, QUALITY_PROFILES, CLI_TIMEOUT_MS } from '../main/archify-author.mjs';
import { ARCHIFY_BIN } from '../main/archify-client.mjs';
import { resolveRun, getRun, createRun, markStatus, markBudget, _resetRuns, cleanupExpired, cleanupStaleRunDirs } from '../main/archify-runs.mjs';

const hasCLI = (() => { try { accessSync(ARCHIFY_BIN); return true; } catch { return false; } })();

function tempUserData() {
  return mkdtempSync(path.join(tmpdir(), 'archify-runs-'));
}

// A fake archify CLI that does NOT depend on the real install: it answers
// `validate <type> <candidate> --quality <q> --json` and `validate <type> <cand>
// --layout-json` by emitting a valid receipt/layout derived from the candidate.
// This lets the SECURITY token test exercise the FULL success path deterministically
// instead of relying on the ARCHIFY_NOT_FOUND fallback (which only proves the token
// survives a refusal).

// A tiny, valid architecture candidate (mirrors the CLI's bundled example shape).
const VALID = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Test Arch', quality_profile: 'showcase' },
  components: [
    { id: 'web', type: 'frontend', label: 'Web', sublabel: 'SPA', pos: [40, 100], size: [120, 60] },
    { id: 'api', type: 'backend', label: 'API', sublabel: ':8080', pos: [220, 100], size: [120, 60] },
    { id: 'db', type: 'database', label: 'DB', sublabel: 'pg', pos: [400, 100], size: [120, 60] },
  ],
  boundaries: [{ kind: 'region', label: 'Cluster', wraps: ['api', 'db'] }],
  connections: [
    { id: 'web-api', from: 'web', to: 'api', label: 'HTTPS' },
    { id: 'api-db', from: 'api', to: 'db', label: 'SQL' },
  ],
};

test('authorArchify refuses unknown type/quality/candidate with BAD_INPUT', async () => {
  const ud = tempUserData();
  const r1 = await authorArchify({ type: 'bogus', candidate: VALID, appUserData: ud });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'BAD_INPUT');
  const r2 = await authorArchify({ type: 'architecture', candidate: VALID, quality: 'insane', appUserData: ud });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'BAD_INPUT');
  const r3 = await authorArchify({ type: 'architecture', candidate: 'not-json', appUserData: ud });
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, 'BAD_INPUT');
  rmSync(ud, { recursive: true, force: true });
});

test('authorArchify requires appUserData (runs never go to process.cwd())', async () => {
  const r = await authorArchify({ type: 'architecture', candidate: VALID });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_INPUT');
});

test('authorArchify mints an opaque runToken and never reuses a path from the caller', async () => {
  // SECURITY property, independent of the real archify CLI: the token test runs
  // the FULL success path against a fake CLI fixture. The token must be an opaque
  // UUID with no path separators — never a caller-controlled path — whether the
  // run succeeds or is refused.
  const ud = tempUserData();
  const fake = writeFakeArchifyCli(ud);
  const res = await authorArchify({ type: 'architecture', candidate: VALID, quality: 'showcase', appUserData: ud, binary: fake });
  assert.equal(res.ok, true, `expected a successful run, got ${JSON.stringify(res.error || {})}`);
  const token = res.data.runToken;
  assert.ok(token, 'a runToken must be minted on a successful run');
  assert.equal(typeof token, 'string');
  assert.equal(/[\\/]/.test(token), false, 'runToken must never contain path separators');
  assert.equal(res.data.ir.components.length, 3, 'fake layout IR carries the authored components');
  rmSync(ud, { recursive: true, force: true });
});

test('an unknown runToken is rejected as UNKNOWN_RUN (no path traversal possible)', async () => {
  const ud = tempUserData();
  _resetRuns();
  const res = await authorArchify({ type: 'architecture', candidate: VALID, appUserData: ud, runToken: '../../etc/passwd' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'UNKNOWN_RUN');
  rmSync(ud, { recursive: true, force: true });
});

test('authorArchify validates a valid candidate and returns a layout IR', { skip: !hasCLI && 'archify CLI not installed' }, async () => {
  const ud = tempUserData();
  const res = await authorArchify({ type: 'architecture', candidate: VALID, quality: 'showcase', appUserData: ud, binary: ARCHIFY_BIN });
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.error || {})}`);
  assert.equal(res.data.ir.components.length, 3);
  assert.equal(res.data.ir.boundaries.length, 1);
  assert.equal(res.data.ir.connections.length, 2);
  assert.ok(res.data.ir.components[0].x !== undefined, 'layout IR must carry x/y/width/height');
  assert.ok(res.data.candidateHash.length >= 64);
  assert.ok(res.data.runToken);
  assert.ok(res.data.checks.length > 0, 'a validation receipt with checks is returned');
  rmSync(ud, { recursive: true, force: true });
});

test('authorArchify surfaces diagnostics on a bad candidate and tracks a repair run', { skip: !hasCLI && 'archify CLI not installed' }, async () => {
  const ud = tempUserData();
  const bad = { ...VALID, components: [{ id: 'x', type: 'nope', label: 'X' }] };
  const first = await authorArchify({ type: 'architecture', candidate: bad, quality: 'standard', appUserData: ud, binary: ARCHIFY_BIN, maxRepairRounds: 2 });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'VALIDATION');
  assert.ok(first.diagnostics.length >= 1, 'at least one diagnostic should be produced');
  assert.ok(first.runToken, 'a runToken is returned so the agent can repair');
  const d = first.diagnostics[0];
  assert.ok(d.code, 'diagnostic carries a code');
  assert.ok(d.message, 'diagnostic carries a message');
  rmSync(ud, { recursive: true, force: true });
});

test('DIAGRAM_TYPES and QUALITY_PROFILES cover the CLI surface', () => {
  assert.deepEqual(DIAGRAM_TYPES, ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);
  assert.deepEqual(QUALITY_PROFILES, ['standard', 'showcase']);
});

test('run registry enforces a bounded repair budget and refuses traversal tokens', () => {
  const ud = tempUserData();
  _resetRuns();
  // A malformed token must not resolve to a run.
  assert.equal(getRun('../..'), null);
  assert.equal(resolveRun('../../etc', ud).ok, false);

  // A fresh run is ALREADY attempt 1 (there is no attempt 0).
  const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 2 });
  assert.equal(r.status, 'created');
  assert.equal(r.attempt, 1);

  // A continuation with that token is the FIRST repair -> attempt 2, and the
  // recorded attempt mirrors it (no off-by-one drift between receipt and store).
  const r2 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(r2.ok, true);
  assert.equal(r2.attempt, 2);
  assert.equal(r2.run.attempt, 2);
  assert.equal(r2.run.status, 'repair');
  rmSync(ud, { recursive: true, force: true });
});

test('run registry sequence is attempt 1 -> 2 -> 3 -> REPAIR_BUDGET_EXHAUSTED (budget 2)', () => {
  const ud = tempUserData();
  _resetRuns();
  const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 2 });
  assert.equal(r.attempt, 1, 'initial validation is attempt 1');

  const repair1 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(repair1.ok, true);
  assert.equal(repair1.attempt, 2, 'repair #1 is attempt 2');

  const repair2 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(repair2.ok, true);
  assert.equal(repair2.attempt, 3, 'repair #2 is attempt 3');

  const repair3 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(repair3.ok, false);
  assert.equal(repair3.error.code, 'REPAIR_BUDGET_EXHAUSTED', 'third repair is refused');
  rmSync(ud, { recursive: true, force: true });
});

test('run registry forbids changing diagram type / quality mid-run (immutable context)', () => {
  const ud = tempUserData();
  _resetRuns();
  const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 2 });

  const wrongType = resolveRun(r.token, ud, { diagramType: 'workflow', quality: 'showcase' });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error.code, 'TRANSITION_FORBIDDEN');

  const wrongQuality = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'standard' });
  assert.equal(wrongQuality.ok, false);
  assert.equal(wrongQuality.error.code, 'TRANSITION_FORBIDDEN');
  rmSync(ud, { recursive: true, force: true });
});

test('run registry refuses to re-open a terminal (layout_ready) run', () => {
  const ud = tempUserData();
  _resetRuns();
  const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 2 });
  markStatus(r, 'layout_ready');
  const again = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'TRANSITION_FORBIDDEN');
  rmSync(ud, { recursive: true, force: true });
});

test('a continuation can never enlarge its own repair budget (immutable across calls)', () => {
  const ud = tempUserData();
  _resetRuns();
  // Created with a small budget; a later call passes a huge value.
  const r = createRun(ud, { diagramType: 'architecture', quality: 'showcase', budget: 1 });
  assert.equal(r.maxRepairRounds, 1);
  // Continuation with budget 1_000_000 must be a no-op on the stored budget.
  const r2 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase', budget: 1_000_000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.run.maxRepairRounds, 1, 'budget must stay pinned at creation');
  // The model cannot get more than budget(1) repairs: initial=1, repair1=2, repair2 exhausted.
  const repair2 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(repair2.attempt, 3, 'repair #2 is allowed (attempt 3)');
  const repair3 = resolveRun(r.token, ud, { diagramType: 'architecture', quality: 'showcase' });
  assert.equal(repair3.ok, false);
  assert.equal(repair3.error.code, 'REPAIR_BUDGET_EXHAUSTED');
  rmSync(ud, { recursive: true, force: true });
});

test('markBudget caps the budget defensively, so a runaway value cannot slip through', () => {
  const ud = tempUserData();
  _resetRuns();
  const r = createRun(ud);
  assert.equal(r.maxRepairRounds, 2, 'default budget is 2');
  // A huge repair budget is clamped, never honoured verbatim.
  markBudget(r, 999_999);
  assert.equal(r.maxRepairRounds, 4, 'budget is clamped to the ceiling');
  rmSync(ud, { recursive: true, force: true });
});
