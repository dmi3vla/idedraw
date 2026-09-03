import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// main.mjs is a bootstrap now. The generation flow these assertions guard moved
// to main/archify/generation.mjs and the turn loop to main/agent/runtime.mjs;
// both are read together so the checks keep covering the same guarantees.
const main = ['../main/archify/generation.mjs', '../main/agent/runtime.mjs']
  .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
  .join('\n');
const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');

test('generation progress crosses main -> preload -> renderer with safe stage names', () => {
  assert.match(main, /archify:generationProgress/);
  for (const stage of ['snapshot', 'evidence', 'author', 'repair', 'preview']) {
    assert.ok(main.includes(`progress('${stage}')`) || main.includes(`'${stage}'`));
    assert.ok(renderer.includes(`${stage}:`));
  }
  assert.match(preload, /onGenerationProgress/);
  assert.match(preload, /removeListener\('archify:generationProgress'/);
});

test('active generation can be cancelled by button or Escape', () => {
  assert.match(renderer, /archifyCancelBtn\.addEventListener\('click', cancelActiveGeneration\)/);
  assert.match(renderer, /event\.key === 'Escape' && generationRunning/);
  assert.match(renderer, /window\.archifyBridge\.cancelGeneration\(\)/);
  assert.match(renderer, /generationCancelRequested/);
});

test('generation keeps structured errors and provides actionable UI labels', () => {
  for (const code of ['NO_API_KEY', 'NO_MODEL', 'SKILL_DISABLED', 'TOOL_BUDGET_EXHAUSTED', 'PROJECT_CHANGED', 'CANCELLED', 'GENERATION_FAILED']) {
    assert.ok(renderer.includes(code), `${code} has a UI label`);
  }
  assert.match(renderer, /Object\.assign\(new Error/);
  // The handler surfaces a turn-level error back to the caller (not swallowed).
  assert.match(main, /turn && turn\.ok === false/);
  assert.match(main, /return turn/);
});

test('runChatTurn reports abort/network/budget failures to dedicated generation', () => {
  assert.match(main, /opts\.onToolUse/);
  assert.match(main, /turnError \? \{ ok: false, error: turnError \}/);
  // Abort maps to CANCELLED; a plain fetch/network failure maps to NETWORK (not a
  // generic GENERATION_FAILED), so the renderer shows a real actionable message.
  assert.match(main, /aborted/);
  assert.match(main, /'CANCELLED'/);
  assert.match(main, /'NETWORK'/);
  assert.match(main, /TOOL_BUDGET_EXHAUSTED/);
});
