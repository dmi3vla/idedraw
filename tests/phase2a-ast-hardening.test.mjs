import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createState, openTab, statusFromGraph, setTabStatus, toggleExpandedFile,
  selectSymbol, rememberScroll, setDockWidth, refreshStaleTab,
} from '../src/ast-view/ast-view-state.mjs';
import { buildAnchoredAstGraph } from '../main/project/ast-anchor-graph.mjs';

test('tab view state persists expansion, symbol and scroll independently', () => {
  const state = createState();
  const web = openTab(state, 'web', { snapshot: 'old' });
  const api = openTab(state, 'api', { snapshot: 'same' });
  toggleExpandedFile(web, 'src/web.ts'); selectSymbol(web, 'sym:web'); rememberScroll(web, 240);
  assert.deepEqual(web.expandedFiles, ['src/web.ts']);
  assert.equal(web.selectedSymbol, 'sym:web'); assert.equal(web.scrollTop, 240);
  assert.deepEqual(api.expandedFiles, []); assert.equal(api.selectedSymbol, null); assert.equal(api.scrollTop, 0);
});

test('explicit graph states prioritize stale, unsupported and partial', () => {
  assert.equal(statusFromGraph({ stale: true, unsupported: true, partial: true }), 'stale');
  assert.equal(statusFromGraph({ unsupported: true, partial: true }), 'unsupported');
  assert.equal(statusFromGraph({ partial: true }), 'partial');
  assert.equal(statusFromGraph({}), 'ready');
  const tab = openTab(createState(), 'web'); setTabStatus(tab, 'loading');
  assert.equal(tab.loading, true); assert.equal(tab.status, 'loading');
});

test('stale refresh adopts only the main-returned snapshot', () => {
  const tab = openTab(createState(), 'web', { snapshot: 'old', astAnchor: { componentId: 'web' } });
  tab.graph = { snapshot: 'current', stale: true }; setTabStatus(tab, 'stale');
  assert.equal(refreshStaleTab(tab), true);
  assert.equal(tab.context.snapshot, 'current'); assert.equal(tab.graph, null); assert.equal(tab.status, 'idle');
});

test('pinned dock width is bounded', () => {
  const state = createState(); setDockWidth(state, 10); assert.equal(state.width, 360);
  setDockWidth(state, 2000); assert.equal(state.width, 960);
});

test('fallback graph labels unsupported languages without returning source', () => {
  const anchor = { componentId: 'web', own: ['src/web.ts', 'README.md'] };
  const graph = buildAnchoredAstGraph({ anchor, files: [
    { rel: 'src/web.ts', lines: 1, content: 'export function App() {}' },
    { rel: 'README.md', lines: 1, content: 'private source' },
  ], snapshot: 'snap' });
  assert.equal(graph.unsupported, true);
  assert.deepEqual(graph.unsupportedFiles, ['README.md']);
  assert.equal(graph.files.find((file) => file.rel.endsWith('.md')).supported, false);
  assert.equal(JSON.stringify(graph).includes('private source'), false);
  assert.equal(JSON.stringify(graph).includes('content'), false);
});

test('UI wiring includes lifecycle resets, focus return, pin/resize and rotated hit-test', () => {
  const view = readFileSync(new URL('../src/ast-view/ast-view.mjs', import.meta.url), 'utf8');
  const mount = readFileSync(new URL('../src/canvas/mount.jsx', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../src/canvas/adapter.mjs', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');
  assert.match(view, /project:boundary/); assert.match(view, /canvas:cleared/);
  assert.match(view, /ast-resizer/); assert.match(view, /aria-pressed/); assert.match(view, /refreshStaleTab/);
  assert.match(mount, /returnFocus/); assert.match(mount, /canvas:cleared/);
  assert.match(adapter, /Math\.cos\(angle\)/); assert.match(adapter, /Math\.sin\(angle\)/);
  assert.match(entry, /reason: 'open'/); assert.match(entry, /reason: status\.linked \? 'unlink' : 'link'/);
});
