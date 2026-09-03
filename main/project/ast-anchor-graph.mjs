import path from 'node:path';
import { refsForAstAnchor } from './ast-anchor-manifest.mjs';
import { parseAstFile } from './ast-adapters.mjs';

function extractSpecifiers(content) {
  const out = []; const re = /(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g; let match;
  while ((match = re.exec(String(content || '')))) out.push(match[1]);
  return [...new Set(out)].sort();
}
function resolveSelected(importer, spec, selected) {
  if (!spec?.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
  const noExt = base.replace(/\.[^/.]+$/, '');
  const exts = ['.js','.mjs','.cjs','.ts','.tsx','.jsx','.php','.phtml'];
  const candidates = [base, noExt, ...exts.map((ext) => noExt + ext), ...exts.map((ext) => noExt + '/index' + ext)];
  return candidates.find((rel) => selected.has(rel)) || null;
}

/** Main-only adapter seam. It receives only files selected by the bounded anchor,
 * never walks a root, and drops file content before crossing IPC. */
export function buildAnchoredAstGraph({ anchor, scope = 'own', files = [], snapshot = null } = {}) {
  const requestedRefs = refsForAstAnchor(anchor, scope); const allowed = new Set(requestedRefs);
  const byRel = new Map((files || []).filter((file) => allowed.has(file.rel)).map((file) => [file.rel, file]));
  const nodes = [...byRel.values()].sort((a,b) => a.rel.localeCompare(b.rel)).map((file) => {
    const parsed = parseAstFile({ rel: file.rel, content: file.content });
    return { id: `file:${file.rel}`, rel: file.rel, lines: file.lines, truncated: !!file.truncated,
      adapter: parsed.adapter, language: parsed.language, supported: parsed.supported, symbols: parsed.symbols };
  });
  const edges = []; const seen = new Set();
  for (const file of byRel.values()) for (const spec of extractSpecifiers(file.content)) {
    const target = resolveSelected(file.rel, spec, allowed); if (!target || !byRel.has(target)) continue;
    const id = `${file.rel}->${target}`; if (seen.has(id)) continue; seen.add(id);
    edges.push({ id, source: `file:${file.rel}`, target: `file:${target}` });
  }
  edges.sort((a,b) => a.id.localeCompare(b.id));
  const unsupportedFiles = nodes.filter((node) => !node.supported).map((node) => node.rel);
  return { version: 2, componentId: anchor?.componentId || null, scope: ['own','l1','l2'].includes(scope) ? scope : 'own', snapshot,
    requestedFileCount: requestedRefs.length, files: nodes, edges,
    partial: nodes.length < requestedRefs.length || nodes.some((node) => node.truncated),
    unsupported: unsupportedFiles.length > 0, unsupportedFiles };
}
