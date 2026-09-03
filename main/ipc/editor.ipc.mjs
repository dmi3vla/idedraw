// The ONLY write path into the linked project. Kept in its own module so an
// audit of "what can modify the user's files?" is a one-file read.
import { ipcMain } from 'electron';
import { writeProjectTextFile, getProjectSnapshot } from '../project/project-fs.mjs';
import { publicSession } from '../project/project-canvas-file.mjs';
import { refsForAstAnchor } from '../project/ast-anchor-manifest.mjs';
import { requireRoot } from './require-root.mjs';

export function registerEditorIpc() {
  // Explicit user edit from an AST listing card. The renderer still cannot
  // choose a root: it supplies only an anchor-owned relative file and the
  // snapshot it actually reviewed. A stale editor can never overwrite a file.
  ipcMain.handle('project:writeAstFile', (event, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    const session = publicSession();
    if (!input || !session.linked || input.generation !== session.generation) {
      return { ok: false, error: { code: 'STALE_PROJECT', message: 'Project changed before source save.' } };
    }
    const anchor = input.astAnchor;
    const projectNodeId = typeof input.projectNodeId === 'string' ? input.projectNodeId : '';
    if (!anchor || anchor.componentId !== projectNodeId) {
      return { ok: false, error: { code: 'BAD_ANCHOR', message: 'AST anchor does not belong to this component.' } };
    }
    const scope = ['own', 'l1', 'l2'].includes(input.scope) ? input.scope : 'own';
    const rel = typeof input.rel === 'string' ? input.rel : '';
    if (!refsForAstAnchor(anchor, scope).includes(rel)) {
      return { ok: false, error: { code: 'OUT_OF_SCOPE', message: 'File is not part of this anchor scope.' } };
    }
    const before = getProjectSnapshot(r.root);
    if (!before.ok) return before;
    if (typeof input.expectedSnapshot !== 'string' || input.expectedSnapshot !== before.data.fingerprint) {
      return { ok: false, error: { code: 'STALE_PROJECT', message: 'File changed after the editor was opened. Refresh before saving.' } };
    }
    const saved = writeProjectTextFile(r.root, rel, input.content, { maxBytes: 256 * 1024 });
    if (!saved.ok) return saved;
    const after = getProjectSnapshot(r.root);
    if (!after.ok) return after;
    return { ok: true, data: { ...saved.data, snapshot: after.data.fingerprint } };
  });
}
