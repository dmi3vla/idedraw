import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/canvas/adapter.mjs', import.meta.url), 'utf8');

function body(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const next = source.indexOf('\nexport function ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test('loading a project resets old scene/files before adding the new document files', () => {
  const fn = body('loadExcalidrawDocument');
  const reset = fn.indexOf('excalidrawAPI.resetScene()');
  const add = fn.indexOf('excalidrawAPI.addFiles');
  assert.ok(reset >= 0 && add > reset, 'resetScene precedes addFiles');
  assert.match(fn, /RESET_UNAVAILABLE/, 'unsafe fallback is refused rather than leaking files');
});

test('opening an empty project performs a full reset, not only updateScene([])', () => {
  const fn = body('emptyExcalidrawDocument');
  assert.match(fn, /excalidrawAPI\.resetScene\(\)/);
});
