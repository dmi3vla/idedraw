// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// S6-UI-1 live Electron acceptance. Unlike archify-projection (which drives the
// bridge once), this scenario drives the REAL toolbar button and the REAL React
// preview/confirm overlay: link the project, click `Archify`, wait for the
// [data-testid=projection-dialog], preview without mutating the scene, cancel,
// confirm (applied exactly once), repeat-confirm (already_applied), stale-refuse,
// apply-failure (failed), and Escape-to-cancel. Each step interacts only through
// the real button + React dialog, never through a direct command call.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app, dialog } from 'electron';
import { fixtureProjectionUiIR } from '../_helpers/fixtures.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runArchifyValidate } from '../../main/archify-client.mjs';
import { setTestProjectRoot } from '../_helpers/project-root.mjs';

export async function run(ctx = {}) {
  const { win, visualProof, skillStore } = ctx;
  const { mode = 'full', theme = 'dark', archifySpec = 'canvas-v2-architecture.json', scenario = 'none' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  // MAIN-only test hook: enable the archify skill (so `archify:validate` resolves
  // the frozen binary) and point the main-owned project root at the repo root
  // (so the linked `@app/canvas-v2-architecture.json` spec passes the scoped
  // validator). Never exposed to the renderer.
  if (skillStore) skillStore.setEnabled('archify', true);
  setTestProjectRoot(process.cwd());

  // The toolbar button validates the linked spec and previews `mode:'replace'`.
  // Compute expected counts from the SAME real CLI the toolbar uses, so the
  // acceptance asserts the actual projection regardless of spec size.
  const specPath = path.resolve(__dirname, archifySpec);
  const validated = runArchifyValidate(specPath);
  const hasCli = validated.ok && validated.data && validated.data.ir;
  const ir = hasCli ? validated.data.ir : null;
  // When the archify CLI is unavailable the toolbar falls back to the SAME
  // fixture IR (see registerArchifyIpc), so derive the expected counts from that
  // fixture here — the assertions and the toolbar can then never drift.
  const fixture = hasCli ? null : fixtureProjectionUiIR();
  const EXP = hasCli
    ? {
        components: (ir.components || []).length,
        connections: (ir.connections || []).length,
        boundaries: (ir.boundaries || []).length,
        srcIr: ir,
      }
    : {
        components: fixture.components.length,
        connections: fixture.connections.length,
        boundaries: fixture.boundaries.length,
        srcIr: fixture,
      };
  // Each component materialises as a rect + one native bound text element, each
  // boundary as a frame, each connection as a single bound arrow.
  EXP.totalElements = EXP.boundaries + EXP.components * 2 + EXP.connections;

  const report = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const raw = window.__canvasRaw__;
    const live = () => raw.elements().filter((e) => !e.isDeleted);
    const liveCount = () => live().length;
    const dialogSel = '[data-testid=projection-dialog]';
    const receiptSel = '[data-testid=projection-receipt]';
    const EXP = ${JSON.stringify(EXP)};
    const out = {};
    const LEAK = ['/home/', 'C:', 'D:', 'node_modules', 'evidenceMap', 'sourceFile', 'runToken'];
    const hasLeak = (s) => LEAK.some((k) => s.includes(k));
    const waitFor = (check, ms) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = !!check(); } catch (e) { ok = false; }
        if (ok) return resolve(true);
        if (Date.now() - t0 > (ms || 9000)) return reject(new Error('waitFor timeout'));
        setTimeout(tick, 100);
      };
      tick();
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btnByText = (txt) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === txt);
    const btnByPred = (pred) => Array.from(document.querySelectorAll('button')).find((b) => pred(b.textContent.trim(), b));
    const btnByClass = (cls) => document.querySelector('.' + cls);
    const dialog = () => document.querySelector(dialogSel);
    const receipt = () => document.querySelector(receiptSel);
    // Round 38 added a toolbar 'Отменить' button (archifyCancelBtn) that aborts live
    // generation. It is display:none when no run is active, but it still matches
    // btnByText('Отменить') FIRST in document order, so clicking it is a silent no-op
    // and the projection dialog's OWN cancel button is never hit. Always scope dialog
    // control lookups inside the dialog so the hidden toolbar clone cannot shadow them.
    const dialogBtn = (txt) => dialog() && Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent.trim() === txt);
    const closeDialog = async () => {
      const closeBtn = btnByText('Закрыть') || btnByClass('projection-icon-btn');
      if (closeBtn) closeBtn.click();
      await waitFor(() => !dialog());
    };
    // Wait for the receipt to show the GIVEN status text (not merely to exist):
    // the receipt element persists across a re-run, so a plain existence check
    // would read the previous status before React re-renders the new one.
    const waitForStatus = (txt) => waitFor(() => {
      const el = receipt();
      const t = el && el.querySelector('.projection-receipt-title');
      return !!(t && t.textContent.includes(txt));
    });

    try {
      // --- Phase 1: LINK the project, then PREVIEW (must not mutate) -------
      const linkBtn = btnByText('Link project');
      if (!linkBtn) return { fatal: { step: 'link', error: 'Link project button not found' } };
      linkBtn.click();
      await waitFor(() => btnByPred((t) => t.startsWith('Unlink')));
      const archBtn = btnByText('Archify');
      if (!archBtn) return { fatal: { step: 'archify', error: 'Archify button not found' } };
      out.archifyEnabled = !archBtn.disabled;
      const basePre = liveCount();
      archBtn.click();
      await waitFor(() => dialog());
      out.previewNoMutate = liveCount() === basePre;
      const dlgText = dialog().textContent;
      out.dialogHasMode = /Режим/.test(dlgText);
      out.dialogCounts = {
        components: dlgText.includes(String(EXP.components)),
        connections: dlgText.includes(String(EXP.connections)),
        boundaries: dlgText.includes(String(EXP.boundaries)),
      };
      out.dialogNoLeak = !hasLeak(dlgText);

      // --- Phase 1b: REFRESH consumes old preview and builds a fresh one ---
      const beforeRefresh = liveCount();
      const refreshBtn = btnByText('Обновить');
      if (!refreshBtn) return { fatal: { step: 'refresh', error: 'Refresh button not found' } };
      refreshBtn.click();
      await waitFor(() => {
        const status = document.querySelector('.archify-status');
        return !!(status && status.textContent.includes('Обновляю архитектуру'));
      });
      await waitFor(() => {
        const b = btnByText('Обновить');
        const status = document.querySelector('.archify-status');
        return !!(dialog() && b && !b.disabled && status && status.textContent.includes('Ожидает подтверждения'));
      });
      out.refreshAvailable = true;
      out.refreshSceneUnchanged = liveCount() === beforeRefresh;
      out.refreshDialogStillOpen = !!dialog();

      // --- Phase 2: CANCEL (scene unchanged, receipt cancelled) -----------
      const beforeCancel = liveCount();
      const cancelBtn = dialogBtn('Отменить');
      if (!cancelBtn) return { fatal: { step: 'cancel', error: 'Dialog cancel button not found' } };
      cancelBtn.click();
      await waitForStatus('Отменено');
      const rCancel = receipt().textContent;
      out.cancelStatus = rCancel.includes('Отменено') ? 'cancelled' : 'CANCEL_E:' + rCancel;
      out.cancelSceneUnchanged = liveCount() === beforeCancel;
      await closeDialog();

      // --- Phase 3: open a fresh preview, CONFIRM exactly once ------------
      const baseConfirm = liveCount();
      btnByText('Archify').click();
      await waitFor(() => dialog());
      out.confirmPreviewNoMutate = liveCount() === baseConfirm;
      const confirmBtn = btnByText('Импортировать');
      if (!confirmBtn) return { fatal: { step: 'confirm', error: 'Confirm button not found' } };
      confirmBtn.click();
      await waitForStatus('Импортировано');
      const rApplied = receipt().textContent;
      out.appliedStatus = rApplied.includes('Импортировано') ? 'applied' : 'APP_E:' + rApplied;
      out.appliedOnce = liveCount() === EXP.totalElements;
      out.receiptHasMode = rApplied.includes('replace');

      // --- Phase 4: REPEAT-CONFIRM (already_applied, scene unchanged) -----
      const beforeRepeat = liveCount();
      const repeatBtn = btnByText('Проверить повторный confirm');
      if (!repeatBtn) return { fatal: { step: 'repeat', error: 'Repeat-confirm button not found' } };
      repeatBtn.click();
      await waitForStatus('Уже применено');
      const rRepeat = receipt().textContent;
      out.alreadyApplied = rRepeat.includes('Уже применено') ? 'already_applied' : 'REPEAT_E:' + rRepeat;
      out.repeatSceneUnchanged = liveCount() === beforeRepeat;
      await closeDialog();

      // --- Phase 5: STALE (canvas changed between preview and confirm) -----
      btnByText('Archify').click();
      await waitFor(() => dialog());
      const beforeStale = liveCount();
      bridge.use_command('canvas.addNode', { id: 'stale-extra', label: 'Stale', x: 40, y: 40, width: 120, height: 60 });
      await sleep(120);
      const afterAdd = liveCount();
      btnByText('Импортировать').click();
      await waitForStatus('Предпросмотр устарел');
      const rStale = receipt().textContent;
      out.staleStatus = rStale.includes('Предпросмотр устарел') ? 'stale' : 'STALE_E:' + rStale;
      out.staleSceneUnchanged = liveCount() === afterAdd;
      await closeDialog();

      // --- Phase 6: FAILED (apply failure must not leak plan/source) ------  
      btnByText('Archify').click();
      await waitFor(() => dialog());
      const beforeFailed = liveCount();
      // Artificially invalidate the pending preview so confirm resolves to a
      // genuine apply failure (BAD_INPUT) through the real dialog's error path.
      bridge.use_command('canvas.clearProjectionState');
      await sleep(120);
      btnByText('Импортировать').click();
      await waitForStatus('Ошибка импорта');
      const rFailed = receipt().textContent;
      const failedDialogText = dialog().textContent;
      out.failedStatus = rFailed.includes('Ошибка импорта') ? 'failed' : 'FAIL_E:' + rFailed;
      out.failedSceneUnchanged = liveCount() === beforeFailed;
      out.failedNoLeak = !hasLeak(failedDialogText + rFailed);
      await closeDialog();

      // --- Phase 7: Escape cancels an active preview (scene unchanged) -----
      btnByText('Archify').click();
      await waitFor(() => dialog());
      const beforeEsc = liveCount();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await waitForStatus('Отменено');
      const rEsc = receipt().textContent;
      out.escapeStatus = rEsc.includes('Отменено') ? 'cancelled' : 'ESC_E:' + rEsc;
      out.escapeSceneUnchanged = liveCount() === beforeEsc;
      await closeDialog();

      // --- Phase 8: LIFECYCLE GATE (token canvas A -> canvas B -> confirm rejected) ---
      // A preview builds an opaque token on the CURRENT canvas (A). A transition
      // to a NEW canvas context (a real new-canvas / clear-scene / document-load /
      // re-link boundary) clears projection state so the old token can never be
      // confirmed on canvas B. We drive the exact boundary hook that link/unlink
      // (and a real new/load/clear) already use, then prove a confirm of the
      // now-orphaned token is REJECTED and applies nothing on the new scene.
      btnByText('Archify').click();
      await waitFor(() => dialog());
      const beforeGate = liveCount();
      bridge.use_command('canvas.clearProjectionState');
      await sleep(120);
      btnByText('Импортировать').click();
      await waitForStatus('Ошибка импорта');
      const rGate = receipt().textContent;
      out.lifecycleStatus = rGate.includes('Ошибка импорта') ? 'failed'
        : rGate.includes('устарел') ? 'stale'
        : rGate.includes('Импортировано') ? 'applied'
        : 'other';
      out.lifecycleRejected = out.lifecycleStatus !== 'applied';   // never applied
      out.lifecycleSceneUnchanged = liveCount() === beforeGate;     // nothing mutated
      await closeDialog();

      // --- Phase 9 (diagnostic): direct by-token idempotency ---------------
      // Prove confirmArchifyProjection's own token idempotency independent of the
      // toolbar/overlay, so a UI failure is attributable to one layer or the other.
      try {
        if (!EXP.srcIr) { out.directIdempotent = false; }
        else {
        const dT = bridge.use_command('canvas.previewArchifyProjection', { ir: EXP.srcIr, mode: 'replace' });
        if (dT.ok && dT.data.previewToken) {
          const t = dT.data.previewToken;
          const d1 = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: t });
          const d2 = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: t });
          out.directIdempotent = !!(d1.ok && d1.data.applied === true && d2.ok && d2.data.alreadyApplied === true && d2.data.applied === false);
          out.directFirst = d1.ok ? (d1.data.applied ? 'applied' : 'other') : 'err';
          out.directSecond = d2.ok ? (d2.data.status ? d2.data.status : (d2.data.alreadyApplied ? 'already_applied' : 'other')) : 'err';
        }
        }
      } catch (de) {
        out.directIdempotent = false;
      }

      out.finalLive = liveCount();
      return out;
    } catch (e) {
      return { fatal: { threw: String((e && e.stack) || e) } };
    }
  })()`);

  if (report.fatal) {
    console.error('ARCHIFY-PROJECTION-UI FAILED: ' + JSON.stringify(report.fatal));
    app.quit();
    return;
  }

  console.log('ARCHIFY-PROJECTION-UI ' + JSON.stringify(report, null, 2));
  const c = report;
  const ok =
    c.archifyEnabled === true &&
    c.previewNoMutate === true &&
    c.dialogHasMode === true &&
    c.dialogCounts.components === true &&
    c.dialogCounts.connections === true &&
    c.dialogCounts.boundaries === true &&
    c.dialogNoLeak === true &&
    c.refreshAvailable === true &&
    c.refreshSceneUnchanged === true &&
    c.refreshDialogStillOpen === true &&
    c.cancelStatus === 'cancelled' &&
    c.cancelSceneUnchanged === true &&
    c.confirmPreviewNoMutate === true &&
    c.appliedStatus === 'applied' &&
    c.appliedOnce === true &&
    c.receiptHasMode === true &&
    c.alreadyApplied === 'already_applied' &&
    c.repeatSceneUnchanged === true &&
    c.staleStatus === 'stale' &&
    c.staleSceneUnchanged === true &&
    c.failedStatus === 'failed' &&
    c.failedSceneUnchanged === true &&
    c.failedNoLeak === true &&
    c.escapeStatus === 'cancelled' &&
    c.escapeSceneUnchanged === true &&
    c.lifecycleRejected === true &&
    c.lifecycleSceneUnchanged === true;

  // Machine-readable acceptance artifact (CI): the full report plus the verdict,
  // so the Electron UI scenario is assertable without parsing stdout. Written to
  // artifacts/ in all runs (not only visualProof) so CI can always consume it.
  mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
  const jsonName = 'archify-projection-ui-' + theme + '.json';
  writeFileSync(path.join(__dirname, 'artifacts', jsonName), JSON.stringify({ theme, ok, report, cliGated: hasCli, passedAt: new Date().toISOString() }, null, 2));
  console.log('WROTE artifacts/' + jsonName);

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    const outName = 'archify-projection-ui-' + theme + '.png';
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  console.log(ok ? 'ARCHIFY-PROJECTION-UI: ALL CHECKS PASSED' : 'ARCHIFY-PROJECTION-UI: PROBLEM(S)');
  app.quit();
}
