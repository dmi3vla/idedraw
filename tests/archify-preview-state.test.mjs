// S6 — pure preview/confirm registry logic (archify-preview-state.mjs).
//
// These are the parts of adapter.mjs's preview/confirm state machine that are
// PURE and therefore testable in plain Node (no Electron, no @excalidraw/excalidraw):
//   * sceneFingerprintFromElements — content-complete, so a move/resize/edit between
//     preview and confirm yields a DIFFERENT fingerprint (Round 17 P0/P1);
//   * newPreviewToken — opaque, non-deterministic, unique per preview;
//   * prunePendingState — TTL + cap bounds on the pending/applied registries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(ROOT, 'src/canvas/adapter.mjs');
const REGISTRY = path.join(ROOT, 'src/bridge/command-registry.mjs');

import {
  sceneFingerprintFromElements,
  newPreviewToken,
  prunePendingState,
  PENDING_TTL_MS,
  PENDING_MAX,
  APPLIED_MAX,
} from '../src/canvas/archify-preview-state.mjs';

test('sceneFingerprintFromElements changes when an element MOVES (same id)', () => {
  const before = [{ id: 'manual', x: 10, y: 20, width: 100, height: 60, version: 3, versionNonce: 7 }];
  const after = [{ id: 'manual', x: 400, y: 500, width: 100, height: 60, version: 4, versionNonce: 8 }];
  assert.notEqual(sceneFingerprintFromElements(before), sceneFingerprintFromElements(after), 'a move must change the fingerprint');
});

test('sceneFingerprintFromElements changes on edit/resize/re-frame, but NOT on a pure id sort', () => {
  const base = [{ id: 'b', x: 1, y: 1, width: 10, height: 20 }, { id: 'a', x: 2, y: 2, width: 10, height: 20 }];
  const resize = [{ id: 'a', x: 2, y: 2, width: 99, height: 20 }, { id: 'b', x: 1, y: 1, width: 10, height: 20 }];
  const retext = [{ id: 'a', x: 2, y: 2, width: 10, height: 20, text: 'edited' }, { id: 'b', x: 1, y: 1, width: 10, height: 20 }];
  const reframe = [{ id: 'b', x: 1, y: 1, width: 10, height: 20, frameId: 'frame-X' }, { id: 'a', x: 2, y: 2, width: 10, height: 20 }];
  // order-independent: reordering the array must NOT change the fingerprint
  const reordered = [{ id: 'a', x: 2, y: 2, width: 10, height: 20 }, { id: 'b', x: 1, y: 1, width: 10, height: 20 }];
  assert.equal(sceneFingerprintFromElements(base), sceneFingerprintFromElements(reordered), 'order must not matter');
  assert.notEqual(sceneFingerprintFromElements(base), sceneFingerprintFromElements(resize), 'resize must differ');
  assert.notEqual(sceneFingerprintFromElements(base), sceneFingerprintFromElements(retext), 'text edit must differ');
  assert.notEqual(sceneFingerprintFromElements(base), sceneFingerprintFromElements(reframe), 're-frame must differ');
});

test('sceneFingerprintFromElements ignores deleted elements', () => {
  const live = [{ id: 'a', x: 0 }];
  const withDeleted = [{ id: 'a', x: 0 }, { id: 'gone', x: 999, isDeleted: true }];
  assert.equal(sceneFingerprintFromElements(live), sceneFingerprintFromElements(withDeleted));
});

test('newPreviewToken is opaque, unique, and non-deterministic', () => {
  const a = newPreviewToken();
  const b = newPreviewToken();
  assert.match(a, /^pt-[0-9a-f]+$/);
  assert.notEqual(a, b, 'two previews must get distinct tokens');
  assert.equal(a.startsWith('pt-'), true);
});

test('prunePendingState drops expired pending entries (TTL)', () => {
  const pending = new Map([
    ['pt-old', { createdAt: 100 }],
    ['pt-new', { createdAt: 99500 }],
  ]);
  const applied = new Set(['proj-x']);
  const removed = prunePendingState(pending, applied, { nowMs: 100000, ttlMs: 1000 });
  assert.equal(pending.has('pt-old'), false, 'expired pending dropped');
  assert.equal(pending.has('pt-new'), true, 'fresh pending kept');
  assert.equal(removed.expiredPending, 1);
});

test('prunePendingState caps the pending and applied registries (oldest evicted)', () => {
  const pending = new Map([['pt-1', { createdAt: 1 }], ['pt-2', { createdAt: 2 }], ['pt-3', { createdAt: 3 }]]);
  const applied = new Set(['proj-1', 'proj-2', 'proj-3']);
  prunePendingState(pending, applied, { nowMs: 0, ttlMs: 1e9, pendingMax: 2, appliedMax: 2 });
  assert.equal(pending.size, 2, 'pending capped');
  assert.equal(pending.has('pt-3'), true, 'newest kept');
  assert.equal(pending.has('pt-1'), false, 'oldest evicted');
  assert.equal(applied.size, 2, 'applied capped');
});

test('registry constants are sane and exported', () => {
  assert.equal(typeof PENDING_TTL_MS, 'number');
  assert.ok(PENDING_MAX > 0);
  assert.ok(APPLIED_MAX > PENDING_MAX);
  assert.ok(PENDING_TTL_MS > 60_000, 'previews should survive a few minutes');
});

// --- S6-STATE-1: project link/unlink AND any new-canvas/clear-scene boundary must
// clear the pending + applied registries so a preview token from canvas A can never
// be confirmed on canvas B. Because the adapter's confirm/cancel need a mounted
// Excalidraw API (not available under plain Node), this pins the LIFECYCLE CONTRACT
// by source inspection: clearProjectionState clears both registries, and the
// link/unlink + clearProjectionState command runners all call it.

test('clearProjectionState clears BOTH the pending and applied registries', () => {
  const src = readFileSync(ADAPTER, 'utf8');
  const start = src.indexOf('export function clearProjectionState() {');
  assert.ok(start !== -1, 'clearProjectionState declaration present');
  const end = src.indexOf('export function importArchifyProjected', start);
  assert.ok(end !== -1 && end > start, 'a following export bounds the function');
  const fn = src.slice(start, end);
  assert.ok(fn.includes('pendingPlans.clear()'), 'clears the pending map');
  assert.ok(fn.includes('appliedByToken.clear()'), 'clears the applied-by-token map');
});

test('project link/unlink and the explicit clear command all invoke clearProjectionState', () => {
  const reg = readFileSync(REGISTRY, 'utf8');
  // Every lifecycle command runner must call canvas.clearProjectionState().
  const linkStart = reg.indexOf("['canvas.linkProject'");
  assert.ok(linkStart !== -1, 'linkProject command present');
  const linkFn = reg.slice(linkStart, reg.indexOf("['canvas.unlinkProject'", linkStart));
  assert.ok(linkFn.includes('canvas.clearProjectionState()'), 'linkProject clears projection state');
  const unlinkStart = reg.indexOf("['canvas.unlinkProject'");
  assert.ok(unlinkStart !== -1, 'unlinkProject command present');
  const unlinkFn = reg.slice(unlinkStart, reg.indexOf("['canvas.importArchify'", unlinkStart));
  assert.ok(unlinkFn.includes('canvas.clearProjectionState()'), 'unlinkProject clears projection state');
  // And an explicit command exists for other new-canvas/clear-scene boundaries.
  assert.ok(reg.includes("['canvas.clearProjectionState'"), 'an explicit clearProjectionState command is registered');
});
