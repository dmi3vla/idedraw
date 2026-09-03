// S6.1 — pure Archify projection plan contract (Node-only, no Electron).
//
// The whole point of buildArchifyProjectionPlan is that the PREVIEW and CONFIRM
// steps share ONE deterministic object, so what the user sees is exactly what
// gets committed. These tests pin that contract:
//   * determinism                identical (ir, mode, scene) -> identical plan
//   * modes                      merge preserves the scene; replace/reset list deletions
//   * collision remap           deterministic and every binding points at remapped ids
//   * placement                 merge goes right of existing; replace normalises to origin
//   * provenance                safe evidence refs, no absolute/secret paths
//   * unsupported               cards/meta.views are surfaced, never converted
//   * invalid IR                 throws rather than silently producing a plan

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildArchifyProjectionPlan } from '../src/canvas/archify-projection-plan.mjs';

const IR = {
  diagram_type: 'architecture',
  components: [
    { id: 'web', label: 'Web', x: 0, y: 0, width: 100, height: 60, sources: ['src/web/app.ts'] },
    { id: 'api', label: 'API', x: 180, y: 0, width: 100, height: 60, sources: ['src/api/index.ts', 'src/api/routes.ts'] },
    { id: 'db', label: 'DB', x: 360, y: 0, width: 100, height: 60, sources: ['src/db/index.ts'] },
  ],
  boundaries: [{ label: 'backend', wraps: ['api', 'db'] }],
  connections: [
    { from: 'web', to: 'api', label: 'HTTP' },
    { from: 'api', to: 'db', label: 'SQL' },
  ],
  cards: [{ text: 'a note' }],
  meta: { schema_version: 1, views: [{ id: 'v1', focus: ['web'] }] },
};

const empty = () => [];

test('same IR + mode + scene -> identical plan (deterministic ids/hash)', () => {
  const a = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: empty() });
  const b = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: empty() });
  assert.deepEqual(a, b);
  assert.equal(a.projectionId, b.projectionId);
  assert.equal(a.sourceHash, b.sourceHash);
});

test('plan has no Date.now or random uuids (browser-safe, replayable)', () => {
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: empty() });
  const s = JSON.stringify(p);
  assert.ok(!s.includes('Date.now'), 'no date stamp');
  assert.ok(!/crypto\.randomUUID/.test(s), 'no random uuid');
  assert.match(p.projectionId, /^proj-[0-9a-f]{32}$/);
  assert.match(p.sourceHash, /^[0-9a-f]{64}$/);
});

test('merge keeps the existing scene (no deletions) and places import to the right', () => {
  const existing = [{ id: 'manual-1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }];
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: existing });
  assert.deepEqual(p.elementIdsToDelete, []);
  // existing right edge = 100; import must begin after MERGE_GAP.
  assert.ok(p.bounds.x >= 100 + 160 - 1e-6, `placed to right, got x=${p.bounds.x}`);
});

test('replace lists every existing live element id for deletion', () => {
  const existing = [{ id: 'manual-1' }, { id: 'manual-2' }, { id: 'manual-2', isDeleted: true }];
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'replace', existingElements: existing });
  assert.deepEqual([...p.elementIdsToDelete].sort(), ['manual-1', 'manual-2']);
});

test('replace normalises the projection to a deterministic origin', () => {
  const p1 = buildArchifyProjectionPlan({ ir: IR, mode: 'replace', existingElements: [{ id: 'm', x: 999, y: 999 }] });
  const p2 = buildArchifyProjectionPlan({ ir: IR, mode: 'replace', existingElements: [{ id: 'other', x: -5, y: 123 }] });
  // Both normalise to origin -> identical bounds regardless of prior scene.
  assert.deepEqual(p1.bounds, p2.bounds);
  assert.equal(p1.bounds.x, 0);
  assert.equal(p1.bounds.y, 0);
});

test('replace origin-normalises even when the source IR content starts off-origin', () => {
  const offOrigin = {
    diagram_type: 'architecture',
    components: [
      { id: 'a', label: 'A', x: 180, y: -50, width: 100, height: 60 },
      { id: 'b', label: 'B', x: 320, y: 40, width: 100, height: 60 },
    ],
    connections: [{ from: 'a', to: 'b' }],
  };
  const p = buildArchifyProjectionPlan({ ir: offOrigin, mode: 'replace' });
  assert.equal(p.bounds.x, 0, 'content is shifted so the front-left corner sits at origin');
  assert.equal(p.bounds.y, 0, 'content is shifted so the top edge sits at origin');
  const b = p.nodes.find((n) => n.id === 'b');
  assert.equal(b.x, 140, 'relative geometry preserved after normalisation');
});

test('merge remaps colliding import ids deterministically and keeps all bindings resolved', () => {
  const existing = [
    { id: 'node-web', type: 'rectangle' },
    { id: 'text-web', type: 'text' },
  ];
  const collided = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: existing });
  const clean = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: empty() });
  const cleanWeb = clean.nodes.find((n) => n.id === 'web').id;
  // The only collision is the imported `web` (node-web/text-web already occupied),
  // so the clean plan keeps `web` while the collided plan remaps it to `web-2`.
  assert.equal(cleanWeb, 'web');
  const collidedWebIds = collided.nodes.filter((n) => n.id.startsWith('web')).map((n) => n.id);
  assert.ok(!collidedWebIds.includes('web'), 'web remapped away from the occupied id');
  assert.ok(collidedWebIds.includes('web-2'), 'remapped deterministically to web-2');

  // No duplicate node ids -> every node occupies a distinct rect/text id space.
  const ids = collided.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);

  // Every edge endpoint resolves to a node in the SAME plan.
  for (const e of collided.edges) {
    assert.ok(collided.nodes.some((n) => n.id === e.fromId), `edge from ${e.fromId} resolves`);
    assert.ok(collided.nodes.some((n) => n.id === e.toId), `edge to ${e.toId} resolves`);
  }

  // Every frame member frameId points at a frame present in the same plan.
  for (const n of collided.nodes) {
    if (n.frameId) assert.ok(collided.frames.some((f) => f.id === n.frameId), `frame ${n.frameId} exists`);
  }
});

test('counts derive from converted primitives (frames + nodes*2 + edges)', () => {
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'replace' });
  assert.equal(p.counts.components, 3);
  assert.equal(p.counts.connections, 2);
  assert.equal(p.counts.boundaries, 1);
  assert.equal(p.counts.excalidrawElements, 1 + 3 * 2 + 2);
});

test('cards and meta.views are surfaced as unsupported, never converted', () => {
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'merge' });
  assert.equal(p.unsupported.cards, 1);
  assert.equal(p.unsupported.views, 1);
  assert.equal(p.counts.components, 3, 'cards do not become components');
});

test('provenance carries safe, sorted, deduped evidence refs and no absolute paths', () => {
  const p = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'merge',
    projectContext: {
      snapshot: 'sha256:abc',
      evidenceRefs: ['src/db/index.ts', '/etc/passwd', 'src/api/index.ts', '../escape.ts', 'C:\\win\\x.ts', 'src/api/routes.ts', 'src/api/index.ts'],
    },
    skillContext: { hash: 'sha256:skill' },
  });
  assert.equal(p.provenance.projectSnapshot, 'sha256:abc');
  assert.equal(p.provenance.skillHash, 'sha256:skill');
  assert.equal(p.provenance.diagramType, 'architecture');
  assert.deepEqual(p.provenance.evidenceRefs, ['src/api/index.ts', 'src/api/routes.ts', 'src/db/index.ts']);
  const s = JSON.stringify(p);
  assert.ok(!s.includes('/etc'), 'no absolute posix path');
  assert.ok(!s.includes('C:'), 'no windows drive');
  assert.ok(!s.includes('..'), 'no parent traversal segment');
});

test('unknown mode defaults to merge (never a silent replace)', () => {
  const p = buildArchifyProjectionPlan({ ir: IR, mode: 'garbage' });
  assert.equal(p.mode, 'merge');
  assert.deepEqual(p.elementIdsToDelete, []);
});

test('invalid/broken IR throws instead of silently producing a plan', () => {
  assert.throws(() => buildArchifyProjectionPlan({ ir: null }));
  assert.throws(() => buildArchifyProjectionPlan({ ir: { diagram_type: 'sequence' } }));
  assert.throws(() => buildArchifyProjectionPlan({ ir: { components: [] } }));
  assert.throws(() => buildArchifyProjectionPlan({ ir: { components: [{ id: 'x' }] } }));
});

// --- Round 17 regression: content-complete identity ---------------------------

import { sha256Hex } from '../src/canvas/archify-projection-plan.mjs';

test('sha256Hex matches the FIPS-180-4 "abc" vector (content-complete, browser-safe)', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('projectionId/sourceHash are CONTENT-COMPLETE: label change -> different id', () => {
  const a = buildArchifyProjectionPlan({ ir: IR, mode: 'replace' });
  const irB = structuredClone(IR);
  irB.components[0].label = 'CHANGED';
  const b = buildArchifyProjectionPlan({ ir: irB, mode: 'replace' });
  assert.notEqual(a.sourceHash, b.sourceHash, 'a changed label must change sourceHash');
  assert.notEqual(a.projectionId, b.projectionId, 'a changed label must change projectionId');
});

test('projectionId/sourceHash are CONTENT-COMPLETE: coordinate/snapshot/skill -> different id', () => {
  const base = () => buildArchifyProjectionPlan({ ir: IR, mode: 'replace' });
  const a = base();

  const irMoved = structuredClone(IR);
  irMoved.components[0].x = 999;
  const moved = buildArchifyProjectionPlan({ ir: irMoved, mode: 'replace' });
  assert.notEqual(a.sourceHash, moved.sourceHash, 'coordinate change must change sourceHash');

  const snap = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'replace',
    projectContext: { snapshot: 'sha256:snapexactly' },
  });
  assert.notEqual(a.sourceHash, snap.sourceHash, 'snapshot change must change sourceHash');
  assert.notEqual(a.projectionId, snap.projectionId, 'snapshot change must change projectionId');

  const skill = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'replace',
    skillContext: { hash: 'sha256:skillx' },
  });
  assert.notEqual(a.sourceHash, skill.sourceHash, 'skill hash change must change sourceHash');
});

test('merge remap preserves the immutable sourceId (provenance, not the remapped id)', () => {
  const existing = [{ id: 'node-web', type: 'rectangle' }, { id: 'text-web', type: 'text' }];
  const collided = buildArchifyProjectionPlan({ ir: IR, mode: 'merge', existingElements: existing });
  const web = collided.nodes.find((n) => n.id === 'web-2');
  assert.ok(web, 'web must be remapped to web-2');
  assert.equal(web.id, 'web-2', 'canvas id is remapped');
  assert.equal(web.sourceId, 'web', 'sourceId stays the immutable Archify id');

  // The frame that wraps api/db keeps the boundary label sourceId, not the positioned id.
  const frame = collided.frames.find((f) => f.name === 'backend');
  assert.equal(frame.sourceId, 'backend');
});

test('connections carry their original sourceId through import + remap', () => {
  const irWithConnIds = {
    diagram_type: 'architecture',
    components: [
      { id: 'web', label: 'Web', x: 0, y: 0, width: 100, height: 60 },
      { id: 'api', label: 'API', x: 200, y: 0, width: 100, height: 60 },
    ],
    connections: [{ id: 'conn-original', from: 'web', to: 'api', label: 'HTTP' }],
  };
  const p = buildArchifyProjectionPlan({ ir: irWithConnIds, mode: 'merge' });
  assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0].sourceId, 'conn-original', 'connection id is preserved as sourceId');
  assert.equal(p.edges[0].fromId, 'web');
  assert.equal(p.edges[0].toId, 'api');

  // A connection without an id gets a deterministic sourceId fallback.
  const p2 = buildArchifyProjectionPlan({ ir: IR, mode: 'merge' });
  for (const e of p2.edges) assert.equal(e.sourceId, null, 'no fabricated id when none supplied');
});

test('per-component evidenceMap drives provenance refs (never a global list)', () => {
  const p = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'replace',
    projectContext: {
      snapshot: 'sha256:s',
      evidenceRefs: ['src/web/app.ts', 'src/api/index.ts', 'src/db/index.ts'], // global — must NOT leak per-node
      evidenceMap: { web: ['src/web/app.ts'], api: ['src/api/index.ts'], db: ['src/db/index.ts'] },
    },
  });
  assert.deepEqual(p.evidenceMap.web, ['src/web/app.ts']);
  assert.deepEqual(p.evidenceMap.api, ['src/api/index.ts']);
  const webNode = p.nodes.find((n) => n.sourceId === 'web');
  assert.ok(webNode, 'node src web exists');
  // The plan's provenance.evidenceRefs is still the global set (for the projection
  // receipt), but per-node evidence lives in evidenceMap and is what a node writes.
  assert.ok(Array.isArray(p.evidenceMap[webNode.sourceId]));
});

// --- E2E regression: evidenceMap values must be ARRAYS (the projection plan feeds
// them through sanitizeEvidenceRefs, which drops non-arrays). A single-string value
// would silently produce zero per-node refs (the Round 18 agent scenario observed
// evidenceNodes: 0 for exactly this reason). ---
test('per-node provenance writes the FULL array of that component evidence refs', () => {
  const p = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'replace',
    projectContext: {
      snapshot: 'sha256:s',
      evidenceRefs: ['src/web/app.ts', 'src/api/index.ts', 'src/api/routes.ts', 'src/db/index.ts'],
      evidenceMap: {
        web: ['src/web/app.ts'],
        api: ['src/api/index.ts', 'src/api/routes.ts'],
        db: ['src/db/index.ts'],
      },
    },
  });
  const apiNode = p.nodes.find((n) => n.sourceId === 'api');
  assert.ok(apiNode, 'api node exists');
  // The evidenceMap keeps the full per-component array (never a single string).
  assert.deepEqual(p.evidenceMap.api, ['src/api/index.ts', 'src/api/routes.ts']);
  // A node with an evidenceMap entry must be able to read it back as an array so
  // the apply step writes non-empty per-component evidenceRefs.
  assert.ok(Array.isArray(p.evidenceMap[apiNode.sourceId]));
  assert.ok(p.evidenceMap[apiNode.sourceId].length >= 1);
});

test('a component with NO evidence gets NO refs (never a global-list fallback)', () => {
  const irNoSources = {
    diagram_type: 'architecture',
    components: [
      { id: 'web', label: 'Web', x: 0, y: 0, width: 100, height: 60 },
      { id: 'api', label: 'API', x: 200, y: 0, width: 100, height: 60 },
    ],
    connections: [{ from: 'web', to: 'api' }],
  };
  const p = buildArchifyProjectionPlan({ ir: irNoSources, mode: 'replace', projectContext: { evidenceRefs: ['src/web/app.ts', 'src/api/index.ts'] } });
  // The authored IR carries no per-component sources, and the global evidenceRefs
  // must NOT be copied onto each node — so evidenceMap stays empty for both.
  assert.ok(!p.evidenceMap.web, 'web has no own evidence');
  assert.ok(!p.evidenceMap.api, 'api has no own evidence');
  const webNode = p.nodes.find((n) => n.sourceId === 'web');
  assert.equal(p.evidenceMap[webNode.sourceId], undefined);
});


test('parallel connections get unique stable edge ids in merge/replace/reset', () => {
  const ir = {
    diagram_type: 'architecture',
    components: [
      { id: 'a', label: 'A', x: 0, y: 0, width: 100, height: 60 },
      { id: 'b', label: 'B', x: 200, y: 0, width: 100, height: 60 },
    ],
    connections: [
      { id: 'http', from: 'a', to: 'b', label: 'HTTP' },
      { id: 'events', from: 'a', to: 'b', label: 'Events' },
      { from: 'a', to: 'b', label: 'Fallback 1' },
      { from: 'a', to: 'b', label: 'Fallback 2' },
    ],
  };
  for (const mode of ['merge', 'replace', 'reset']) {
    const p = buildArchifyProjectionPlan({ ir, mode });
    const ids = p.edges.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `${mode}: every edge id is unique`);
    assert.ok(ids.includes('edge-http'));
    assert.ok(ids.includes('edge-events'));
    assert.ok(ids.includes('edge-a-b'));
    assert.ok(ids.includes('edge-a-b-2'));
    assert.deepEqual(p.edges.map((e) => e.sourceId), ['http', 'events', null, null]);
  }
});

test('sourceHash covers full IR but is independent of mode/current canvas placement', () => {
  const merge = buildArchifyProjectionPlan({
    ir: IR,
    mode: 'merge',
    existingElements: [{ id: 'manual', x: 500, y: 500, width: 100, height: 100 }],
  });
  const replace = buildArchifyProjectionPlan({ ir: IR, mode: 'replace' });
  assert.equal(merge.sourceHash, replace.sourceHash, 'source identity is independent of placement/mode');
  assert.notEqual(merge.projectionId, replace.projectionId, 'exact canvas plans still differ');

  const changedCards = structuredClone(IR);
  changedCards.cards.push({ text: 'another note' });
  const cards = buildArchifyProjectionPlan({ ir: changedCards, mode: 'replace' });
  assert.notEqual(cards.sourceHash, replace.sourceHash, 'unsupported cards remain part of full source identity');

  const changedViews = structuredClone(IR);
  changedViews.meta.views.push({ id: 'v2', focus: ['api'] });
  const views = buildArchifyProjectionPlan({ ir: changedViews, mode: 'replace' });
  assert.notEqual(views.sourceHash, replace.sourceHash, 'meta.views remain part of full source identity');
});

test('boundary schema id takes precedence over mutable label for provenance sourceId', () => {
  const ir = structuredClone(IR);
  ir.boundaries = [{ id: 'backend-zone', label: 'Backend display label', wraps: ['api', 'db'] }];
  const p = buildArchifyProjectionPlan({ ir, mode: 'replace' });
  assert.equal(p.frames[0].sourceId, 'backend-zone');
  assert.equal(p.frames[0].name, 'Backend display label');
});
