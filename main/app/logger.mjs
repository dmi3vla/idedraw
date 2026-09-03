// Detailed, searchable formation log. Prefixes every canvas-generation trace so
// a user running `npm start` and hitting “Не удалось построить архитектуру” can
// see the exact stage, config facts (never the key), tool flow and failure reason
// in the terminal. `log` is informational; `err` always goes to stderr.

export function createLogger(tag) {
  const log = (...parts) => console.log(tag, ...parts);
  const err = (...parts) => console.error(tag, ...parts);
  return { tag, log, err, snip };
}

// Bounded, secret-free summary of a tool/IR payload for the trace: strips any
// `content`/`body` blob and truncates so a giant read/IR never floods the console.
export function snip(value, max = 160) {
  if (value === undefined || value === null) return value === null ? 'null' : 'undefined';
  if (typeof value !== 'object') return String(value).slice(0, max);
  const clone = {};
  for (const [k, v] of Object.entries(value)) {
    if (['content', 'body', 'text', 'evidenceMap', 'filesManifest', 'ir', 'source', 'document', 'candidate', 'runToken'].includes(k)) {
      const type = Array.isArray(v) ? `Array<${v.length}>` : typeof v;
      clone[k] = `[${type} omitted]`;
    } else clone[k] = v;
  }
  const json = JSON.stringify(clone);
  return json.length > max ? json.slice(0, max) + '…' : json;
}
