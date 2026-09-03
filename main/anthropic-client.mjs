// Minimal Anthropic Messages API client (plan stream C4).
//
// Deliberately MINIMAL: this file contains only what Stream C needs — a
// single non-streaming request used by the settings form's "check connection"
// button. It is NOT the full streaming client (SSE parsing, tools array from
// bridge.list_commands(), tool_result round-trip) — that is Stream A3 and is
// not faked here. Runs in the MAIN process (Node fetch), so no CORS applies.

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Minimal connectivity/credential test: short request to the configured
 * endpoint. Never throws — always returns a plain result object so the
 * renderer can display it directly.
 */
export async function sendTestRequest({ endpoint, apiKey, model, timeoutMs = 20000 }) {
  if (!apiKey) return { ok: false, status: 0, error: 'No API key provided or stored' };
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    return { ok: false, status: 0, error: 'Endpoint must be an https:// URL' };
  }
  if (!model) return { ok: false, status: 0, error: 'No model specified' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        // The API rejects tiny values on current models ("max_tokens must be
        // greater than 2"), so the probe spends a few tokens — still negligible.
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: shorten(extractError(body) || `HTTP ${res.status}`) };
    }
    await res.json().catch(() => null);
    return { ok: true };
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? `No response within ${timeoutMs}ms`
        : String((e && e.message) || e);
    return { ok: false, status: 0, error: shorten(msg) };
  } finally {
    clearTimeout(timer);
  }
}

function extractError(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && parsed.error && parsed.error.message;
  } catch {
    return null;
  }
}

function shorten(s, max = 300) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
