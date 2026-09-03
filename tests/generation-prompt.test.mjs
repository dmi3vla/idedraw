// Тесты рефакторинга R5: запрос генерации, авторемонт candidate и сжатие истории.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArchifyGenerationPrompt,
  buildRepairNudge,
  summarizeDiagnostics,
  LAYOUT_LIMITS,
} from '../main/archify-generation-prompt.mjs';
import { autofixCandidate } from '../main/archify-autofix.mjs';
import { compactConversation, conversationBytes } from '../main/conv-compact.mjs';

// Диагностики взяты дословно из живого лога (round 6 и round 7).
const LIVE_FAILURE = {
  ok: false,
  error: {
    code: 'VALIDATION',
    message: 'Architecture layout validation failed:\n- Label "project.*" overlaps component "command_engine" — adjust labelDx/labelDy/labelSegment or set labelAt.\n  label rect: [593, 324, 53, 14]\n  component "command_engine" rect: [540, 280, 160, 64]\n  Suggested fix: labelAt [620, 358] or labelDy +24 (below); or labelAt [620, 276] or labelDy -58 (above)',
  },
  diagnostics: [
    {
      code: 'composition/label-route-clearance',
      severity: 'error',
      message: 'showcase architecture label "мутации" on connections[4] id "mutations" is 0px from connections[3] id "ipc" (minimum 4px)',
      subject: { collection: 'connections', index: 4, id: 'mutations', from: 'command_engine', to: 'canvas_adapter' },
      supportedFixes: ['adjust labelAt, labelDx, labelDy, or labelSegment'],
    },
    {
      code: 'layout/constraint',
      severity: 'error',
      message: 'Label "project.*" overlaps component "command_engine".\n  Suggested fix: labelAt [620, 358] or labelDy +24 (below)',
      subject: { diagramType: 'architecture' },
    },
  ],
};

test('запрос генерации несёт именно те правила, на которых падала валидация', () => {
  const prompt = buildArchifyGenerationPrompt({ projectName: 'review-package', snapshot: 'fb9dc77f4f4ed87e' });
  assert.match(prompt, /review-package/);
  assert.match(prompt, /fb9dc77f4f4ed87e/);
  // правила подписей (label overlap + route clearance)
  assert.match(prompt, /labelDy/);
  assert.match(prompt, /labelSegment/);
  assert.ok(prompt.includes(String(LAYOUT_LIMITS.labelClearance)));
  assert.ok(prompt.includes(String(LAYOUT_LIMITS.maxLabelChars)));
  // бюджет инструментов против повторных getSkillFile/readFile
  assert.match(prompt, /РОВНО по одному вызову/);
  assert.ok(prompt.includes(String(LAYOUT_LIMITS.maxReadFiles)));
  // запрет на canvas.* и протокол repair
  assert.match(prompt, /canvas\.\*/);
  assert.match(prompt, /runToken/);
  assert.match(prompt, /REPAIR_BUDGET_EXHAUSTED/);
});

test('repair-подсказка цитирует конкретные диагностики, а не общие слова', () => {
  const nudge = buildRepairNudge({ attempts: 3, diagnostics: LIVE_FAILURE.diagnostics, error: LIVE_FAILURE.error });
  assert.match(nudge, /попыток: 3/);
  assert.match(nudge, /label-route-clearance/);
  assert.match(nudge, /ok:true/);
});

test('выжимка диагностик радикально короче сырого JSON', () => {
  const summary = summarizeDiagnostics(LIVE_FAILURE.diagnostics, LIVE_FAILURE.error);
  assert.ok(summary.length < JSON.stringify(LIVE_FAILURE.diagnostics).length);
  assert.match(summary, /fix:/);
  assert.equal(summary.split('\n').length, 2);
  assert.equal(summarizeDiagnostics([], { code: 'VALIDATION', message: 'x' }).includes('VALIDATION'), true);
});

test('авторемонт применяет Suggested fix без круга к модели', () => {
  const candidate = {
    components: [{ id: 'command_engine' }],
    connections: [
      { id: 'tools', from: 'command_engine', to: 'project_fs', label: 'project.*' },
      { id: 'mutations', from: 'command_engine', to: 'canvas_adapter', label: 'мутации' },
    ],
    meta: { views: [{ note: 'x'.repeat(200) }] },
  };
  const { candidate: fixed, applied, changed } = autofixCandidate(candidate, LIVE_FAILURE);
  assert.equal(changed, true);
  assert.deepEqual(fixed.connections[0].labelAt, [620, 358]);
  assert.equal(fixed.connections[1].labelDy, LAYOUT_LIMITS.labelOffset);
  assert.ok(fixed.meta.views[0].note.length <= LAYOUT_LIMITS.maxNoteChars);
  assert.ok(applied.length >= 3);
  // вход не мутирован
  assert.equal(candidate.connections[0].labelAt, undefined);
  assert.equal(candidate.meta.views[0].note.length, 200);
});

test('авторемонт безопасен на пустых входах', () => {
  assert.equal(autofixCandidate(null, {}).changed, false);
  assert.equal(autofixCandidate({ connections: [] }, {}).changed, false);
});

test('сжатие истории урезает только старые tool_result и не ломает парность', () => {
  const conv = [{ role: 'user', content: 'сгенерируй' }];
  for (let i = 0; i < 8; i++) {
    conv.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'project.readFile', input: { rel: `f${i}.mjs` } }] });
    conv.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(30000) }] });
  }
  const before = conversationBytes(conv);
  const { messages, trimmed, savedChars } = compactConversation(conv);

  assert.equal(trimmed, 4); // 8 результатов, последние 4 остаются целыми
  assert.ok(savedChars > 100000);
  assert.ok(conversationBytes(messages) < before * 0.55);

  // структура сохранена: тот же порядок и те же tool_use_id
  assert.equal(messages.length, conv.length);
  const ids = (list) => list.flatMap((m) => (Array.isArray(m.content) ? m.content.map((b) => b.tool_use_id || b.id) : []));
  assert.deepEqual(ids(messages), ids(conv));
  // исходная история не тронута (walkToolCalls видит всё)
  assert.equal(conversationBytes(conv), before);
  // свежие результаты нетронуты
  assert.equal(messages[messages.length - 1].content[0].content.length, 30000);
});
