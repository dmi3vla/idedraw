// Pure conversation readers, moved out of main.mjs (refactor rule 7).
// No electron, no app, no closures — so they are unit-testable.
import { parseArchifyResult } from '../archify-result.mjs';

// Walk the Anthropic-style conversation to reconstruct the ordered tool_use calls
// (name + input) AND the raw result string each one produced.
export function walkToolCalls(messages) {
  const out = [];
  const resultsByUseId = new Map();
  for (const m of messages || []) {
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        out.push({ id: block.id, name: block.name, input: block.input || {}, resultText: null });
      } else if (block && block.type === 'tool_result') {
        resultsByUseId.set(block.tool_use_id, block.content);
      }
    }
  }
  for (const c of out) {
    if (resultsByUseId.has(c.id)) c.resultText = resultsByUseId.get(c.id);
  }
  return out;
}

// Return the PARSE data object of the last successful `archify.author` call
// ({ ...runReceipt, ir, checks, layout }) or null.
// Последний НЕУДАЧНЫЙ archify.author в истории: нужен, чтобы repair-подсказка
// несла КОНКРЕТНЫЕ диагностики валидатора, а не общие слова.
export function lastAuthorFailure(conv) {
  const calls = walkToolCalls(conv).filter((c) => c.name === 'archify.author');
  for (let i = calls.length - 1; i >= 0; i--) {
    const parsed = parseArchifyResult(calls[i].resultText);
    if (parsed && parsed.ok === false) return parsed;
  }
  return null;
}

export function lastAuthorResult(messages) {
  const calls = walkToolCalls(messages);
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name !== 'archify.author' || !calls[i].resultText) continue;
    const res = parseArchifyResult(calls[i].resultText);
    if (res && res.ok && res.data && res.data.ir) return res.data;
  }
  return null;
}

// Return the parsed DATA object of the last successful tool call of a given name
// (e.g. project.listFiles -> { root, files, total, truncated }), or null. Used to
// reconstruct the discovery plan for the evidence acceptance checks.
export function lastCallResult(messages, name) {
  const calls = walkToolCalls(messages);
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name !== name || !calls[i].resultText) continue;
    const res = parseArchifyResult(calls[i].resultText);
    if (res && res.ok && res.data) return res.data;
  }
  return null;
}

