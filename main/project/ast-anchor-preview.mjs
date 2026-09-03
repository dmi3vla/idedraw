// Bounded, rootless source preview for an S6 AST anchor. This is the pure,
// deterministic core behind `project:readAstPreview`: it validates that the
// requested `rel` belongs to the selected anchor scope and slices the already-read
// file content down to a bounded window (90 lines by default, 200 after an explicit
// "Load more"), never exposing the project root or the full file.
//
// It never reads from disk itself — the caller (main.mjs) reads through the
// confined `readProjectFile` boundary and passes the resulting `file`. Keeping the
// slicing/validation pure lets it be unit-tested without Electron/fs, and keeps
// every path decision in one reviewable place.

import { refsForAstAnchor } from './ast-anchor-manifest.mjs';

export const PREVIEW_LINE_LIMITS = Object.freeze({
  defaultLines: 90,
  maxLines: 200,
  byteCap: 16 * 1024,
});

/**
 * Resolve the bounded body for `rel` in `anchor` scope. Returns either a preview
 * object or an `{ ok:false, error:{code,message} }` for a scope violation. The
 * `file` is the `readProjectFile` result shape: `{ rel, lines, truncated, content }`.
 *
 * @param {object} opts
 * @param {object} opts.anchor   the component-local S6 AST anchor
 * @param {string} opts.scope    'own' | 'l1' | 'l2'
 * @param {string} opts.rel      a project-relative path
 * @param {object|undefined} opts.file  the already-read file (or undefined)
 * @param {number} [opts.startLine] 1-based first line (default 1)
 * @param {number|null} [opts.endLine] 1-based last line (default: 90-line window)
 * @param {number} [opts.maxLines] window size (bounded by `maxLines` cap)
 */
export function buildAnchoredReadPreview({
  anchor = null,
  scope = 'own',
  rel = '',
  file = null,
  startLine = 1,
  endLine = null,
  maxLines = PREVIEW_LINE_LIMITS.defaultLines,
} = {}) {
  const allowed = new Set(refsForAstAnchor(anchor, scope));
  if (!allowed.has(rel)) {
    return { ok: false, error: { code: 'OUT_OF_SCOPE', message: 'File is not part of this anchor scope.' } };
  }
  if (!file || typeof file.content !== 'string') {
    return { ok: false, error: { code: 'NO_CONTENT', message: 'File could not be read for preview.' } };
  }

  const positiveInt = (value, fallback) => {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const lines = file.content.split(/\r?\n/);
  const reportedTotal = positiveInt(file.lines, lines.length);
  const totalLines = Math.max(reportedTotal, lines.length);
  const cap = Math.min(PREVIEW_LINE_LIMITS.maxLines, positiveInt(maxLines, PREVIEW_LINE_LIMITS.defaultLines));
  const from = positiveInt(startLine, 1);
  if (from > totalLines) {
    return { ok: false, error: { code: 'RANGE_OUT_OF_BOUNDS', message: 'Preview start line is beyond the end of the file.' } };
  }
  if (from > lines.length) {
    return { ok: false, error: { code: 'RANGE_UNAVAILABLE', message: 'Requested preview window was not loaded.' } };
  }

  const requestedEnd = positiveInt(endLine, from + cap - 1);
  const candidateEnd = Math.min(requestedEnd, from + cap - 1, lines.length);
  const selected = lines.slice(from - 1, candidateEnd);
  let body = selected.join('\n');
  let byteTruncated = false;
  if (Buffer.byteLength(body, 'utf8') > PREVIEW_LINE_LIMITS.byteCap) {
    const chars = Array.from(body);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= PREVIEW_LINE_LIMITS.byteCap) lo = mid;
      else hi = mid - 1;
    }
    body = chars.slice(0, lo).join('');
    byteTruncated = true;
  }

  const bodyLines = body.length ? body.split('\n').length : 0;
  const actualEnd = bodyLines ? from + bodyLines - 1 : from - 1;
  const out = {
    rel,
    scope: ['own', 'l1', 'l2'].includes(scope) ? scope : 'own',
    startLine: from,
    endLine: actualEnd,
    totalLines,
    returnedLines: bodyLines,
    maxLines: cap,
    byteTruncated,
    truncated: totalLines > actualEnd || !!file.truncated || byteTruncated,
    body,
  };
  // A byte-truncated line cannot be resumed safely with line-only pagination.
  // The renderer shows the bounded partial result instead of skipping the rest.
  if (!byteTruncated && totalLines > actualEnd) out.nextStartLine = actualEnd + 1;
  return { ok: true, data: out };
}
