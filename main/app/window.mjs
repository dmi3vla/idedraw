// Window creation and renderer readiness, moved out of the bootstrap.
import { BrowserWindow } from 'electron';
import path from 'node:path';

export function createMainWindow({ appRoot }) {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      preload: path.join(appRoot, 'preload.cjs'),
    },
  });

  // The default menu is gone, so its accelerators (DevTools) are gone too —
  // keep F12 working for development.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  return win;
}

export async function loadRenderer(win, { appRoot, mode, scenario }) {
  const url = `file://${path.join(appRoot, 'src/index.html')}?mode=${mode}&scenario=${scenario}`;
  await win.loadURL(url);

  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const check = () => { if (window.__ready__) resolve(true); else setTimeout(check, 50); };
      check();
    });
  `);

  // Wait for Excalidraw to actually finish painting its canvas/toolbar DOM,
  // not just for our module to have run (module-ready != canvas-painted).
  if (mode !== 'chat-only') {
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const check = () => {
          const painted = document.querySelector('.excalidraw') &&
            !document.body.textContent.includes('Loading scene');
          if (painted) resolve(true); else setTimeout(check, 100);
        };
        check();
      });
    `);
  }
}

// Set explicitly and idempotently — never via toggle, which would depend on
// the renderer's built-in default and double-flip when defaults change.
export async function applyTheme(win, theme) {
  if (theme !== 'dark' && theme !== 'light') return;
  await win.webContents.executeJavaScript(`window.__setTheme__(${JSON.stringify(theme)});`);
  await new Promise((r) => setTimeout(r, 300));
}
