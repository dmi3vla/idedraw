// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// --- Stream C: config/secret IPC self-test -----------------------------------
// Exercises the REAL preload surface (window.configBridge) end-to-end: config
// round-trip, key set/status/clear via safeStorage, and the failure path of a
// connection test against a non-existent endpoint. Requires --profile=<name>
// so it never touches the user's real saved config.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const __dirname = APP_ROOT;
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const c = window.configBridge;
      if (!c) return { fatal: 'window.configBridge is not exposed — preload failed' };
      // C5 check: on a fresh profile the "not configured" banner must be visible
      const banner = document.querySelector('.chat-banner');
      const bannerVisibleFresh = banner && banner.style.display !== 'none';
      const before = await c.getConfig();
      await c.setConfig({ endpoint: 'https://example.invalid/v1/messages', model: 'selftest-model' });
      const after = await c.getConfig();
      const keyStatusBefore = await c.getKeyStatus();
      let setKeyError = null;
      try { await c.setKey('selftest-roundtrip-value'); } catch (e) { setKeyError = String(e.message || e); }
      const keyStatusAfter = await c.getKeyStatus();
      const badTest = await c.testConnection({});
      await c.clearKey();
      const keyStatusCleared = await c.getKeyStatus();
      await c.setConfig({ endpoint: before.endpoint, model: before.model });
      const restored = await c.getConfig();
      // C3 check: the settings form opens with prefilled values and the key
      // field never shows the stored secret
      window.__chat__.openSettings();
      await new Promise((res) => setTimeout(res, 200));
      const form = document.querySelector('.chat-settings');
      const formOpen = form && form.style.display !== 'none';
      const formEndpoint = form && form.querySelector('input[type=text]').value;
      const formKeyIsEmpty = form && form.querySelector('input[type=password]').value === '';
      const modelHint = form && form.querySelector('.chat-model-hint');
      const modelHintText = modelHint ? modelHint.textContent : null;
      window.__chat__.closeSettings();
      return { bannerVisibleFresh, formOpen, formEndpoint, formKeyIsEmpty, modelHintText, before, after, keyStatusBefore, setKeyError, keyStatusAfter, badTest, keyStatusCleared, restored };
    })()`);
    console.log('CONFIG-SELFTEST ' + JSON.stringify(r, null, 2));
  } catch (e) {
    console.error('CONFIG-SELFTEST FAILED: ' + (e.message || e));
  }

  if (visualProof) {
    // Show the settings form itself for the acceptance screenshot.
    try {
      await win.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const check = () => {
            if (window.__chat__ && typeof window.__chat__.openSettings === 'function') {
              window.__chat__.openSettings();
              setTimeout(resolve, 300);
            } else setTimeout(check, 50);
          };
          check();
        });
      `);
      await new Promise((r2) => setTimeout(r2, 300));
      mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
      const image = await win.webContents.capturePage();
      writeFileSync(path.join(__dirname, 'artifacts', 'electron-chat-only-light-config-form.png'), image.toPNG());
      console.log('WROTE artifacts/electron-chat-only-light-config-form.png');
    } catch (e) {
      console.error('CONFIG-FORM CAPTURE FAILED: ' + (e.message || e));
    }
  }
  app.quit();
}
