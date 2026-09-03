// These readers used to be closures inside main.mjs, reachable only by booting
// electron. They are pure now, so the tool-history logic gets real unit tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { walkToolCalls, lastAuthorResult, lastAuthorFailure, lastCallResult } from '../main/agent/conversation.mjs';

const toolUse = (id, name, input = {}) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const toolResult = (id, payload) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
});

test('walkToolCalls keeps call order and pairs each result with its own call', () => {
  const conv = [
    { role: 'user', content: 'нарисуй архитектуру' }, // plain string content must not crash
    toolUse('a', 'project.listFiles', { path: '.' }),
    toolResult('a', { ok: true, data: { total: 2 } }),
    toolUse('b', 'project.readFile', { rel: 'main.mjs' }),
    toolResult('b', { ok: true, data: { content: 'x' } }),
  ];
  const calls = walkToolCalls(conv);
  assert.deepEqual(calls.map((c) => c.name), ['project.listFiles', 'project.readFile']);
  assert.equal(calls[0].input.path, '.');
  assert.match(calls[0].resultText, /"total":2/);
  assert.match(calls[1].resultText, /"content":"x"/);
});

test('a tool_use with no result yet has resultText null, not an empty string', () => {
  // The generation flow distinguishes "still running" from "returned nothing".
  const calls = walkToolCalls([toolUse('a', 'archify.author')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].resultText, null);
});

test('walkToolCalls tolerates empty, null and malformed conversations', () => {
  assert.deepEqual(walkToolCalls(null), []);
  assert.deepEqual(walkToolCalls([]), []);
  assert.deepEqual(walkToolCalls([{ role: 'assistant', content: null }]), []);
});

test('lastAuthorResult returns the LAST successful author payload, ignoring failures after it', () => {
  const conv = [
    toolUse('a1', 'archify.author'),
    toolResult('a1', { ok: true, data: { ir: { components: ['old'] } } }),
    toolUse('a2', 'archify.author'),
    toolResult('a2', { ok: true, data: { ir: { components: ['new'] } } }),
  ];
  assert.deepEqual(lastAuthorResult(conv).ir.components, ['new']);
});

test('lastAuthorResult ignores successful calls that carry no IR', () => {
  const conv = [
    toolUse('a1', 'archify.author'),
    toolResult('a1', { ok: true, data: { ir: { components: ['real'] } } }),
    toolUse('a2', 'archify.author'),
    toolResult('a2', { ok: true, data: { note: 'no ir here' } }),
  ];
  assert.deepEqual(lastAuthorResult(conv).ir.components, ['real']);
});

test('lastAuthorResult ignores other tools and returns null when there is no author call', () => {
  const conv = [toolUse('p', 'project.listFiles'), toolResult('p', { ok: true, data: { total: 1 } })];
  assert.equal(lastAuthorResult(conv), null);
});

test('lastAuthorFailure surfaces the newest failed author call so repair nudges carry real diagnostics', () => {
  const conv = [
    toolUse('a1', 'archify.author'),
    toolResult('a1', { ok: false, error: { code: 'VALIDATION', message: 'first' } }),
    toolUse('a2', 'archify.author'),
    toolResult('a2', { ok: false, error: { code: 'VALIDATION', message: 'label overlap' } }),
  ];
  const failure = lastAuthorFailure(conv);
  assert.equal(failure.ok, false);
  assert.match(JSON.stringify(failure), /label overlap/);
});

test('lastAuthorFailure is null when every author call succeeded', () => {
  const conv = [toolUse('a1', 'archify.author'), toolResult('a1', { ok: true, data: { ir: {} } })];
  assert.equal(lastAuthorFailure(conv), null);
});

test('lastCallResult selects by tool name and returns the parsed data object', () => {
  const conv = [
    toolUse('l', 'project.listFiles'),
    toolResult('l', { ok: true, data: { root: '/p', files: ['a.mjs'], total: 1, truncated: false } }),
    toolUse('r', 'project.readFile'),
    toolResult('r', { ok: true, data: { content: 'body' } }),
  ];
  assert.deepEqual(lastCallResult(conv, 'project.listFiles').files, ['a.mjs']);
  assert.equal(lastCallResult(conv, 'project.readFile').content, 'body');
  assert.equal(lastCallResult(conv, 'project.search'), null);
});

test('lastCallResult skips failed calls of the same name', () => {
  const conv = [
    toolUse('s1', 'project.search'),
    toolResult('s1', { ok: true, data: { hits: 3 } }),
    toolUse('s2', 'project.search'),
    toolResult('s2', { ok: false, error: { code: 'OUT_OF_SCOPE', message: 'nope' } }),
  ];
  assert.equal(lastCallResult(conv, 'project.search').hits, 3);
});
