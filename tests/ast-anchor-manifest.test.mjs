import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAstAnchorManifest, refsForAstAnchor } from '../main/project/ast-anchor-manifest.mjs';
import { buildAnchoredAstGraph } from '../main/project/ast-anchor-graph.mjs';
import { buildArchifyProjectionPlan } from '../src/canvas/archify-projection-plan.mjs';
import { buildArchifyProvenance } from '../src/canvas/archify-provenance.mjs';
import { readFileSync } from 'node:fs';

import { TIER_FILES as tierFiles } from './helpers/ast-anchor-fixture.mjs';
const connections = [
  { id: 'web-api', from: 'web', to: 'api' },
  { id: 'api-db', from: 'api', to: 'db' },
  { id: 'api-log', from: 'api', to: 'log' },
];

test('S6 AST manifest precomputes own and directed L1/L2 layers', () => {
  const manifest = buildAstAnchorManifest(tierFiles, connections);
  const web = manifest.components.web;
  assert.deepEqual(web.own, ['src/web/app.ts']);
  assert.deepEqual(web.dependenciesL1.map((x) => x.componentId), ['api']);
  assert.deepEqual(web.dependenciesL2.map((x) => [x.componentId, x.via]), [['db', 'api'], ['log', 'api']]);
  assert.deepEqual(web.dependentsL1, []);
  const db = manifest.components.db;
  assert.deepEqual(db.dependentsL1.map((x) => x.componentId), ['api']);
  assert.deepEqual(db.dependentsL2.map((x) => [x.componentId, x.via]), [['web', 'api']]);
});

test('scope selects only anchor files and never the whole project', () => {
  const anchor = buildAstAnchorManifest(tierFiles, connections).components.web;
  assert.deepEqual(refsForAstAnchor(anchor, 'own'), ['src/web/app.ts']);
  assert.deepEqual(refsForAstAnchor(anchor, 'l1'), ['src/api/index.ts', 'src/api/routes.ts', 'src/web/app.ts']);
  assert.deepEqual(refsForAstAnchor(anchor, 'l2'), ['src/api/index.ts', 'src/api/routes.ts', 'src/db/index.ts', 'src/log/index.ts', 'src/web/app.ts']);
});

test('code-canvas graph seam drops files outside the selected anchor scope', () => {
  const anchor = buildAstAnchorManifest(tierFiles, connections).components.web;
  const files = [
    { rel: 'src/web/app.ts', lines: 2, content: "import api from '../api/index';\nexport function App() {}" },
    { rel: 'src/api/index.ts', lines: 1, content: 'export class Api {}' },
    { rel: 'src/api/routes.ts', lines: 1, content: 'export const route = () => 1' },
    { rel: 'src/private/secret.ts', lines: 1, content: 'export const secret = 1' },
  ];
  const graph = buildAnchoredAstGraph({ anchor, scope: 'l1', files, snapshot: 'snap' });
  assert.deepEqual(graph.files.map((f) => f.rel), ['src/api/index.ts', 'src/api/routes.ts', 'src/web/app.ts']);
  assert.equal(JSON.stringify(graph).includes('secret'), false);
  assert.equal(JSON.stringify(graph).includes('content'), false);
  assert.equal(graph.edges.length, 1);
});

test('projection writes only the component-local AST anchor into provenance', () => {
  const filesManifest = buildAstAnchorManifest(tierFiles, connections);
  const ir = {
    schema_version: 1,
    diagram_type: 'architecture',
    components: [
      { id: 'web', type: 'frontend', label: 'Web', pos: [0, 0], size: [120, 60] },
      { id: 'api', type: 'backend', label: 'Api', pos: [200, 0], size: [120, 60] },
    ],
    connections: [{ id: 'web-api', from: 'web', to: 'api' }],
  };
  const plan = buildArchifyProjectionPlan({ ir, projectContext: { snapshot: 'snap', evidenceMap: tierFiles, filesManifest } });
  assert.equal(plan.anchorMap.web.componentId, 'web');
  assert.deepEqual(plan.anchorMap.web.own, ['src/web/app.ts']);
  const provenance = buildArchifyProvenance({ sourceElementKind: 'component', sourceElementId: 'web', astAnchor: plan.anchorMap.web });
  assert.equal(provenance.astAnchor.componentId, 'web');
  assert.equal('api' in provenance.astAnchor, false, 'full manifest is never copied into one node');
});

test('AST anchor sanitizer drops unsafe paths', () => {
  const p = buildArchifyProvenance({
    sourceElementKind: 'component', sourceElementId: 'api',
    astAnchor: { componentId: 'api', own: ['src/api.ts', '../escape', '/etc/passwd', 'C:\\secret'], dependenciesL1: [{ componentId: 'db', files: ['src/db.ts', '../bad'] }] },
  });
  assert.deepEqual(p.astAnchor.own, ['src/api.ts']);
  assert.deepEqual(p.astAnchor.dependenciesL1[0].files, ['src/db.ts']);
});

test('main/preload expose a rootless generation-scoped AST anchor endpoint', () => {
  // The AST read endpoints moved from main.mjs to main/ipc/ast.ipc.mjs.
  const main = readFileSync(new URL('../main/ipc/ast.ipc.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('project:expandAstAnchor'");
  const end = main.indexOf("ipcMain.handle('project:readAstPreview'", start);
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /input\.generation !== session\.generation/);
  assert.match(handler, /refsForAstAnchor\(anchor, scope\)/);
  assert.match(handler, /readProjectFile\(r\.root, rel/);
  assert.match(handler, /end\.data\.fingerprint !== start\.data\.fingerprint/);
  assert.doesNotMatch(handler, /input\.root|input\.path/);
  assert.match(preload, /expandAstAnchor: \(input\) => ipcRenderer\.invoke\('project:expandAstAnchor'/);
});
