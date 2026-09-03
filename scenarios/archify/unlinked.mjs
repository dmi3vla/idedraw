// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Phase 2, requirement 2.1/2.3: an unlinked canvas (a freeform sketch) must NOT
// be archify-imported — the command explicitly asks to link a project first
// instead of silently diagramming an unknown target or failing with a cryptic
// error. Proves the code path returns a clear NOT_LINKED error and (when a
// screenshot is requested) shows the toolbar with the Archify button disabled.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { theme = 'dark' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  const report = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    // Deliberately DO NOT link the project — the canvas is a bare sketch here.
    const res = await bridge.use_command('canvas.runArchifyImport', { replace: true });
    const link = bridge.query({ what: 'canvas.linkStatus' }).data;
    return {
      ok: res.ok,
      error: res.ok ? null : res.error,
      linked: link.linked,
    };
  })()`);

  console.log('ARCHIFY-UNLINKED ' + JSON.stringify(report, null, 2));
  const ok = !report.ok && report.error && report.error.code === 'NOT_LINKED' && report.linked === false;
  console.log(ok ? 'ARCHIFY-UNLINKED: PASSED (explicit NOT_LINKED, not silent)' : 'ARCHIFY-UNLINKED: FAILED');

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 300));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const outName = `archify-unlinked-${theme}.png`;
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  app.quit();
}
