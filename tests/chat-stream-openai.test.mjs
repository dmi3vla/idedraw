import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAINameMaps, toOpenAIMessage, toOpenAIWireName } from '../main/chat-stream.mjs';

test('OpenAI wire tool names are strict, bounded and collision-free', () => {
  const tools = [{ name: 'project.getStatus' }, { name: 'project_getStatus' }, { name: 'archify.author' }];
  const { wireToOriginal, originalToWire } = buildOpenAINameMaps(tools);
  const wires = tools.map((t) => originalToWire.get(t.name));
  assert.equal(new Set(wires).size, tools.length);
  for (const wire of wires) {
    assert.match(wire, /^[a-zA-Z0-9_-]+$/);
    assert.ok(wire.length <= 64);
    assert.equal(wireToOriginal.get(wire), tools.find((t) => originalToWire.get(t.name) === wire).name);
  }
});

test('assistant history uses the same sanitized tool name as tools declaration', () => {
  const { originalToWire } = buildOpenAINameMaps([{ name: 'project.getStatus' }]);
  const message = toOpenAIMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'project.getStatus', input: {} }] }, originalToWire);
  assert.equal(message.tool_calls[0].function.name, originalToWire.get('project.getStatus'));
  assert.doesNotMatch(message.tool_calls[0].function.name, /\./);
});

test('each OpenAI tool_result becomes a separate tool message', () => {
  const messages = toOpenAIMessage({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'a', content: 'one' },
    { type: 'tool_result', tool_use_id: 'b', content: { ok: true } },
  ] });
  assert.deepEqual(messages, [
    { role: 'tool', tool_call_id: 'a', content: 'one' },
    { role: 'tool', tool_call_id: 'b', content: '{"ok":true}' },
  ]);
});

test('wire helper sanitizes all unsupported characters', () => {
  assert.match(toOpenAIWireName('a.b/c:d', 7), /^tool_7_[a-zA-Z0-9_-]+$/);
});
