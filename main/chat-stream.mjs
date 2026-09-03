// Real chat streaming clients for chat (plan stream A).
//
// Runs in the MAIN process (Node fetch, so no CORS and the API key never
// crosses into the renderer). It only speaks to the HTTP API and parses the
// SSE byte stream — it does NOT execute tools. Tool execution is delegated
// back to the renderer (which owns the canvas/bridge/Excalidraw), so this
// module purposefully never imports any renderer-side code.
//
// Returns, per turn: { stopReason, text, toolUses } where toolUses is a list
// of { id, name, input } already reassembled from the streamed JSON fragments.
//
// Two wire formats are supported and auto-selected by the caller:
//  - Anthropic Messages API  (/v1/messages, x-api-key, content_block deltas)
//  - OpenAI-compatible chat/completions (/v1/chat/completions, Bearer, tool_calls)

const ANTHROPIC_VERSION = '2023-06-01';

// Formation/stream trace. `[CHAT-STREAM]` prefix is separate from the main
// `[ARCHIFY-GEN]` logs so the request/response and error surface is easy to grep.
const sTag = '[CHAT-STREAM]';
const sLog = (...parts) => console.log(sTag, ...parts);
const sErr = (...parts) => console.error(sTag, ...parts);

// --- OpenAI-compatible helpers ----------------------------------------------
// Our internal conversation uses Anthropic-style message blocks. OpenAI's
// chat/completions expects plain messages with `tool_calls` / `tool` roles, so
// we convert on the way out and read them back on the way in.
export function toOpenAIMessage(m, originalToWire = new Map()) {
  const content = m.content;
  if (m.role === 'user') {
    if (typeof content === 'string') return { role: 'user', content };
    // Anthropic-style user message carrying one or MORE tool_result blocks.
    // OpenAI requires ONE `tool` message PER tool_call_id; flattening them into
    // a single message (or passing an array of objects) makes strict gateways
    // reject with HTTP 400. Emit one { role:'tool' } object per result.
    if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
      return content
        .filter((b) => b && b.type === 'tool_result')
        .map((b) => ({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
        }));
    }
    return { role: 'user', content: typeof content === 'string' ? content : '' };
  }
  if (m.role === 'assistant') {
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content || '' }];
    let text = '';
    const toolCalls = [];
    for (const b of blocks) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: originalToWire.get(b.name) || toOpenAIWireName(b.name), arguments: JSON.stringify(b.input || {}) },
        });
      }
    }
    return { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  }
  return { role: m.role, content: typeof content === 'string' ? content : '' };
}

function fromOpenAIToolCalls(acc) {
  return Object.values(acc).map((tc) => {
    let input = {};
    const trimmed = (tc.args || '').trim();
    try { if (trimmed) input = JSON.parse(trimmed); } catch { input = { __parseError: trimmed }; }
    return { id: tc.id, name: tc.name, input };
  });
}

// OpenAI-compatible gateways enforce `^[a-zA-Z0-9_-]+$` on `tools[].function.name`
// (e.g. api.b.ai). Our internal tool names are Anthropic-style dotted namespaces
// (`project.getStatus`, `archify.author`), which such gateways reject with HTTP 400.
// To stay compatible we send a sanitized name (dot -> underscore) and map every
// incoming `tool_use` name back to its original via `nameMap`. The executor always
// sees the original dotted name, never the wire form.
export function toOpenAIWireName(name, index = 0) {
  const readable = String(name || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_');
  return (`tool_${index}_${readable}`).slice(0, 64);
}

export function buildOpenAINameMaps(tools = []) {
  const wireToOriginal = new Map();
  const originalToWire = new Map();
  tools.forEach((tool, index) => {
    const original = String(tool && tool.name || '');
    const wire = toOpenAIWireName(original, index);
    wireToOriginal.set(wire, original);
    originalToWire.set(original, wire);
  });
  return { wireToOriginal, originalToWire };
}

async function streamOpenAI({
  endpoint, apiKey, model, maxTokens, messages, system, tools, onText, signal,
}) {
  const oaMessages = [];
  // Build maps BEFORE converting history: strict gateways validate not only the
  // tools declaration but also assistant.tool_calls[].function.name on later rounds.
  const { wireToOriginal: nameMap, originalToWire } = buildOpenAINameMaps(tools || []);
  if (system) oaMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    const converted = toOpenAIMessage(m, originalToWire);
    // A user message with multiple tool_result blocks expands to multiple
    // OpenAI `tool` messages (one per tool_call_id); others are a single message.
    if (Array.isArray(converted)) oaMessages.push(...converted);
    else oaMessages.push(converted);
  }
  // Build a reversible wire-name map so incoming tool_use names resolve back to
  // the original dotted command name.
  const oaTools = (tools || []).map((t) => {
    const original = t.name;
    const wire = originalToWire.get(original);
    return { type: 'function', function: { name: wire, description: t.description, parameters: t.input_schema } };
  });

  const body = JSON.stringify({
    model,
    messages: oaMessages,
    ...(oaTools.length ? { tools: oaTools, tool_choice: 'auto' } : {}),
    stream: true,
    max_tokens: maxTokens,
  });
  sLog('openai POST', JSON.stringify({ endpoint, model, key: apiKey ? 'set' : 'missing', bytes: Buffer.byteLength(body, 'utf8'), tools: oaTools.length, messages: oaMessages.length }));
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'text/event-stream',
      },
      body,
    });
  } catch (netErr) {
    const msg = String(netErr && netErr.message ? netErr.message : netErr);
    if (signal && signal.aborted) throw Object.assign(new Error('Request aborted.'), { code: 'CANCELLED', name: 'AbortError' });
    sErr('openai NETWORK_FAIL', msg);
    throw Object.assign(new Error(`Network error reaching ${endpoint}: ${msg}`), { code: 'NETWORK', message: msg });
  }
  sLog('openai ответ status=' + res.status);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try { const j = JSON.parse(errBody); if (j && j.error && j.error.message) msg = j.error.message; } catch {}
    sErr('openai HTTP_FAIL', res.status, JSON.stringify(msg), 'body=' + errBody.slice(0, 400));
    throw Object.assign(new Error(msg), { code: 'HTTP_' + res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let toolAcc = {}; // index -> { id, name, args }
  let hasTools = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseSSEEvent(raw);
      if (!ev) continue;
      const d = ev.data;
      if (d === '[DONE]') { buffer = ''; break; }
      const delta = d.choices && d.choices[0] && d.choices[0].delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') { text += delta.content; if (onText) onText(delta.content); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          if (!toolAcc[i]) toolAcc[i] = { id: undefined, name: undefined, args: '' };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function && tc.function.name) toolAcc[i].name = nameMap.get(tc.function.name) || tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') toolAcc[i].args += tc.function.arguments;
          hasTools = true;
        }
      }
      if (d.choices && d.choices[0] && d.choices[0].finish_reason === 'tool_calls') hasTools = true;
    }
  }

  const toolUses = hasTools ? fromOpenAIToolCalls(toolAcc) : [];
  sLog('openai DONE', JSON.stringify({ stopReason: toolUses.length ? 'tool_use' : 'end_turn', textLen: text.length, toolUses: toolUses.map((t) => t.name) }));
  return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text, toolUses };
}

export async function streamAnthropic({
  endpoint, apiKey, model, maxTokens, messages, system, tools, onText, signal,
}) {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools } : {}),
    messages,
  });
  sLog('anthropic POST', JSON.stringify({ endpoint, model, key: apiKey ? 'set' : 'missing', bytes: Buffer.byteLength(body, 'utf8'), tools: (tools || []).length, messages: messages.length }));
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'text/event-stream',
      },
      body,
    });
  } catch (netErr) {
    const msg = String(netErr && netErr.message ? netErr.message : netErr);
    if (signal && signal.aborted) throw Object.assign(new Error('Request aborted.'), { code: 'CANCELLED', name: 'AbortError' });
    sErr('anthropic NETWORK_FAIL', msg);
    throw Object.assign(new Error(`Network error reaching ${endpoint}: ${msg}`), { code: 'NETWORK', message: msg });
  }
  sLog('anthropic ответ status=' + res.status);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(errBody);
      if (j && j.error && j.error.message) msg = j.error.message;
    } catch {
      /* keep generic message */
    }
    sErr('anthropic HTTP_FAIL', res.status, JSON.stringify(msg), 'body=' + errBody.slice(0, 400));
    throw Object.assign(new Error(msg), { code: 'HTTP_' + res.status });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason = null;
  let text = '';
  let toolUses = [];
  let current = null; // active tool_use block being assembled

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const ev = parseSSEEvent(raw);
      if (!ev) continue;
      const d = ev.data;

      switch (d.type) {
        case 'content_block_start': {
          const cb = d.content_block;
          current = cb && cb.type === 'tool_use' ? { id: cb.id, name: cb.name, inputJson: '' } : { kind: 'text' };
          break;
        }
        case 'content_block_delta': {
          const delta = d.delta;
          if (delta.type === 'text_delta') {
            text += delta.text;
            if (onText) onText(delta.text);
          } else if (delta.type === 'input_json_delta') {
            if (current && current.id) current.inputJson += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          if (current && current.id) {
            let input = {};
            const trimmed = (current.inputJson || '').trim();
            try {
              if (trimmed) input = JSON.parse(trimmed);
            } catch {
              input = { __parseError: trimmed };
            }
            toolUses.push({ id: current.id, name: current.name, input });
          }
          current = null;
          break;
        }
        case 'message_delta': {
          if (d.delta && d.delta.stop_reason) stopReason = d.delta.stop_reason;
          break;
        }
        case 'error': {
          stopReason = 'error';
          if (d.error && d.error.message) text += `\n[ошибка API] ${d.error.message}`;
          break;
        }
        default:
          break;
      }
    }
  }

  if (!stopReason) stopReason = 'end_turn';
  sLog('anthropic DONE', JSON.stringify({ stopReason, textLen: text.length, toolUses: toolUses.map((t) => t.name) }));
  return { stopReason, text, toolUses };
}

// One SSE event = one or more `key: value` lines separated by blank line.
// We only care about `data:` lines; `event:` is ignored (the JSON type drives
// everything). Multiple data lines are concatenated (Anthropic never splits its
// JSON across data lines, but concatenating is harmless).
function parseSSEEvent(raw) {
  let data = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
  }
  if (!data) return null;
  try {
    return { data: JSON.parse(data) };
  } catch {
    return null;
  }
}

// Dispatcher: pick the wire format from the configured endpoint. The endpoint
// is whatever the user set in the settings window, so we must not assume
// Anthropic. OpenAI-compatible gateways use /v1/chat/completions; Anthropic
// uses /v1/messages.
function pickClient(endpoint) {
  if (/\/chat\/completions(\?|$)/.test(endpoint || '')) return streamOpenAI;
  return streamAnthropic;
}

export async function streamChat(opts) {
  const client = pickClient(opts.endpoint);
  return client(opts);
}
