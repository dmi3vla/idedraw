import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createState, openTab, activateTab, closeTab, setScope, clearTabs, tabById, SCOPES } from '../src/ast-view/ast-view-state.mjs';

test('opening a component creates a tab and activates it', () => {
  const s = createState();
  const tab = openTab(s, 'web');
  assert.equal(tab.id, 'web');
  assert.equal(s.activeId, 'web');
  assert.equal(tab.activeScope, 'own');
});

test('reopening the same component dedupes and reactivates instead of duplicating', () => {
  const s = createState();
  openTab(s, 'web');
  openTab(s, 'api');
  openTab(s, 'db');
  assert.equal(s.tabs.length, 3);
  const again = openTab(s, 'web');
  assert.equal(s.tabs.length, 3, 'no duplicate');
  assert.equal(s.activeId, 'web');
  assert.equal(again.id, 'web');
});



test('each tab retains its own AST anchor context when switching components', () => {
  const s = createState();
  const web = openTab(s, 'web', { astAnchor: { componentId: 'web' }, snapshot: 's1' });
  const api = openTab(s, 'api', { astAnchor: { componentId: 'api' }, snapshot: 's1' });
  assert.equal(web.context.astAnchor.componentId, 'web');
  assert.equal(api.context.astAnchor.componentId, 'api');
  activateTab(s, 'web');
  assert.equal(tabById(s, 'web').context.astAnchor.componentId, 'web');
  openTab(s, 'web', { astAnchor: { componentId: 'web' }, snapshot: 's2' });
  assert.equal(tabById(s, 'web').context.snapshot, 's2', 'reopen refreshes only that tab context');
  assert.equal(tabById(s, 'api').context.snapshot, 's1');
});

test('tab count is clamped so a large projection cannot blow up the DOM', () => {
  const s = createState();
  for (let i = 0; i < 12; i++) openTab(s, `c${i}`);
  assert.ok(s.tabs.length <= 8, `clamped to <= 8, got ${s.tabs.length}`);
});

test('closeTab removes the tab and moves the active id to a neighbour', () => {
  const s = createState();
  openTab(s, 'web');
  openTab(s, 'api');
  assert.equal(s.activeId, 'api');
  closeTab(s, 'api');
  assert.equal(s.tabs.map((t) => t.id).includes('api'), false);
  assert.equal(s.activeId, 'web');
});

test('setScope changes only the targeted tab and only for valid scopes', () => {
  const s = createState();
  openTab(s, 'web');
  openTab(s, 'api');
  setScope(s, 'web', 'l2');
  assert.equal(s.tabs.find((t) => t.id === 'web').activeScope, 'l2');
  assert.equal(s.tabs.find((t) => t.id === 'api').activeScope, 'own', 'other tab untouched');
  setScope(s, 'web', 'bogus');
  assert.equal(s.tabs.find((t) => t.id === 'web').activeScope, 'l2', 'invalid scope ignored');
});

test('clearTabs drops every tab and context (project boundary)', () => {
  const s = createState();
  openTab(s, 'web');
  s.generation = 'g1';
  clearTabs(s);
  assert.equal(s.tabs.length, 0);
  assert.equal(s.activeId, null);
  assert.equal(s.generation, null);
});

test('SCOPES exposes exactly own/l1/l2', () => {
  assert.deepEqual(SCOPES, ['own', 'l1', 'l2']);
});

test('mount.jsx wires a context-menu capture that opens the AST for Archify components', () => {
  const mount = readFileSync(new URL('../src/canvas/mount.jsx', import.meta.url), 'utf8');
  assert.match(mount, /onContextMenuCapture/);
  assert.ok(mount.indexOf('onContextMenuCapture') < mount.indexOf('<Excalidraw'), 'context capture lives on the wrapper, because Excalidraw does not forward it');
  assert.match(mount, /hitTestArchifyComponentAt/);
  assert.match(mount, /canvas:node-context/);
  assert.match(mount, /onPointerUpCapture/);
  assert.match(mount, /Math\.hypot/);
  assert.match(mount, /Развернуть AST/);
  assert.match(mount, /role="menuitem"/);
  assert.match(mount, /astAnchor/);
  // The native Excalidraw menu must still fire for non-Archify right-clicks.
  assert.match(mount, /stopPropagation\(\)/);
});

test('adapter exposes an anchor hit-test helper and does no project re-scan', () => {
  const adapter = readFileSync(new URL('../src/canvas/adapter.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /viewportCoordsToSceneCoords/);
  assert.match(adapter, /export function hitTestArchifyComponentAt/);
  assert.match(adapter, /isArchifyComponent/);
  assert.match(adapter, /projectNodeId/);
  assert.match(adapter, /Evidence-backed fallback/);
  assert.doesNotMatch(adapter, /return !!\(el && el\.customData\?\.archify\?\.astAnchor/);
  // Never returns raw file content or a root.
  assert.match(adapter, /astAnchor/);
});

test('renderer-entry mounts the AST dock and resets it on project boundaries', () => {
  const entry = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
  assert.match(entry, /mountAstView/);
  assert.match(entry, /ast-root/);
  assert.match(entry, /__astView__/);
  assert.match(entry, /project:boundary/);
  assert.match(html, /id="ast-root"/);
  assert.match(html, /ast-view\/ast-view\.css/);
  const view = readFileSync(new URL('../src/ast-view/ast-view.mjs', import.meta.url), 'utf8');
  assert.match(view, /PREVIEW_MAX_LINES - data\.returnedLines/);
  assert.match(view, /data\.body \+=/);
  assert.match(view, /refreshStaleTab/);
  assert.match(view, /ast-resizer/);
  assert.match(view, /aria-modal/);
  assert.match(view, /ast-canvas-stage/);
  assert.match(view, /ast-canvas-edge/);
  assert.match(view, /ast-listing-card/);
  assert.match(view, /loadListingCollection/);
  assert.match(view, /AST рабочая область/);
  assert.match(view, /event\.key === 'Escape'/);
  assert.match(view, /нет AST-привязки/);
  const css = readFileSync(new URL('../src/chat/chat.css', import.meta.url), 'utf8');
  assert.match(css, /#ast-root \{[\s\S]*position: fixed/);
  assert.match(css, /inset: 0/);
  assert.doesNotMatch(css, /#ast-root \{[\s\S]{0,250}flex: 0 0 300px/);
});

test('AST palette aliases the main canvas theme and has no independent theme state', () => {
  const chrome = readFileSync(new URL('../src/chat/chat.css', import.meta.url), 'utf8');
  const astCss = readFileSync(new URL('../src/ast-view/ast-view.css', import.meta.url), 'utf8');
  const renderer = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');
  assert.match(chrome, /--ast-bg:\s*var\(--bg\)/);
  assert.match(chrome, /--ast-fg:\s*var\(--fg\)/);
  assert.match(chrome, /--ast-muted:\s*var\(--fg-muted\)/);
  assert.match(chrome, /--ast-border:\s*var\(--border\)/);
  assert.match(chrome, /--ast-accent:\s*var\(--accent\)/);
  assert.match(chrome, /data-theme='light'.*#ast-root/);
  assert.match(chrome, /data-theme='dark'.*#ast-root/);
  // Единственное исключение из «никакого своего состояния темы»: контекстное
  // меню с кнопкой «Развернуть AST» рендерится в canvas-root, ВНЕ #ast-root,
  // поэтому не видит алиасы --ast-* и получает текущую тему явным атрибутом.
  const themeAttrLines = astCss.split('\n').filter((line) => /data-theme\s*=/.test(line));
  assert.equal(themeAttrLines.length, 1, 'тема в ast-view.css допустима только для .ast-context-menu');
  assert.match(themeAttrLines[0], /\.ast-context-menu\[data-theme='dark'\]/);
  const mount = readFileSync(new URL('../src/canvas/mount.jsx', import.meta.url), 'utf8');
  assert.match(mount, /data-theme=\{theme\}/);
  assert.match(mount, /theme--dark/);
  assert.match(renderer, /onThemeChange\(\(t\)\s*=>\s*applyThemeVars\(document\.documentElement, t\)\)/);
  // Оболочка наследует стиль Excalidraw и его же переключатель темы.
  assert.match(renderer, /applyExcalidrawSkin/);
  assert.match(renderer, /classList\.toggle\('theme--dark'/);
  // РЕГРЕССИЯ: класс `excalidraw` — это КОРЕНЬ приложения Excalidraw
  // (height: 100% + свои flex-правила). На #toolbar он растягивал кнопки
  // Theme / Link project / Archify во всю высоту окна. Разрешён только
  // собственный класс-скин, который объявляет одни лишь токены.
  assert.match(renderer, /classList\.add\('excalidraw-skin'\)/);
  assert.doesNotMatch(renderer, /classList\.add\('excalidraw'\)/);
  assert.doesNotMatch(mount, /ast-context-menu excalidraw\$\{/);
  assert.match(mount, /ast-context-menu excalidraw-skin/);
  // Тулбар задаёт раскладку сам, иначе унаследованные правила снова растянут кнопки.
  assert.match(astCss, /#toolbar\.excalidraw-skin button[\s\S]*?height:\s*32px/);
  assert.match(astCss, /\.ast-context-menu\.excalidraw-skin[\s\S]*?height:\s*auto/);
  assert.match(astCss, /--island-bg-color/);
});

test('preload exposes readAstPreview alongside expandAstAnchor', () => {
  const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /expandAstAnchor/);
  assert.match(preload, /readAstPreview/);
  assert.match(preload, /writeAstFile/);
});
