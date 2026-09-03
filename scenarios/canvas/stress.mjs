// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// --- Stream D: stress-test scenario ------------------------------------------
// Orchestrates the renderer-side runner (stress/run-stress.mjs) and measures
// process memory here in the MAIN process, where app.getAppMetrics() can see
// every Electron child process.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { mode = 'full' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  const count = parseInt(argValue('--count', '100'), 10);
  const stressMode = argValue('--stress-mode', 'bridge'); // bridge | baseline
  const cycles = parseInt(argValue('--stress-cycles', '0'), 10);
  const stressCompact = args.includes('--stress-compact');
  const cyclesSuffix = `${cycles > 0 ? `-cycles${cycles}` : ''}${stressCompact ? '-compacted' : ''}`;

  const memSnapshot = () => {
    let rendererKb = 0;
    let totalKb = 0;
    for (const m of app.getAppMetrics()) {
      const kb = (m.memory && m.memory.workingSetSize) || 0;
      totalKb += kb;
      if (m.type === 'Tab') rendererKb += kb;
    }
    return { mainRssKb: Math.round(process.memoryUsage().rss / 1024), rendererKb, totalKb };
  };

  // wait for the stress hooks exposed by renderer-entry (dynamic import)
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        if (typeof window.__runStress__ === 'function') resolve(true);
        else if (Date.now() - t0 > 15000) reject(new Error('stress hooks never appeared'));
        else setTimeout(check, 50);
      };
      check();
    });
  `);

  const rssBefore = memSnapshot();
  const result = await win.webContents.executeJavaScript(
    `window.__runStress__({ count: ${count}, mode: ${JSON.stringify(stressMode)} })`
  );
  const rssAfter = memSnapshot();

  let cycleStats = null;
  if (cycles > 0) {
    cycleStats = [];
    for (let i = 1; i <= cycles; i++) {
      const r = await win.webContents.executeJavaScript(
        `window.__runStressCycle__({ count: ${count}, cycle: ${i}, compact: ${stressCompact} })`
      );
      await new Promise((r2) => setTimeout(r2, 500)); // let GC settle a bit
      cycleStats.push({ ...r, mem: memSnapshot() });
      console.log(`cycle ${i}/${cycles}: add=${r.addMs}ms remove=${r.removeMs}ms totalKb=${cycleStats[i - 1].mem.totalKb}`);
    }
  }

  mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
  const jsonName = `stress-${stressMode}-${count}${cyclesSuffix}.json`;
  writeFileSync(
    path.join(__dirname, 'artifacts', jsonName),
    JSON.stringify({ count, mode: stressMode, ...result, rssBefore, rssAfter, cycles: cycleStats }, null, 2)
  );
  console.log(
    `STRESS mode=${stressMode} count=${count} addNodesMs=${result.addNodesMs} addEdgesMs=${result.addEdgesMs} ` +
    `avgFps=${result.avgFps} elements=${result.elementsInScene} totalKb ${rssBefore.totalKb}->${rssAfter.totalKb}`
  );
  console.log(`WROTE artifacts/${jsonName}`);

  if (visualProof) {
    const image = await win.webContents.capturePage();
    const pngName = `stress-${stressMode}-${count}${cyclesSuffix}.png`;
    writeFileSync(path.join(__dirname, 'artifacts', pngName), image.toPNG());
    console.log(`WROTE artifacts/${pngName}`);
  }
  app.quit();
}
