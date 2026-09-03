// Tests for the S5.2b evidence-driven builder (main/evidence-builder.mjs).
// These prove the architecture is DERIVED from the files the agent read, not
// hardcoded: the same fixture with a tier directory renamed (api -> worker) must
// yield a different candidate; component ids/types/sublabels must come from the
// real file paths + content; and every derived component must carry the schema-
// required pos/size (verified against the real CLI `validate --layout-json`).
//
// Pure ESM — no fs, no Electron, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  componentId,
  inferType,
  extractSublabel,
  importSpecifiers,
  buildArchitectureFromEvidence,
  bindEvidenceToArchifyIr,
  srcExt,
} from '../main/evidence-builder.mjs';

// The canonical fixture (web -> api -> db). The rel+content mirror the on-disk
// fixture-project exactly, so a test here is also a source-of-truth for the
// end-to-end scenario.
function fixtureFiles() {
  return [
    {
      rel: 'src/web/app.mjs',
      content: `import { apiBase } from '../api/server.mjs';\nexport const origin = 'https://app.example.dev';\nexport function boot() { console.log('spa boot @', apiBase); }`,
    },
    {
      rel: 'src/api/server.mjs',
      content: `import { query, dsn } from '../db/index.mjs';\nexport const port = 8080;\nexport const apiBase = 'http://localhost:' + port;\nexport async function handle(req) { const rows = await query('select 1'); return { port, rows, dsn }; }`,
    },
    {
      rel: 'src/db/index.mjs',
      content: `export function query(sql) { return Promise.resolve({ rows: [{ sql }] }); }\nexport const dsn = 'postgres://user:pass@db:5432/app';`,
    },
  ];
}

// The same fixture with the api tier renamed to worker (and web's import updated).
function workerFixtureFiles() {
  return [
    {
      rel: 'src/web/app.mjs',
      content: `import { workerBase } from '../worker/worker.mjs';\nexport const origin = 'https://app.example.dev';\nexport function boot() { console.log('spa boot @', workerBase); }`,
    },
    {
      rel: 'src/db/index.mjs',
      content: `export function query(sql) { return Promise.resolve({ rows: [{ sql }] }); }\nexport const dsn = 'postgres://user:pass@db:5432/app';`,
    },
    {
      rel: 'src/worker/worker.mjs',
      content: `import { query, dsn } from '../db/index.mjs';\nexport const port = 8080;\nexport async function handle(req) { const rows = await query('select 1'); return { port, rows, dsn }; }`,
    },
  ];
}

// --- srcExt / path helpers ----------------------------------------------------

test('srcExt recognises code extensions the builder turns into components', () => {
  assert.equal(srcExt('src/web/app.mjs'), true);
  assert.equal(srcExt('src/api/server.ts'), true);
  assert.equal(srcExt('README.md'), false);
  assert.equal(srcExt('src/main.vue'), false);
});

// --- componentId ------------------------------------------------------------

test('componentId derives a stable, schema-valid id from a tier path', () => {
  assert.equal(componentId('src/web/app.mjs'), 'web');
  assert.equal(componentId('src/api/server.mjs'), 'api');
  assert.equal(componentId('src/db/index.mjs'), 'db');
  assert.equal(componentId('src/worker/worker.mjs'), 'worker');
  assert.match(componentId('src/web/app.mjs'), /^[a-zA-Z][a-zA-Z0-9_-]*$/);
});

// --- inferType ---------------------------------------------------------------

test('inferType classifies by path + content, ignoring imported tier refs', () => {
  // A frontend file that imports ../db/… must NOT be classified as database.
  const web = 'src/web/app.mjs';
  const webContent = `import { apiBase } from '../api/server.mjs';\nexport const origin = 'https://app.example.dev';`;
  assert.equal(inferType(web, webContent), 'frontend');

  // A backend file that imports ../db/… must NOT be classified as database.
  const api = 'src/api/server.mjs';
  const apiContent = `import { query, dsn } from '../db/index.mjs';\nexport const port = 8080;`;
  assert.equal(inferType(api, apiContent), 'backend');

  const db = 'src/db/index.mjs';
  const dbContent = `export const dsn = 'postgres://user:pass@db:5432/app';`;
  assert.equal(inferType(db, dbContent), 'database');
});

// --- importSpecifiers --------------------------------------------------------

test('importSpecifiers extracts relative import/require specifiers', () => {
  const s = importSpecifiers(`import { x } from '../api/server.mjs';\nconst y = require('./util.js');`);
  assert.deepEqual(s, ['../api/server.mjs', './util.js']);
});

// --- extractSublabel ---------------------------------------------------------

test('extractSublabel emits a port for backend and an engine for database', () => {
  assert.equal(extractSublabel('src/api/server.mjs', 'export const base = "http://localhost:8080";', 'backend'), ':8080');
  assert.equal(extractSublabel('src/db/index.mjs', "export const dsn = 'postgres://user:pass@db:5432/app';", 'database'), 'pg');
});

// --- buildArchitectureFromEvidence -------------------------------------------

test('buildArchitectureFromEvidence derives components + edges from read files', () => {
  const built = buildArchitectureFromEvidence(fixtureFiles());
  const ids = built.components.map((c) => c.id).sort();
  assert.deepEqual(ids, ['api', 'db', 'web']);

  const types = Object.fromEntries(built.components.map((c) => [c.id, c.type]));
  assert.equal(types.web, 'frontend');
  assert.equal(types.api, 'backend');
  assert.equal(types.db, 'database');

  // Edges are inferred from the import graph: web -> api -> db.
  const edges = built.connections.map((c) => `${c.from}->${c.to}`).sort();
  assert.deepEqual(edges, ['api->db', 'web->api']);

  // Every component carries schema-required pos/size (free placement).
  for (const c of built.components) {
    assert.ok(Array.isArray(c.pos) && c.pos.length === 2, `${c.id} has pos`);
    assert.ok(Array.isArray(c.size) && c.size.length === 2, `${c.id} has size`);
    assert.ok(typeof c.pos[0] === 'number' && typeof c.pos[1] === 'number');
  }

  // The id -> evidence file map lets an acceptance test correlate nodes to files.
  // Values are ARRAYS (one entry per component, ALL contributing files) so the S6
  // projection plan can write per-component evidenceRefs through sanitizeEvidenceRefs.
  assert.deepEqual(built.evidenceMap, {
    api: ['src/api/server.mjs'],
    db: ['src/db/index.mjs'],
    web: ['src/web/app.mjs'],
  });
  assert.deepEqual(built.evidenceRefs, ['src/api/server.mjs', 'src/db/index.mjs', 'src/web/app.mjs']);
});

test('buildArchitectureFromEvidence excludes non-source extensions', () => {
  const built = buildArchitectureFromEvidence([
    { rel: 'README.md', content: '# docs only' },
    { rel: 'src/api/server.mjs', content: `import { q } from '../db/index.mjs'; export const port = 8080;` },
    { rel: 'src/db/index.mjs', content: `export const dsn = 'postgres://u:p@db:5432/app';` },
  ]);
  const ids = built.components.map((c) => c.id).sort();
  assert.deepEqual(ids, ['api', 'db']); // README.md is not a tier
  assert.equal(built.warnings.length, 0);
});

// --- METAMORPHIC: the candidate must change when the tier is renamed ---------

test('METAMORPHIC: renaming api -> worker changes the derived architecture', () => {
  const original = buildArchitectureFromEvidence(fixtureFiles());
  const renamed = buildArchitectureFromEvidence(workerFixtureFiles());

  const originalIds = original.components.map((c) => c.id).sort();
  const renamedIds = renamed.components.map((c) => c.id).sort();
  assert.deepEqual(originalIds, ['api', 'db', 'web']);
  assert.deepEqual(renamedIds, ['db', 'web', 'worker']);

  // Nothing is hardcoded: the edges follow the rename too.
  const originalEdges = original.connections.map((c) => `${c.from}->${c.to}`).sort();
  const renamedEdges = renamed.connections.map((c) => `${c.from}->${c.to}`).sort();
  assert.deepEqual(originalEdges, ['api->db', 'web->api']);
  assert.deepEqual(renamedEdges, ['web->worker', 'worker->db']);

  // The component that changed really corresponds to the renamed file.
  assert.deepEqual(original.evidenceMap.api, ['src/api/server.mjs']);
  assert.deepEqual(renamed.evidenceMap.worker, ['src/worker/worker.mjs']);
  assert.equal(original.evidenceMap.worker, undefined);
});

test('buildArchitectureFromEvidence returns empty + warning when no source files', () => {
  const built = buildArchitectureFromEvidence([{ rel: 'README.md', content: '# docs' }]);
  assert.equal(built.components.length, 0);
  assert.equal(built.connections.length, 0);
  assert.ok(built.warnings.length > 0);
});

test('stable geometry: same input order yields same pos/size', () => {
  const a = buildArchitectureFromEvidence(fixtureFiles());
  const b = buildArchitectureFromEvidence(fixtureFiles().slice().reverse()); // shuffled
  const posA = Object.fromEntries(a.components.map((c) => [c.id, c.pos]));
  const posB = Object.fromEntries(b.components.map((c) => [c.id, c.pos]));
  assert.deepEqual(posA, posB);
});

// --- PROJECT-GRADE: multi-file tiers + canonical import resolution (Round 12) ---

function multiFileFixture() {
  return [
    { rel: 'src/api/users.mjs', content: `import { q } from '../db/index.mjs'; export const list = 1;` },
    { rel: 'src/api/orders.mjs', content: `import { q } from '../db/index.mjs'; export const o = 2;` },
    { rel: 'src/db/index.mjs', content: `export const dsn = 'postgres://u:p@db:5432/app';` },
  ];
}

function indexCollisionFixture() {
  return [
    { rel: 'src/web/app.ts', content: `import { api } from '../api';
import { db } from '../db';
export const x = 1;` },
    { rel: 'src/api/index.ts', content: `export const api = 1;` },
    { rel: 'src/db/index.ts', content: `export const db = 1;` },
  ];
}

test('AGGREGATION: multiple files of the same tier become ONE component (no duplicate ids)', () => {
  const built = buildArchitectureFromEvidence(multiFileFixture());
  const ids = built.components.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'every component id is unique');
  assert.deepEqual(ids.sort(), ['api', 'db']);
  // Edges collapse to one tier-to-tier edge, not per-file edges.
  assert.deepEqual(built.connections.map((c) => `${c.from}->${c.to}`).sort(), ['api->db']);
  // All files of a tier are recorded in evidenceRefs / tierFiles.
  assert.deepEqual(built.tierFiles.api.sort(), ['src/api/orders.mjs', 'src/api/users.mjs']);
  assert.equal(built.evidenceRefs.includes('src/api/users.mjs'), true);
  assert.equal(built.evidenceRefs.includes('src/api/orders.mjs'), true);
  // Evidence map holds an ARRAY of every file belonging to the tier.
  assert.deepEqual(built.evidenceMap.api, ['src/api/orders.mjs', 'src/api/users.mjs']);
});

test('IMPORT RESOLUTION: index.ts collisions are resolved by canonical path, not basename', () => {
  const built = buildArchitectureFromEvidence(indexCollisionFixture());
  const types = Object.fromEntries(built.components.map((c) => [c.id, c.type]));
  assert.equal(types.web, 'frontend');
  assert.equal(types.api, 'backend');
  assert.equal(types.db, 'database');
  // Directory imports resolve to the correct index files.
  const edges = built.connections.map((c) => `${c.from}->${c.to}`).sort();
  assert.deepEqual(edges, ['web->api', 'web->db']);
  assert.deepEqual(built.evidenceMap.api, ['src/api/index.ts']);
  assert.deepEqual(built.evidenceMap.db, ['src/db/index.ts']);
});

test('resolveImport resolves extension-less and directory forms relative to the importer', () => {
  const files = [
    { rel: 'src/web/app.mjs', content: `import { x } from '../api/server'; export const x = 1;` },
    { rel: 'src/api/server.mjs', content: `export const x = 1;` },
  ];
  const built = buildArchitectureFromEvidence(files);
  assert.deepEqual(built.connections.map((c) => `${c.from}->${c.to}`).sort(), ['web->api']);
});

// --- ROUND 13: module IDENTITY separate from component TYPE -------------------
// The reviewer found that `src/catalog/index.ts` + `src/billing/index.ts` both
// produced id `index` and falsely merged into one component (losing the
// catalog->billing edge). Module identity must come from the nearest meaningful
// directory, so distinct feature modules never collapse.

test('componentId uses module identity, not the generic file stem (no index/main merge)', () => {
  assert.equal(componentId('src/catalog/index.ts'), 'catalog');
  assert.equal(componentId('src/billing/index.ts'), 'billing');
  // The canonical tiers still resolve to their directory names.
  assert.equal(componentId('src/web/app.mjs'), 'web');
  assert.equal(componentId('src/api/server.mjs'), 'api');
  assert.equal(componentId('src/db/index.mjs'), 'db');
  assert.equal(componentId('src/worker/worker.mjs'), 'worker');
});

test('MODULAR: catalog and billing index files become DISTINCT components with the edge preserved', () => {
  const files = [
    { rel: 'src/catalog/index.ts', content: `import { billing } from '../billing/index.ts'; export const catalog = 1;` },
    { rel: 'src/billing/index.ts', content: `export const billing = 1;` },
  ];
  const built = buildArchitectureFromEvidence(files);
  const ids = built.components.map((c) => c.id);
  assert.deepEqual(ids.sort(), ['billing', 'catalog']);
  // No false self-edge: the catalog->billing edge survives, and there is no bogus
  // `index` module collapsing both files.
  assert.deepEqual(built.connections.map((c) => `${c.from}->${c.to}`).sort(), ['catalog->billing']);
  // evidenceMap values are ARRAYS (one entry per component, ALL contributing files)
  // so the S6 projection plan can write per-component evidenceRefs. A single-string
  // value would be dropped by sanitizeEvidenceRefs (evidenceNodes: 0 regression).
  assert.deepEqual(built.evidenceMap.catalog, ['src/catalog/index.ts']);
  assert.deepEqual(built.evidenceMap.billing, ['src/billing/index.ts']);
});

test('componentId falls back to a meaningful stem when the file sits under a generic dir', () => {
  // src/utils/date.ts -> nearest meaningful is the generic `utils` dir; the file
  // stem `date` is meaningful (not a role name), so it stays a distinct module.
  assert.equal(componentId('src/utils/date.ts'), 'utils');
});

// --- ROUND 14: namespace-aware identity (monorepo) ---------------------------
// The reviewer found that under a workspace root (apps/packages/libs/modules),
// two apps/packages with the same internal subdirectory falsely merged into one
// `api`/`components` module. `componentId` must PREFIX the module identity with the
// app/package namespace so they stay distinct, while single-app repos keep the
// simple module id.

test('NAMESPACE: identical subdirs across two apps do NOT merge (apps/* namespace)', () => {
  assert.equal(componentId('apps/web/src/api/index.ts'), 'web-api');
  assert.equal(componentId('apps/admin/src/api/index.ts'), 'admin-api');
  assert.equal(componentId('apps/web/src/components/Button.tsx'), 'web-components');
  assert.equal(componentId('apps/admin/src/components/Button.tsx'), 'admin-components');
  // A file directly under the package src/ (no distinct sub-module) namespaces alone.
  assert.equal(componentId('apps/web/src/index.ts'), 'web');
});

test('NAMESPACE: identical subdirs across two packages do NOT merge (packages/* namespace)', () => {
  assert.equal(componentId('packages/catalog/src/components/Button.tsx'), 'catalog-components');
  assert.equal(componentId('packages/billing/src/components/Button.tsx'), 'billing-components');
  assert.equal(componentId('packages/catalog/src/index.ts'), 'catalog');
});

test('NAMESPACE: single-app repos keep the simple module id (no prefix)', () => {
  assert.equal(componentId('src/catalog/index.ts'), 'catalog');
  assert.equal(componentId('src/web/app.mjs'), 'web');
  assert.equal(componentId('src/db/index.mjs'), 'db');
});

// --- ROUND 13: schema content causality --------------------------------------
// The Archify schema must genuinely constrain the candidate, not just gate it.
// When `allowedComponentTypes` is supplied, modules whose inferred type is not in
// the schema's enum are dropped (with a warning).

test('SCHEMA CAUSALITY: allowedComponentTypes SNAPS a disallowed type instead of silently dropping', () => {
  const files = [
    { rel: 'src/web/app.mjs', content: `import { api } from '../api/server.mjs'; export const x = 1;` },
    { rel: 'src/api/server.mjs', content: `import { q } from '../db/index.mjs'; export const port = 8080;` },
    { rel: 'src/db/index.mjs', content: `export const dsn = 'postgres://u@db:5432/app';` },
  ];
  // Schema only allows frontend + backend -> db (database) is SNAPPED to the nearest
  // allowed type (frontend), NOT silently dropped: real modules are never erased
  // just because a heuristic guessed a type the schema enum omits.
  const built = buildArchitectureFromEvidence(files, { allowedComponentTypes: ['frontend', 'backend'] });
  assert.deepEqual(built.components.map((c) => c.id).sort(), ['api', 'db', 'web']);
  const db = built.components.find((c) => c.id === 'db');
  assert.equal(db.type, 'frontend'); // snapped from database
  assert.deepEqual(built.connections.map((c) => `${c.from}->${c.to}`).sort(), ['api->db', 'web->api']);
  assert.ok(built.warnings.some((w) => /db.*snapped/i.test(w)));
  // A schema without a type enum does not snap anything.
  const all = buildArchitectureFromEvidence(files, { allowedComponentTypes: null });
  assert.deepEqual(all.components.map((c) => c.id).sort(), ['api', 'db', 'web']);
});

test('S6 side channel rekeys exact tier files to model-authored IR ids and builds L1/L2 anchors', () => {
  const files = [
    { rel: 'src/chat/chat-panel.mjs', content: `import { bridge } from '../bridge/bridge.mjs'; export function mountChat() {}` },
    { rel: 'src/bridge/bridge.mjs', content: `import { registry } from './command-registry.mjs'; export const bridge = {};` },
    { rel: 'src/bridge/command-registry.mjs', content: `export class CommandRegistry { execute() {} }` },
    { rel: 'main/project/project-fs.mjs', content: `export function readProjectFile() {}` },
  ];
  const ir = {
    components: [
      { id: 'chat_ui', type: 'frontend', label: 'Chat UI' },
      { id: 'command_engine', type: 'backend', label: 'Command Engine' },
      { id: 'store_fs', type: 'database', label: 'Project FS Store' },
    ],
    connections: [
      { id: 'chat-command', from: 'chat_ui', to: 'command_engine' },
      { id: 'command-store', from: 'command_engine', to: 'store_fs' },
    ],
  };
  const bound = bindEvidenceToArchifyIr(ir, files);
  assert.deepEqual(Object.keys(bound.evidenceMap).sort(), ['chat_ui', 'command_engine', 'store_fs']);
  assert.ok(bound.evidenceMap.chat_ui.some((rel) => rel.includes('/chat/')));
  assert.ok(bound.evidenceMap.command_engine.some((rel) => rel.includes('/bridge/')));
  assert.ok(bound.evidenceMap.store_fs.some((rel) => rel.includes('project-fs')));
  const command = bound.filesManifest.components.command_engine;
  assert.ok(command.own.length > 0);
  assert.ok(command.dependentsL1.some((item) => item.componentId === 'chat_ui'));
  assert.ok(command.dependenciesL1.some((item) => item.componentId === 'store_fs'));
  assert.ok(bound.filesManifest.components.chat_ui.dependenciesL2.some((item) => item.componentId === 'store_fs'));
});
