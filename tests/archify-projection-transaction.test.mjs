// S6 — the "one undo transaction" invariant, checked structurally.
//
// The imperative Excalidraw API (0.18.1) exposes NO undo/redo method, but
// `updateScene` DOES accept `captureUpdate: CaptureUpdateAction.IMMEDIATELY`, which
// makes a single commit undoable immediately. applyProjectionPlan calls
// `excalidrawAPI.updateScene` EXACTLY ONCE with IMMEDIATELY and never calls
// compact() (which is its own history step). The Electron acceptance proves this is
// a single undo/redo step live (merge: 38 -> 2 manual on one Ctrl-Z, 2 -> 38 on one
// Ctrl-Shift-Z). This unit test pins the code-level contract by reading the source
// of applyProjectionPlan between the function declaration and the next exported
// function. Pure and deterministic — no Electron needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ADAPTER = path.join(ROOT, 'src/canvas/adapter.mjs');

function sliceApplyProjectionPlan() {
  const src = readFileSync(ADAPTER, 'utf8');
  const start = src.indexOf('export function applyProjectionPlan(plan) {');
  const end = src.indexOf('export function previewArchifyProjection', start);
  assert.ok(start !== -1, 'applyProjectionPlan declaration present');
  assert.ok(end !== -1 && end > start, 'a following export bounds the function');
  return src.slice(start, end);
}

test('applyProjectionPlan is ONE undo transaction (single updateScene, no compact)', () => {
  const fn = sliceApplyProjectionPlan();
  // Count the REAL API call (excalidrawAPI.updateScene( ... )) — prose in the
  // doc/comment text that merely SAYS "updateScene" must not inflate the count.
  const updateSceneCalls = (fn.match(/excalidrawAPI\.updateScene\(/g) || []).length;
  assert.equal(updateSceneCalls, 1, 'exactly one updateScene call');
  assert.ok(!fn.includes('compact('), 'never calls compact() within the apply (would add its own history step)');
  assert.ok(!fn.includes('addNode('), 'does not delegate to per-element mutators');
  assert.ok(!fn.includes('addFrame'), 'does not construct frames via a separate commit');
  assert.ok(fn.includes('replacedTombstones'), 'replace records deletions in the same history transaction');
  assert.ok(fn.includes('isDeleted: true'), 'old non-colliding elements become explicit tombstones');
});

test('the single updateScene captures the projection IMMEDIATELY on the undo stack', () => {
  const fn = sliceApplyProjectionPlan();
  // The 0.18.1 package default for captureUpdate is EVENTUALLY, which would only
  // get recorded if a later increment happens. For a confirmed projection we want
  // it undoable right away, so the atomic apply MUST pass IMMEDIATELY.
  assert.ok(
    /captureUpdate:\s*CaptureUpdateAction\.IMMEDIATELY/.test(fn),
    'updateScene captures with CaptureUpdateAction.IMMEDIATELY so the import is a single, immediately undoable step'
  );
  assert.ok(fn.includes("CaptureUpdateAction.IMMEDIATELY"), 'uses the exported CaptureUpdateAction constant');
});

test('confirmArchifyProjection applies through applyProjectionPlan (no direct updateScene)', () => {
  const src = readFileSync(ADAPTER, 'utf8');
  const start = src.indexOf('export function confirmArchifyProjection({ previewToken, projectionId } = {}) {');
  if (start === -1) {
    // tolerate the one-shot signature if a future edit reverts the previewToken
    const alt = src.indexOf('export function confirmArchifyProjection({ projectionId } = {}) {');
    assert.ok(alt !== -1, 'confirm declaration present');
  }
  const end = src.indexOf('export function cancelArchifyProjection', Math.max(start, 0));
  assert.ok(start !== -1 || end !== -1, 'confirm declaration present');
  assert.ok(end !== -1 && end > start, 'a following export bounds the function');
  const fn = src.slice(start, end);
  assert.ok(fn.includes('applyProjectionPlan('), 'confirm reuses the atomic apply');
  assert.ok(!fn.includes('updateScene'), 'confirm itself never updates the scene directly');
});


test('idempotency is preview-token scoped, not global projection suppression', () => {
  const src = readFileSync(ADAPTER, 'utf8');
  const start = src.indexOf('export function confirmArchifyProjection({ previewToken, projectionId } = {}) {');
  const end = src.indexOf('export function cancelArchifyProjection', start);
  const fn = src.slice(start, end);
  assert.ok(fn.includes('appliedByToken.has(previewToken)'), 'same consumed token is idempotent');
  assert.ok(!fn.includes('appliedProjectionIds.has'), 'a new preview with the same content is not globally suppressed');
  assert.ok(fn.includes("receipt: { ...applied.receipt, status: 'already_applied' }"), 'repeat confirm reuses the full safe applied receipt');
  assert.ok(fn.includes('appliedByToken.set(token, { projectionId: pid, appliedAt, receipt })'), 'idempotency registry retains the safe receipt');
});

test('connection provenance never substitutes generated arrow id for absent source id', () => {
  const src = readFileSync(ADAPTER, 'utf8');
  assert.ok(src.includes("provenanceFor('connection', plan, [], e.sourceId ?? null)"));
  assert.ok(!src.includes("e.sourceId ?? arrowId)"));
});
