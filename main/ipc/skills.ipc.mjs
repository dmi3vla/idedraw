// Skills registry IPC.
import { ipcMain, dialog } from 'electron';
import { readFileSync } from 'node:fs';

// --- Skills: local CLI skill registry (plan slice S2) -------------------------
// The renderer reads/disables/removes skills through preload; the main process
// owns the skill store (persisted in userData) and the folder dialog. Adding a
// skill uses a native dialog so the renderer never needs fs access. The SKILL.md
// body is served only to the agent-runtime prompt builder (skills:read), never
// exposed as arbitrary file reads.
export function registerSkillIpc({ skillStore }) {
  ipcMain.handle('skills:list', () => {
    const res = skillStore.list();
    return { ok: true, data: res };
  });
  ipcMain.handle('skills:get', (e, input) => {
    const res = skillStore.get((input && input.name) || '');
    return res.ok ? { ok: true, data: res.data } : res;
  });
  ipcMain.handle('skills:read', (e, input) => {
    const rec = skillStore.get((input && input.name) || '');
    if (!rec.ok) return rec;
    try {
      const raw = readFileSync(rec.data.path, 'utf8');
      return { ok: true, data: { ...rec.data, content: raw } };
    } catch (e2) {
      return { ok: false, error: { code: 'READ_ERROR', message: String((e2 && e2.message) || e2) } };
    }
  });
  ipcMain.handle('skills:addDialog', async (e) => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: { code: 'CANCELLED', message: 'Выбор отменён' } };
    return skillStore.addPath(res.filePaths[0]);
  });
  ipcMain.handle('skills:setEnabled', (e, input) => skillStore.setEnabled((input && input.name) || '', !!(input && input.enabled)));
  ipcMain.handle('skills:remove', (e, input) => skillStore.remove((input && input.name) || ''));
}
