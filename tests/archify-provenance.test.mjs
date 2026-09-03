// S6.7 — safe `customData.archify` provenance sanitization (Node-only, no Electron).
//
// The provenance written onto every projected element must be MINIMAL, deterministic
// and free of anything the renderer should not hold: absolute paths, binary path,
// API keys, prompt content, source code, run dir, IPC sender key, raw session id,
// and the main-registry-owned `runToken`. Edges must never fabricate evidence refs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEvidenceRefs, buildArchifyProvenance, buildProjectionReceipt } from '../src/canvas/archify-provenance.mjs';

test('sanitizeEvidenceRefs drops absolute / drive / dot-dot / backslash and dedupes+sorts', () => {
  const out = sanitizeEvidenceRefs([
    'src/api/a.ts',
    '/etc/passwd',
    '../escape.ts',
    'src\\api\\b.ts',
    'src/api/a.ts',
    'C:\\win\\f.ts',
    'a/../b.ts',
  ]);
  assert.deepEqual(out, ['src/api/a.ts', 'src/api/b.ts']);
});

test('sanitizeEvidenceRefs caps the count and tolerates non-array inputs', () => {
  assert.deepEqual(sanitizeEvidenceRefs(undefined), []);
  assert.deepEqual(sanitizeEvidenceRefs(null), []);
  assert.deepEqual(sanitizeEvidenceRefs('not-an-array'), []);
  const many = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
  assert.equal(sanitizeEvidenceRefs(many, { maxRefs: 10 }).length, 10);
  assert.equal(sanitizeEvidenceRefs(many, { maxRefs: 10 })[0], 'src/f0.ts');
});

test('sanitizeEvidenceRefs rejects a path that is only a dot/empty', () => {
  assert.deepEqual(sanitizeEvidenceRefs(['.', '..', '.hidden/file.ts']), ['.hidden/file.ts']);
});

test('buildArchifyProvenance builds a minimal, serializable object', () => {
  const p = buildArchifyProvenance({ sourceElementKind: 'component', sourceElementId: 'api' });
  assert.deepEqual(p, { version: 1, sourceElementKind: 'component', sourceElementId: 'api' });
});

test('buildArchifyProvenance never leaks runToken, keys, prompt or source', () => {
  const p = buildArchifyProvenance({
    sourceElementKind: 'component',
    sourceElementId: 'api',
    evidenceRefs: ['/secret', 'src/a.ts', 'src/b.ts'],
    // these are secrets the sanitizer must NOT carry even if handed them
    runToken: 'run-TOKEN-live',
    apiKey: 'sk-live-123',
    prompt: 'do X for me',
  });
  const s = JSON.stringify(p);
  assert.ok(!s.includes('TOKEN'), 'no runToken');
  assert.ok(!s.includes('sk-live'), 'no api key');
  assert.ok(!s.includes('do X'), 'no prompt content');
  assert.ok(!s.includes('/secret'), 'no absolute path');
  assert.deepEqual(p.evidenceRefs, ['src/a.ts', 'src/b.ts']);
});

test('buildArchifyProvenance keeps optional fields only when present', () => {
  const p = buildArchifyProvenance({
    sourceElementKind: 'connection',
    sourceElementId: 'edge-api-db',
  });
  assert.ok(!('projectionId' in p), 'omits projectionId when absent');
  assert.ok(!('skillHash' in p), 'omits skillHash when absent');
  assert.ok(!('evidenceRefs' in p), 'omits evidenceRefs when empty');
  assert.equal(p.sourceElementKind, 'connection');
});

test('buildArchifyProvenance includes projectionId/skillHash/snapshot when supplied', () => {
  const p = buildArchifyProvenance({
    sourceElementKind: 'boundary',
    sourceElementId: 'backend-zone',
    diagramType: 'architecture',
    projectSnapshot: 'sha256:xyz',
    skillHash: 'sha256:skill',
    projectionId: 'proj-1234abcd',
  });
  assert.equal(p.projectionId, 'proj-1234abcd');
  assert.deepEqual(p, {
    version: 1,
    projectionId: 'proj-1234abcd',
    diagramType: 'architecture',
    sourceElementKind: 'boundary',
    sourceElementId: 'backend-zone',
    skillHash: 'sha256:skill',
    projectSnapshot: 'sha256:xyz',
  });
});

// --- S6-RECEIPT-1: the safe, user-facing projection receipt -----------------

test('buildProjectionReceipt returns an applied receipt with safe fields only', () => {
  const plan = {
    projectionId: 'proj-abc',
    sourceHash: 'sha256:src',
    mode: 'merge',
    counts: { components: 3, connections: 2, boundaries: 1, excalidrawElements: 9 },
    warnings: ['a converter warning'],
    provenance: {
      diagramType: 'architecture',
      projectSnapshot: 'sha256:snap',
      skillHash: 'sha256:skill',
    },
  };
  const r = buildProjectionReceipt({ plan, result: { applied: true, mode: 'merge', appliedAt: 123 } });
  assert.equal(r.status, 'applied');
  assert.equal(r.projectionId, 'proj-abc');
  assert.equal(r.sourceHash, 'sha256:src');
  assert.equal(r.mode, 'merge');
  assert.deepEqual(r.counts, { components: 3, connections: 2, boundaries: 1, excalidrawElements: 9 });
  assert.deepEqual(r.warnings, ['a converter warning']);
  assert.equal(r.projectSnapshot, 'sha256:snap');
  assert.equal(r.skillHash, 'sha256:skill');
  assert.equal(r.diagramType, 'architecture');
  assert.equal(r.appliedAt, 123);
});

test('buildProjectionReceipt never leaks secrets, absolute paths, source or runToken', () => {
  const plan = {
    projectionId: 'proj-x',
    sourceHash: 'sha256:s',
    mode: 'replace',
    counts: { components: 1, connections: 0, boundaries: 0, excalidrawElements: 2 },
    warnings: [],
    evidenceMap: { web: ['src/web/app.ts', '/etc/passwd'] },
    nodes: [{ id: 'web', meta: { sources: ['src/web/app.ts'] } }],
    provenance: { diagramType: 'architecture' },
  };
  const r = buildProjectionReceipt({ plan, result: { applied: true } });
  const s = JSON.stringify(r);
  assert.ok(!s.includes('/etc'), 'no absolute path');
  assert.ok(!s.includes('C:'), 'no windows drive');
  assert.ok(!s.includes('runToken'), 'no runToken');
  assert.ok(!s.includes('sk-live'), 'no api key');
  assert.ok(!s.includes('do X for me'), 'no prompt content');
  assert.ok(!('nodes' in r), 'receipt never carries the element/nodes payload');
  assert.ok(!('evidenceMap' in r), 'receipt never carries the per-node evidence map');
});

test('buildProjectionReceipt reflects stale / alreadyApplied / cancelled / failed statuses', () => {
  assert.equal(buildProjectionReceipt({ result: { stale: true } }).status, 'stale');
  assert.equal(buildProjectionReceipt({ result: { alreadyApplied: true } }).status, 'already_applied');
  assert.equal(buildProjectionReceipt({ result: { cancelled: true } }).status, 'cancelled');
  assert.equal(buildProjectionReceipt({ result: { applied: false, error: { code: 'BAD' } } }).status, 'failed');
});
