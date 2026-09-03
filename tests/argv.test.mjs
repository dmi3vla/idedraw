// argv parsing used to be inline argValue() calls in the main.mjs bootstrap and
// therefore untestable. Now it is a pure function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, ARGV_DEFAULTS } from '../main/app/argv.mjs';

test('defaults match the documented production defaults', () => {
  const argv = parseArgs([]);
  assert.equal(argv.mode, 'full');
  assert.equal(argv.theme, 'dark'); // dark is the app default; a light default would flash
  assert.equal(argv.scenario, 'none');
  assert.equal(argv.archifySpec, 'canvas-v2-architecture.json');
  assert.equal(argv.profile, null);
  assert.equal(argv.visualProof, false);
  assert.deepEqual(Object.keys(ARGV_DEFAULTS).sort(), ['archifySpec', 'mode', 'scenario', 'theme']);
});

test('flags are read as --flag=value and --visual-proof is a boolean', () => {
  const argv = parseArgs(['--mode=chat-only', '--theme=light', '--scenario=archify-diag', '--profile=selftest', '--visual-proof']);
  assert.equal(argv.mode, 'chat-only');
  assert.equal(argv.theme, 'light');
  assert.equal(argv.scenario, 'archify-diag');
  assert.equal(argv.profile, 'selftest');
  assert.equal(argv.visualProof, true);
});

test('only the first = separates flag from value', () => {
  // A spec path or profile name containing '=' must survive intact; the old
  // split('=')[1] silently truncated it.
  const argv = parseArgs(['--archify-spec=specs/a=b.json']);
  assert.equal(argv.archifySpec, 'specs/a=b.json');
});

test('unknown flags and bare arguments are ignored, not misread', () => {
  const argv = parseArgs(['--no-sandbox', 'extra', '--mode', '--mode=canvas-only']);
  assert.equal(argv.mode, 'canvas-only');
});

test('the result is frozen so no later code can mutate parsed argv', () => {
  const argv = parseArgs(['--mode=full']);
  assert.throws(() => { argv.mode = 'chat-only'; }, TypeError);
});
