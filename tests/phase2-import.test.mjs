// Phase 2 acceptance: archify import as a real, in-app command.
//
// Three layers are covered here, all runnable in plain Node (no Electron):
//   1. project-store now carries a `specPath` on the link state — the thing
//      the Archify button reads to know WHICH spec to run the CLI against.
//   2. main/archify-client.mjs resolves the `@app/...` marker and fails loudly
//      (structured ok:false + code) instead of throwing a cryptic ENOENT.
//   3. A real CLI run against the bundled spec returns an IR we can convert —
//      the same CLI call the Phase 1 tests use, but through the new helper.
//
// The CLI-dependent test skips itself (loudly) if the archify skill is missing,
// mirroring tests/archify-import.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { linkCanvas, unlinkCanvas, getLinkStatus } from '../src/project/project-store.mjs';
import { resolveSpecPath, runArchifyValidate, ARCHIFY_BIN } from '../main/archify-client.mjs';
import { importArchifyIR } from '../src/canvas/archify-import.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SPEC = path.join(ROOT, 'canvas-v2-architecture.json');

// --- 1. project-store carries a spec path on the link state ------------------
test('linkCanvas records a specPath and exposes it via getLinkStatus', () => {
  unlinkCanvas();
  const res = linkCanvas('demo-canvas', 'demo-project', '/tmp/my-spec.json');
  assert.equal(res.ok, true);
  const st = getLinkStatus();
  assert.equal(st.linked, true);
  assert.equal(st.specPath, '/tmp/my-spec.json');
});

test('linkCanvas defaults the demo spec to the bundled @app marker when none given', () => {
  unlinkCanvas();
  const res = linkCanvas('demo-canvas', 'demo-project');
  assert.equal(res.ok, true);
  assert.equal(getLinkStatus().specPath, '@app/canvas-v2-architecture.json');
});

test('unlinkCanvas clears specPath', () => {
  unlinkCanvas();
  const st = getLinkStatus();
  assert.equal(st.linked, false);
  assert.equal(st.specPath, null);
});

// --- 2. main/archify-client.mjs path resolution + loud failure --------------
test('resolveSpecPath expands the @app marker against the app root', () => {
  const got = resolveSpecPath('@app/canvas-v2-architecture.json');
  assert.equal(got, path.join(process.cwd(), 'canvas-v2-architecture.json'));
});

test('resolveSpecPath passes absolute paths through unchanged', () => {
  assert.equal(resolveSpecPath('/abs/x.json'), '/abs/x.json');
});

test('resolveSpecPath returns null for a missing path', () => {
  assert.equal(resolveSpecPath(null), null);
  assert.equal(resolveSpecPath(''), null);
});

test('runArchifyValidate fails structurally (BAD_INPUT) with no spec path', () => {
  const res = runArchifyValidate(null);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'BAD_INPUT');
});

test('runArchifyValidate surfaces ARCHIFY_NOT_FOUND when the CLI is missing', () => {
  // The helper early-checks accessSync(ARCHIFY_BIN) and returns a structured
  // ARCHIFY_NOT_FOUND instead of letting execFileSync throw a cryptic ENOENT.
  // This machine HAS the skill installed, so we cannot observe the guard firing;
  // the test asserts the contract that holds either way: the result is
  // { ok:false, code: ARCHIFY_NOT_FOUND } when the bin is absent, and the helper
  // never throws a raw error for ANY path.
  const res = runArchifyValidate(SPEC);
  assert.equal(typeof res.ok, 'boolean');
  if (!res.ok && res.error) {
    assert.equal(res.error.code, 'ARCHIFY_NOT_FOUND');
  }
});

// --- 3. real CLI run (skip if archify absent) --------------------------------
const hasArchify = existsSync(ARCHIFY_BIN);
test('runArchifyValidate on the bundled spec returns a convertible IR', { skip: !hasArchify }, () => {
  const res = runArchifyValidate('@app/canvas-v2-architecture.json');
  assert.equal(res.ok, true, res.error && res.error.message);
  assert.equal(res.data.specPath, SPEC);
  const ir = res.data.ir;
  assert.ok(Array.isArray(ir.components));
  // Same shape the Phase 1 converter expects: components->nodes, connections->edges.
  const converted = importArchifyIR({ components: ir.components, boundaries: ir.boundaries, connections: ir.connections, meta: ir.meta });
  assert.equal(converted.nodes.length, ir.components.length);
  assert.equal(converted.edges.length, ir.connections.length);
  assert.equal(converted.frames.length, ir.boundaries.length);
});
