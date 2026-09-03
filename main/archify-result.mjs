// Helpers for turning a tool_result content string back into a structured value.
// The agent runtime feeds back tool results as STRINGS (toToolContent returns a
// string), so a model that wants to inspect diagnostics/runToken must parse them.
// This is used by the deterministic scripted model (S5.2 acceptance) to decide
// whether a repair round is warranted and to recover the runToken.

/**
 * Parse a tool_result content string into a Bridge-style result object.
 *   - JSON strings ({"ok":true,"data":...}) -> parsed object
 *   - plain text -> { ok:true, data: text } (so callers can still read it)
 *   - unparseable -> { ok:false, error:{ code:'PARSE', message: content } }
 */
export function parseArchifyResult(content) {
  if (content == null) return { ok: false, error: { code: 'EMPTY', message: 'no tool result content' } };
  if (typeof content !== 'string') return content; // already an object (unit tests)
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: { code: 'EMPTY', message: 'empty tool result' } };
  try {
    const parsed = JSON.parse(trimmed);
    // A Bridge-style result: { ok, data } | { ok:false, error }
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
    // Some tools return the data JSON directly without { ok }.
    return { ok: true, data: parsed };
  } catch {
    return { ok: true, data: content };
  }
}
