// Frameless window controls.
import { BrowserWindow, ipcMain } from 'electron';

// --- Frameless window controls ----------------------------------------------
// Buttons in the renderer send fire-and-forget messages; the main process
// resolves the sending window from the event.
export function registerWindowIpc({ projectAutosave }) {
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    void projectAutosave.flush(event.sender.id).finally(() => win?.close());
  });
}
