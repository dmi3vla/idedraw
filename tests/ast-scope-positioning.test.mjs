// Сквозное позиционирование чат ⇄ AST-фрейм: чистые модули, без Electron и DOM.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setAstScope, clearAstScope, getAstScope, normalizeScope, activeThreadId,
  threadIdForTab, onAstScopeChange, requestAstFocus, onAstFocusRequest,
  registerAstFrameHost, getAstFrameHost, MAIN_THREAD_ID, SCOPE_MAX_LINES,
} from '../src/bridge/ast-scope-store.mjs';
import {
  applyProposedEdit, describeEdit, selectionToLineRange, FULL_REWRITE_MAX_LINES,
} from '../src/ast-view/ast-edit-patch.mjs';
import {
  resolveAllowedCommands, intersectToolsWithAllowlist,
} from '../main/agent-allowlist.mjs';

test('scope хранит только границы: тело файла в него не попадает', () => {
  const scope = normalizeScope({
    tabId: 'canvas-adapter', rel: 'src/canvas/adapter.mjs', startLine: 120, endLine: 40,
    totalLines: 1006, body: 'export function mountCanvas() {}', content: 'секрет',
  });
  assert.equal(scope.rel, 'src/canvas/adapter.mjs');
  assert.equal(scope.startLine, 120);
  // endLine < startLine выправляется, а не роняет фрейм
  assert.equal(scope.endLine, 120);
  assert.equal(scope.body, undefined);
  assert.equal(scope.content, undefined);
  assert.equal(SCOPE_MAX_LINES, 200);
});

test('один чат — несколько историй: threadId = ast:<tabId>', () => {
  assert.equal(threadIdForTab('canvas-adapter'), 'ast:canvas-adapter');
  assert.equal(threadIdForTab(null), MAIN_THREAD_ID);
  assert.equal(activeThreadId(), MAIN_THREAD_ID);
  setAstScope({ tabId: 'mount', rel: 'src/canvas/mount.jsx' });
  assert.equal(activeThreadId(), 'ast:mount');
  clearAstScope();
  assert.equal(activeThreadId(), MAIN_THREAD_ID);
});

test('getAstScope отдаёт копию: чат не может испортить состояние моста', () => {
  setAstScope({ tabId: 'mount', rel: 'src/canvas/mount.jsx', startLine: 10, endLine: 20 });
  const first = getAstScope();
  first.rel = 'подменили';
  assert.equal(getAstScope().rel, 'src/canvas/mount.jsx');
  clearAstScope();
  assert.equal(getAstScope(), null);
});

test('оператор → агент: подписчик чата получает scope и его сброс', () => {
  const seen = [];
  const off = onAstScopeChange((scope) => seen.push(scope ? scope.rel : null));
  setAstScope({ tabId: 'mount', rel: 'src/canvas/mount.jsx' });
  clearAstScope();
  off();
  setAstScope({ tabId: 'mount', rel: 'src/canvas/mount.jsx' });
  clearAstScope();
  assert.deepEqual(seen, ['src/canvas/mount.jsx', null]);
});

test('агент → оператор: без смонтированного фрейма доставки нет', () => {
  assert.equal(requestAstFocus({ rel: 'src/canvas/mount.jsx' }).delivered, 0);
  const off = onAstFocusRequest(() => {});
  assert.equal(requestAstFocus({ rel: 'src/canvas/mount.jsx', startLine: 42 }).delivered, 1);
  off();
});

test('фрейм, который отказался позиционироваться, не засчитывается как доставка', () => {
  const off = onAstFocusRequest(() => { throw new Error('файл не открыт'); });
  const res = requestAstFocus({ rel: 'src/nope.mjs' });
  off();
  assert.equal(res.delivered, 0);
});

test('registerAstFrameHost возвращает отписку', () => {
  const host = { listFrames: () => [] };
  const off = registerAstFrameHost(host);
  assert.equal(getAstFrameHost(), host);
  off();
  assert.equal(getAstFrameHost(), null);
});

test('патч агента применяется только по уникальному якорю', () => {
  const src = 'const a = 1;\nconst b = 2;\n';
  const okRes = applyProposedEdit(src, { oldStr: 'const b = 2;', newStr: 'const b = 3;' });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.mode, 'patch');
  assert.equal(okRes.value, 'const a = 1;\nconst b = 3;\n');

  assert.equal(applyProposedEdit(src, { oldStr: 'const c = 9;', newStr: '' }).error.code, 'ANCHOR_NOT_FOUND');
  assert.equal(
    applyProposedEdit('x;\nx;\n', { oldStr: 'x;', newStr: 'y;' }).error.code,
    'ANCHOR_NOT_UNIQUE',
  );
  assert.equal(applyProposedEdit(src, {}).error.code, 'BAD_INPUT');
});

test('целиком переписывать разрешено только небольшие файлы', () => {
  const small = 'a\nb\nc';
  assert.equal(applyProposedEdit(small, { content: 'z' }).mode, 'full');
  const big = Array.from({ length: FULL_REWRITE_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(applyProposedEdit(big, { content: 'z' }).error.code, 'FULL_REWRITE_TOO_LARGE');
});

test('describeEdit показывает дельту строк', () => {
  assert.equal(describeEdit('a\nb', 'a\nb'), 'строк: 2');
  assert.equal(describeEdit('a\nb', 'a\nb\nc'), 'строк: 3 (+1)');
  assert.equal(describeEdit('a\nb\nc', 'a'), 'строк: 1 (-2)');
});

test('выделение в редакторе превращается в номера строк файла', () => {
  const text = 'один\nдва\nтри\nчетыре';
  const range = selectionToLineRange(text, text.indexOf('два'), text.indexOf('три') + 3, 100);
  assert.deepEqual(range, { startLine: 101, endLine: 102 });
  assert.equal(selectionToLineRange(text, 5, 5, 1), null);
});

test('astFrame.* доступны агенту только при подключённом проекте', () => {
  const sketch = resolveAllowedCommands({ projectLinked: false });
  for (const name of ['astFrame.getScope', 'astFrame.readScope', 'astFrame.revealAt', 'astFrame.proposeEdit']) {
    assert.equal(sketch.has(name), false, `${name} не должен быть доступен без проекта`);
  }
  const linked = resolveAllowedCommands({ projectLinked: true });
  for (const name of ['astFrame.getScope', 'astFrame.readScope', 'astFrame.revealAt', 'astFrame.proposeEdit']) {
    assert.equal(linked.has(name), true);
  }
  // Запись на диск по-прежнему НЕ инструмент агента.
  assert.equal(linked.has('project.writeFile'), false);
  assert.equal(linked.has('astFrame.saveFile'), false);

  const tools = intersectToolsWithAllowlist(
    [{ name: 'astFrame.proposeEdit' }, { name: 'astFrame.saveFile' }],
    linked,
  );
  assert.deepEqual(tools.map((t) => t.name), ['astFrame.proposeEdit']);
});
