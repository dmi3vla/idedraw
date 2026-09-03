// IMPORTANT — this is a deliberately labeled stub, not a real model call.
// A real implementation streams from Anthropic's Messages API with the
// `tools` array built from bridge.list_commands()/query, parses
// input_json_delta tool_use blocks, and sends tool_result back next turn
// (as specced in phase 2/3 of the wider plan). Wiring that up needs a
// real API key and network access this prototype build doesn't assume.
//
// What IS real below: the tiny intent parser genuinely calls
// `bridge.use_command` / `bridge.query` and the results genuinely flow
// back through the real command registry into the real Excalidraw canvas.
// Only the "which command to call" decision is faked (pattern match
// instead of a model), so the rest of the pipeline can be verified
// end-to-end without a live API dependency.

import { bridge } from '../bridge/bridge.mjs';

function parseIntent(text) {
  const t = text.trim().toLowerCase();

  const addMatch = t.match(/нарисуй|создай|add/);
  if (addMatch) {
    const letters = [...text.matchAll(/\b([A-ZА-Я])\b/g)].map((m) => m[1]);
    const ids = letters.length ? letters : ['A', 'B', 'C'];
    return {
      toolName: 'canvas.addNodes',
      input: { nodes: ids.map((id, i) => ({ id, label: id, x: 100 + i * 240, y: 120 })) },
      summary: `Создаю узлы: ${ids.join(', ')}`,
    };
  }

  if (t.includes('связ') || t.includes('стрелк') || t.includes('edge')) {
    const letters = [...text.matchAll(/\b([A-ZА-Я])\b/g)].map((m) => m[1]);
    if (letters.length >= 2) {
      return {
        toolName: 'canvas.addEdge',
        input: { fromId: letters[0], toId: letters[1] },
        summary: `Соединяю ${letters[0]} → ${letters[1]}`,
      };
    }
  }

  if (t.includes('выделен') || t.includes('что на холсте') || t.includes('selection')) {
    return { toolName: 'query:canvas.selection', input: {}, summary: 'Проверяю текущее выделение' };
  }

  if (t.includes('проект') || t.includes('project')) {
    return { toolName: 'query:project.graph', input: {}, summary: 'Смотрю граф проекта' };
  }

  if (t.includes('увяж') || t.includes('link')) {
    return { toolName: 'canvas.linkProject', input: { canvasId: 'demo-canvas' }, summary: 'Связываю холст с проектом' };
  }

  if (t.includes('отвяж') || t.includes('unlink')) {
    return { toolName: 'canvas.unlinkProject', input: {}, summary: 'Отвязываю холст от проекта' };
  }

  return null;
}

export async function sendMessage(text) {
  const intent = parseIntent(text);
  if (!intent) {
    return { text: 'Не нашёл подходящей команды-заглушки для этого — это упрощённый парсер интентов, не модель. См. llm-client.mjs.', toolCall: null };
  }

  const isQuery = intent.toolName.startsWith('query:');
  const result = isQuery
    ? bridge.query({ what: intent.toolName.slice('query:'.length), ...intent.input })
    : bridge.use_command(intent.toolName, intent.input);

  return {
    text: result.ok
      ? `${intent.summary}. Готово.`
      : `${intent.summary}. Ошибка: ${result.error.code} — ${result.error.message}`,
    toolCall: { name: intent.toolName, input: intent.input, result },
  };
}
