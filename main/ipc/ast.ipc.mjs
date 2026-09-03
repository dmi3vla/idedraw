// Read-only AST seam (project:expandAstAnchor / project:readAstPreview).
// Separate from project.ipc.mjs because these two endpoints are the ones that
// decide what source the AST frames may ever see.
import { ipcMain } from 'electron';
import { readProjectFile, getProjectSnapshot } from '../project/project-fs.mjs';
import { publicSession } from '../project/project-canvas-file.mjs';
import { refsForAstAnchor } from '../project/ast-anchor-manifest.mjs';
import { buildAnchoredAstGraph } from '../project/ast-anchor-graph.mjs';
import { buildAnchoredReadPreview, PREVIEW_LINE_LIMITS } from '../project/ast-anchor-preview.mjs';
import { requireRoot } from './require-root.mjs';

export function registerAstIpc() {
  // S6 AST anchor seam. Unlike code-canvas-review's standalone buildGraph(root),
  // this endpoint never scans a root. It reads only the bounded files already
  // attached to the clicked Archify component at projection time.
  ipcMain.handle('project:expandAstAnchor', (event, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    const session = publicSession();
    if (!input || !session.linked || input.generation !== session.generation) {
      return { ok: false, error: { code: 'STALE_PROJECT', message: 'Project changed before AST expansion.' } };
    }
    const anchor = input.astAnchor;
    const projectNodeId = typeof input.projectNodeId === 'string' ? input.projectNodeId : '';
    if (!anchor || anchor.componentId !== projectNodeId) {
      return { ok: false, error: { code: 'BAD_ANCHOR', message: 'AST anchor does not belong to this component.' } };
    }
    const scope = ['own', 'l1', 'l2'].includes(input.scope) ? input.scope : 'own';
    const start = getProjectSnapshot(r.root);
    if (!start.ok) return start;
    const refs = refsForAstAnchor(anchor, scope);
    if (!refs.length) return { ok: false, error: { code: 'EMPTY_ANCHOR', message: 'AST anchor has no files for this scope.' } };
    const files = [];
    const warnings = [];
    for (const rel of refs) {
      const read = readProjectFile(r.root, rel, { maxLines: 2000 });
      if (read.ok) files.push(read.data);
      else warnings.push(`${rel}: ${read.error.code}`);
    }
    const end = getProjectSnapshot(r.root);
    if (!end.ok || end.data.fingerprint !== start.data.fingerprint) {
      return { ok: false, error: { code: 'PROJECT_CHANGED', message: 'Project changed during AST expansion.' } };
    }
    const data = buildAnchoredAstGraph({ anchor, scope, files, snapshot: start.data.fingerprint });
    data.stale = typeof input.expectedSnapshot === 'string' && input.expectedSnapshot !== start.data.fingerprint;
    data.warnings = warnings;
    return { ok: true, data };
  });

  // Bounded, rootless source preview for one anchor-scope file (60%). It never
  // returns the project root and never leaks a file outside the anchor scope.
  ipcMain.handle('project:readAstPreview', (event, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    const session = publicSession();
    if (!input || !session.linked || input.generation !== session.generation) {
      return { ok: false, error: { code: 'STALE_PROJECT', message: 'Project changed before source preview.' } };
    }
    const anchor = input.astAnchor;
    const projectNodeId = typeof input.projectNodeId === 'string' ? input.projectNodeId : '';
    if (!anchor || anchor.componentId !== projectNodeId) {
      return { ok: false, error: { code: 'BAD_ANCHOR', message: 'AST anchor does not belong to this component.' } };
    }
    const scope = ['own', 'l1', 'l2'].includes(input.scope) ? input.scope : 'own';
    const rel = typeof input.rel === 'string' ? input.rel : '';
    const start = getProjectSnapshot(r.root);
    if (!start.ok) return start;
    const refs = refsForAstAnchor(anchor, scope);
    if (!refs.includes(rel)) {
      return { ok: false, error: { code: 'OUT_OF_SCOPE', message: 'File is not part of this anchor scope.' } };
    }
    // Load only as far as the requested bounded window. This allows genuine
    // line pagination beyond line 200 without ever returning the skipped prefix.
    const requestedStart = Math.max(1, Math.min(100000, Math.trunc(Number(input.startLine) || 1)));
    const requestedCount = Math.max(1, Math.min(PREVIEW_LINE_LIMITS.maxLines, Math.trunc(Number(input.maxLines) || PREVIEW_LINE_LIMITS.defaultLines)));
    const readThrough = Math.min(100000, requestedStart + requestedCount - 1);
    const read = readProjectFile(r.root, rel, { maxLines: readThrough });
    if (!read.ok) return read;
    const end = getProjectSnapshot(r.root);
    if (!end.ok || end.data.fingerprint !== start.data.fingerprint) {
      return { ok: false, error: { code: 'PROJECT_CHANGED', message: 'Project changed during source preview.' } };
    }
    const res = buildAnchoredReadPreview({
      anchor, scope, rel, file: read.data,
      startLine: input.startLine, endLine: input.endLine, maxLines: input.maxLines,
    });
    if (!res.ok) return res;
    res.data.stale = typeof input.expectedSnapshot === 'string' && input.expectedSnapshot !== start.data.fingerprint;
    return { ok: true, data: res.data };
  });
}
