// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Manual production proof. It intentionally uses the app's normal userData
// profile and therefore the endpoint/model/key saved by the Chat settings UI.
// No environment API-key fallback is read. The artifact contains booleans and
// counts only — never config secrets, prompts, source, tool payloads or paths.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app, dialog } from 'electron';
import { clearProjectRoot, setProjectRoot } from '../../main/project/project-root.mjs';
import { closeProjectCanvas, openProjectCanvas } from '../../main/project/project-canvas-file.mjs';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export async function run(ctx = {}) {
  const { win, configStore, secretStore } = ctx;
  const __dirname = APP_ROOT;
  const artifactPath = path.join(__dirname, 'artifacts', 'saved-chat-generation.json');
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  const cfg = configStore.load();
  const base = {
    keySource: 'safeStorage',
    storedKeyPresent: secretStore.hasKey(),
    configuredModelPresent: !!cfg.model,
    configuredEndpointPresent: !!cfg.endpoint,
  };
  let tempRoot = null;
  let turnError = null;
  try {
    if (!base.storedKeyPresent) throw Object.assign(new Error('No key saved in Chat settings.'), { code: 'NO_API_KEY' });
    if (!base.configuredModelPresent) throw Object.assign(new Error('No model saved in Chat settings.'), { code: 'NO_MODEL' });
    tempRoot = mkdtempSync(path.join(tmpdir(), 'saved-chat-archify-'));
    cpSync(path.join(__dirname, 'tests', 'fixture-project'), tempRoot, { recursive: true });
    const opened = openProjectCanvas(tempRoot);
    if (!opened.ok) throw Object.assign(new Error('Project fixture open failed.'), { code: opened.error && opened.error.code });
    const linked = setProjectRoot(tempRoot);
    if (!linked.ok) throw Object.assign(new Error('Project fixture link failed.'), { code: linked.error && linked.error.code });

    const generated = await win.webContents.executeJavaScript(`(async () => {
      await window.__activateOpenedProjectForProof__(${JSON.stringify(opened)});
      return window.__generateArchifyPreviewForProof__();
    })()`);
    if (!generated || !generated.ok) {
      throw Object.assign(new Error('Saved-chat generation failed.'), { code: generated && generated.error && generated.error.code || 'GENERATION_FAILED' });
    }
    const ui = await win.webContents.executeJavaScript(`(async () => {
      const waitFor = (check, ms = 120000) => new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          try { if (check()) return resolve(true); } catch {}
          if (Date.now() - start > ms) return reject(new Error('UI timeout'));
          setTimeout(tick, 100);
        };
        tick();
      });
      await waitFor(() => document.querySelector('[data-testid=projection-dialog]'));
      const before = window.__canvasRaw__.elements().filter((e) => !e.isDeleted).length;
      const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Импортировать');
      if (!button) return { ok: false, code: 'CONFIRM_NOT_FOUND' };
      button.click();
      await waitFor(() => {
        const title = document.querySelector('.projection-receipt-title');
        return title && title.textContent.includes('Импортировано');
      });
      const after = window.__canvasRaw__.elements().filter((e) => !e.isDeleted).length;
      return { ok: true, sceneUnchangedBeforeConfirm: before === 0, liveElementsAfterConfirm: after };
    })()`);
    if (!ui || !ui.ok) throw Object.assign(new Error('Preview confirm failed.'), { code: ui && ui.code || 'CONFIRM_FAILED' });
    const canvasFile = path.join(tempRoot, 'architecture.excalidraw');
    const saved = existsSync(canvasFile);
    const doc = saved ? JSON.parse(readFileSync(canvasFile, 'utf8')) : null;
    const report = {
      ...base,
      ok: !!(saved && doc && doc.type === 'excalidraw' && Array.isArray(doc.elements) && doc.elements.length > 0),
      usedStoredChatSettings: true,
      usedConfiguredModel: generated.data && generated.data.generationProof && generated.data.generationProof.usedConfiguredModel === true,
      authorCompleted: generated.data && generated.data.generationProof && generated.data.generationProof.authorCompleted === true,
      projectReadCount: generated.data && generated.data.generationProof ? generated.data.generationProof.projectReadCount : 0,
      productionHandler: true,
      sceneUnchangedBeforeConfirm: ui.sceneUnchangedBeforeConfirm,
      liveElementsAfterConfirm: ui.liveElementsAfterConfirm,
      savedExcalidraw: saved,
      savedElements: doc && Array.isArray(doc.elements) ? doc.elements.length : 0,
      passedAt: new Date().toISOString(),
    };
    writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    console.log(report.ok ? 'SAVED-CHAT-GENERATION: ALL CHECKS PASSED' : 'SAVED-CHAT-GENERATION: PROBLEM(S)');
  } catch (error) {
    const report = { ...base, ok: false, usedStoredChatSettings: true, errorCode: error && error.code || 'FAILED' };
    writeFileSync(artifactPath, JSON.stringify(report, null, 2));
    console.error('SAVED-CHAT-GENERATION: FAILED ' + report.errorCode);
  } finally {
    clearProjectRoot();
    closeProjectCanvas();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    app.quit();
  }
}
