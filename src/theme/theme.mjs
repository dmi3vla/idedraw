// Independent theme store. Neither canvas nor chat owns this — both subscribe.
// No dependency in either direction: this module knows nothing about
// Excalidraw or the chat panel.

const listeners = new Set();
let current = 'dark';

export function getTheme() {
  return current;
}

export function setTheme(next) {
  if (next !== 'light' && next !== 'dark') {
    throw new Error(`Unknown theme: ${next}`);
  }
  if (next === current) return;
  current = next;
  for (const cb of listeners) cb(current);
}

export function toggleTheme() {
  setTheme(current === 'light' ? 'dark' : 'light');
  return current;
}

export function onThemeChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// CSS custom properties applied to a root element (chat panel, toolbar chrome).
// Excalidraw manages its own internal theme via the `theme` prop separately —
// this only covers the chrome *around* it (chat, toolbar, dock).
const THEME_VARS = {
  light: {
    '--bg': '#ffffff',
    '--bg-panel': '#f7f7f8',
    '--fg': '#1e1e1e',
    '--fg-muted': '#6b6b6b',
    '--border': '#e0e0e0',
    '--accent': '#4a63e7',
    '--bubble-user': '#4a63e7',
    '--bubble-user-fg': '#ffffff',
    '--bubble-tool': '#eef0fb',
    '--bubble-tool-fg': '#33395c',
  },
  dark: {
    '--bg': '#121212',
    '--bg-panel': '#1a1a1e',
    '--fg': '#e8e8e8',
    '--fg-muted': '#9a9a9a',
    '--border': '#2c2c30',
    '--accent': '#7c8cf0',
    '--bubble-user': '#7c8cf0',
    '--bubble-user-fg': '#12121a',
    '--bubble-tool': '#23233a',
    '--bubble-tool-fg': '#c6cbf5',
  },
};

export function applyThemeVars(rootEl, theme) {
  const vars = THEME_VARS[theme];
  for (const [k, v] of Object.entries(vars)) {
    rootEl.style.setProperty(k, v);
  }
  rootEl.setAttribute('data-theme', theme);
  // Force a synchronous layout read so a pure custom-property mutation
  // (no DOM structure change) can't be served as a stale compositor frame.
  // Cheap, and defensive against slow/software-rendering paths.
  void rootEl.offsetHeight;
}
