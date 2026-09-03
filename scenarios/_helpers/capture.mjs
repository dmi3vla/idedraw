// The "capturePage -> writeFileSync -> console.log WROTE" trio appeared ~12
// times in main.mjs, each copy re-deriving the artifacts path. One helper now,
// with the same output contract (`WROTE artifacts/<name>`) the proof runners
// grep for.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

export async function captureArtifact(win, name) {
  const dir = path.join(APP_ROOT, 'artifacts');
  mkdirSync(dir, { recursive: true });
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, name), image.toPNG());
  console.log(`WROTE artifacts/${name}`);
  return path.join(dir, name);
}

// Two real animation frames must elapse before pixels are read, otherwise the
// compositor may not have painted the latest DOM/style state yet.
export async function settleFrames(win, delayMs = 300) {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
  await new Promise((r) => setTimeout(r, delayMs));
}
