// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Phase 2 regression: the archify import as a REAL in-app command, not the
// --scenario=archify-import path (which reads the spec directly in main). This
// path exercises the same code the toolbar button runs: link the project, then
// call canvas.runArchifyImport, which crosses IPC to the MAIN process, spawns
// the archify CLI over the linked project's spec, returns the resolved IR, and
// commits it as live scene elements. Verifies counts + the row of nodes landed.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTestProjectRoot } from '../_helpers/project-root.mjs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { theme = 'dark' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  // MAIN-only hook: the demo spec (`@app/canvas-v2-architecture.json`) lives at
  // the repo root; point the main-owned project root there so the scoped
  // `archify:validate` accepts it (it refuses specs outside the linked root).
  setTestProjectRoot(process.cwd());
  const report = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const link = bridge.use_command('canvas.linkProject', { canvasId: 'demo-canvas' });
    if (!link.ok) return { fatal: link.error };

    const res = await bridge.use_command('canvas.runArchifyImport', { replace: true });
    if (!res.ok) return { fatal: res.error };

    const raw = window.__canvasRaw__;
    const all = raw.elements();
    const frames = all.filter((e) => e.type === 'frame').length;
    const rects = all.filter((e) => e.type === 'rectangle').length;
    const arrows = all.filter((e) => e.type === 'arrow').length;
    return {
      result: res.data,
      counts: { frames, nodes: rects, arrows },
      specPath: res.data && res.data.specPath,
    };
  })()`);

  if (report.fatal) {
    console.error('ARCHIFY-BUTTON FAILED: ' + JSON.stringify(report.fatal));
    app.quit();
    return;
  }

  console.log('ARCHIFY-BUTTON ' + JSON.stringify(report, null, 2));

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const outName = `archify-button-${theme}.png`;
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  const ok =
    report.result.nodes === 11 &&
    report.result.edges === 10 &&
    report.counts.nodes === 11 &&
    report.counts.arrows === 10 &&
    report.counts.frames === 4;
  console.log(ok ? 'ARCHIFY-BUTTON: ALL CHECKS PASSED' : 'ARCHIFY-BUTTON: PROBLEM(S)');
  app.quit();
}
