import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAstAnchorManifest, refsForAstAnchor } from '../main/project/ast-anchor-manifest.mjs';
import { buildAnchoredReadPreview, PREVIEW_LINE_LIMITS } from '../main/project/ast-anchor-preview.mjs';

import { TIER_FILES as tierFiles } from './helpers/ast-anchor-fixture.mjs';
const connections = [
  { id: 'web-api', from: 'web', to: 'api' },
  { id: 'api-db', from: 'api', to: 'db' },
  { id: 'api-log', from: 'api', to: 'log' },
];
const anchor = buildAstAnchorManifest(tierFiles, connections).components.web;

function file(rel, content, lines = null) {
  return { rel, lines: lines ?? String(content).split(/\r?\n/).length, truncated: false, content };
}

test('read-preview slices a file inside the anchor scope', () => {
  const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = buildAnchoredReadPreview({ anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', content) });
  assert.equal(res.ok, true);
  assert.equal(res.data.startLine, 1);
  assert.equal(res.data.returnedLines, 90);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.totalLines, 120);
  assert.equal(res.data.body.split('\n')[0], 'line 1');
  assert.equal(res.data.nextStartLine, 91);
});

test('read-preview refuses a file outside the anchor scope', () => {
  const res = buildAnchoredReadPreview({ anchor, scope: 'own', rel: 'src/db/index.ts', file: file('src/db/index.ts', 'x') });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OUT_OF_SCOPE');
});

test('read-preview honors a startLine/endLine window bounded by the cap', () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = buildAnchoredReadPreview({
    anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', content),
    startLine: 41, endLine: 999, maxLines: 200,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.startLine, 41);
  assert.equal(res.data.endLine, 240); // cap: 41 + 200 - 1
  assert.equal(res.data.returnedLines, 200);
  assert.equal(res.data.truncated, true);
  assert.equal(res.data.nextStartLine, 241);
});

test('read-preview caps the window and never expands beyond maxLines', () => {
  const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = buildAnchoredReadPreview({
    anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', content),
    startLine: 10, endLine: 999, maxLines: 999,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.returnedLines, 51); // 10..60
  assert.equal(res.data.truncated, false);
  assert.equal(PREVIEW_LINE_LIMITS.maxLines, 200);
});



test('read-preview supports a page after line 200 when main loaded through that window', () => {
  const content = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
  const res = buildAnchoredReadPreview({
    anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', content),
    startLine: 201, maxLines: 200,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.startLine, 201);
  assert.equal(res.data.endLine, 400);
  assert.equal(res.data.returnedLines, 200);
  assert.equal(res.data.body.split('\n')[0], 'line 201');
  assert.equal(res.data.nextStartLine, 401);
});

test('read-preview rejects an impossible start without negative ranges', () => {
  const res = buildAnchoredReadPreview({
    anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', 'one\ntwo'),
    startLine: 999,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'RANGE_OUT_OF_BOUNDS');
});

test('read-preview enforces the declared UTF-8 byte cap', () => {
  const content = Array.from({ length: 20 }, () => 'я'.repeat(2000)).join('\n');
  const res = buildAnchoredReadPreview({
    anchor, scope: 'own', rel: 'src/web/app.ts', file: file('src/web/app.ts', content),
    maxLines: 20,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.byteTruncated, true);
  assert.ok(Buffer.byteLength(res.data.body, 'utf8') <= PREVIEW_LINE_LIMITS.byteCap);
  assert.equal(res.data.nextStartLine, undefined);
});

test('l1 scope resolves and previews neighbour and own files', () => {
  const l1 = refsForAstAnchor(anchor, 'l1');
  assert.ok(l1.includes('src/api/index.ts'));
  const res = buildAnchoredReadPreview({
    anchor, scope: 'l1', rel: 'src/api/index.ts', file: file('src/api/index.ts', 'export class Api {}\nconst a = 1;'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.scope, 'l1');
  assert.equal(res.data.body, 'export class Api {}\nconst a = 1;');
});

test('main/preload expose a rootless generation-scoped readAstPreview endpoint', () => {
  // readAstPreview lives in main/ipc/ast.ipc.mjs and is the last handler there.
  const main = readFileSync(new URL('../main/ipc/ast.ipc.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('project:readAstPreview'");
  const end = main.length;
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /input\.generation !== session\.generation/);
  assert.match(handler, /anchor\.componentId !== projectNodeId/);
  assert.match(handler, /refsForAstAnchor\(anchor, scope\)/);
  assert.match(handler, /refs\.includes\(rel\)/);
  assert.match(handler, /readProjectFile\(r\.root, rel/);
  assert.match(handler, /readThrough/);
  assert.match(handler, /end\.data\.fingerprint !== start\.data\.fingerprint/);
  assert.match(handler, /buildAnchoredReadPreview\(/);
  assert.doesNotMatch(handler, /input\.root|input\.path/);
  assert.match(preload, /readAstPreview: \(input\) => ipcRenderer\.invoke\('project:readAstPreview'/);
});

test('AST listing editor is snapshot-gated, anchor-scoped and rootless', () => {
  // The single project write path got its own module for audit: main/ipc/editor.ipc.mjs.
  const main = readFileSync(new URL('../main/ipc/editor.ipc.mjs', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/ast-view/ast-view.mjs', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('project:writeAstFile'");
  const end = main.length;
  const handler = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /input\.generation !== session\.generation/);
  assert.match(handler, /refsForAstAnchor\(anchor, scope\)\.includes\(rel\)/);
  assert.match(handler, /input\.expectedSnapshot !== before\.data\.fingerprint/);
  assert.match(handler, /writeProjectTextFile\(r\.root, rel/);
  assert.doesNotMatch(handler, /input\.root|input\.path/);
  assert.match(preload, /writeAstFile: \(input\) => ipcRenderer\.invoke\('project:writeAstFile'/);
  assert.match(view, /Редактировать/);
  assert.match(view, /writeAstFile/);
});
