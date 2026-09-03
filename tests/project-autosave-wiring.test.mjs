import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The autosave flush wiring left main.mjs for the window and project IPC
// modules; read both so flush-on-close stays covered.
const main = ['../main/ipc/window.ipc.mjs', '../main/ipc/project.ipc.mjs']
  .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
  .join('\n');
const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');
const mount = readFileSync(new URL('../src/canvas/mount.jsx', import.meta.url), 'utf8');

test('canvas changes queue a generation-protected serialized document', () => {
  assert.match(mount, /CustomEvent\('canvas:change'\)/);
  assert.match(renderer, /window\.projectBridge\.queueAutosave/);
  assert.match(renderer, /generation: activeProjectGeneration/);
  assert.match(renderer, /document: serializeExcalidrawDocument\(\)/);
  assert.match(renderer, /setTimeout\([\s\S]*500\)/);
});

test('project transitions and window close flush pending autosave', () => {
  assert.match(renderer, /window\.projectBridge\.flushAutosave/);
  assert.match(main, /projectAutosave\.flush\(event\.sender\.id\)/);
  assert.match(main, /finally\(\(\) => win\?\.close\(\)\)/);
});

test('preload exposes queue and flush but no path-bearing save API', () => {
  assert.match(preload, /queueAutosave: \(input\) => ipcRenderer\.invoke\('project:queueAutosave'/);
  assert.match(preload, /flushAutosave: \(\) => ipcRenderer\.invoke\('project:flushAutosave'/);
  assert.doesNotMatch(preload, /queueAutosave: \([^)]*path/);
});
