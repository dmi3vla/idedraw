// --- S4.1 security closure: read-only project tools + native dir picker -------
// The renderer and the model never supply a root for reads. The main process
// owns the canonical realpath of the linked project, chosen ONLY via a native
// directory dialog (project:chooseDirectory). Every read tool uses that root
// exclusively, so the model cannot read an arbitrary directory.
import { ipcMain, dialog } from 'electron';
import { listProjectFiles, readProjectFile, searchProjectFiles, getProjectSnapshot } from '../project/project-fs.mjs';
import { setProjectRoot, clearProjectRoot, getProjectStatus } from '../project/project-root.mjs';
import { openProjectCanvas, saveProjectCanvas, closeProjectCanvas } from '../project/project-canvas-file.mjs';
import { requireRoot } from './require-root.mjs';

export function registerProjectIpc({ projectAutosave }) {
  ipcMain.handle('project:chooseDirectory', async (event) => {
    await projectAutosave.flush(event.sender.id);
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: { code: 'CANCELLED', message: 'Выбор отменён' } };
    // Validate the candidate canvas before committing either main-owned store.
    // Invalid/symlink/oversized files leave the previous project fully active.
    const opened = openProjectCanvas(res.filePaths[0]);
    if (!opened.ok) return opened;
    const linked = setProjectRoot(res.filePaths[0]);
    if (!linked.ok) return linked; // canonical validation above makes this defensive only
    return opened;
  });

  ipcMain.handle('project:saveCanvas', (event, input) => saveProjectCanvas(input || {}));

  ipcMain.handle('project:queueAutosave', (event, input) => projectAutosave.queue(event.sender.id, input || {}));

  ipcMain.handle('project:flushAutosave', (event) => projectAutosave.flush(event.sender.id));

  ipcMain.handle('project:status', () => ({ ok: true, data: getProjectStatus() }));

  ipcMain.handle('project:clear', async (event) => {
    await projectAutosave.flush(event.sender.id);
    projectAutosave.discard(event.sender.id);
    clearProjectRoot();
    return closeProjectCanvas();
  });

  ipcMain.handle('project:listFiles', (e, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    return listProjectFiles(r.root);
  });

  ipcMain.handle('project:readFile', (e, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    return readProjectFile(r.root, (input && input.rel) || '');
  });

  ipcMain.handle('project:search', (e, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    return searchProjectFiles(r.root, (input && input.query) || '');
  });

  ipcMain.handle('project:snapshot', (e, input) => {
    const r = requireRoot();
    if (!r.ok) return { ok: false, error: r.error };
    return getProjectSnapshot(r.root);
  });
}
