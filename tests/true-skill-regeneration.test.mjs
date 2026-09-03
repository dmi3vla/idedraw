import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildArchifyGenerationPrompt } from '../main/archify-generation-prompt.mjs';

// The generation endpoints now live in main/archify/generation.mjs and the chat
// turn they drive in main/agent/runtime.mjs.
const main = ['../main/archify/generation.mjs', '../main/agent/runtime.mjs']
  .map((rel) => readFileSync(new URL(rel, import.meta.url), 'utf8'))
  .join('\n');
const preload = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../src/renderer-entry.jsx', import.meta.url), 'utf8');

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `${startText} exists`);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(end > start, `${endText} follows`);
  return source.slice(start, end);
}

test('real-project Archify uses the configured chat model/key and a fresh agent turn', () => {
  const handler = between(main, "ipcMain.handle('archify:generateProject'", "ipcMain.handle('archify:cancelGeneration'");
  assert.match(handler, /configStore\.load\(\)/);
  assert.match(handler, /secretStore\.getKey\(\)/);
  assert.match(handler, /runChatTurn\(/);
  // Запрос генерации вынесен в main/archify-generation-prompt.mjs, но обязанность та же:
  // генерация начинается со снимка проекта и чтения реальных файлов.
  assert.match(handler, /buildArchifyGenerationPrompt\(\{/);
  assert.match(handler, /snapshot: startSnapshot/);
  const prompt = buildArchifyGenerationPrompt({ projectName: 'p', snapshot: 'abc' });
  assert.match(prompt, /project\.getSnapshot/);
  assert.match(prompt, /project\.readFile/);
  assert.match(handler, /lastAuthorResult\(conv\)/);
  assert.doesNotMatch(handler, /scriptedArchifyModel/, 'production generation never uses the deterministic demo adapter');
});

test('generation is frozen to project generation and exact source snapshot', () => {
  const handler = between(main, "ipcMain.handle('archify:generateProject'", "ipcMain.handle('archify:cancelGeneration'");
  assert.match(handler, /input\.generation !== session\.generation/);
  assert.match(handler, /endSnapshot !== startSnapshot/);
  assert.match(handler, /PROJECT_CHANGED/);
  assert.match(handler, /projectContext:\s*\{\s*snapshot: startSnapshot/);
  assert.match(handler, /filesManifest: evidence\.filesManifest/);
  assert.match(handler, /bindEvidenceToArchifyIr\(authored\.ir, readFiles\)/);
  assert.match(handler, /anchorCount/);
});

test('renderer uses true skill generation for a real project and propagates provenance', () => {
  assert.match(preload, /generateProject: \(input\) => ipcRenderer\.invoke\('archify:generateProject'/);
  assert.match(renderer, /window\.archifyBridge\.generateProject\(/);
  assert.match(renderer, /generation: activeProjectGeneration/);
  assert.match(renderer, /projectContext: validated\.data\.projectContext/);
  assert.match(renderer, /skillContext: validated\.data\.skillContext/);
});

test('refresh still consumes the old preview before starting a new skill run', () => {
  const fn = between(renderer, 'async function generateArchifyPreview', "archifyBtn.addEventListener('click'");
  const cancel = fn.indexOf("canvas.cancelArchifyProjection', { previewToken: replacePreviewToken }");
  const generate = fn.indexOf('window.archifyBridge.generateProject');
  assert.ok(cancel >= 0 && generate > cancel);
  assert.match(fn, /onRegenerate: async \(previewToken\) => generateArchifyPreview/);
});

test('dedicated generation exposes only project/archify tools and supports abort', () => {
  const handler = between(main, "ipcMain.handle('archify:generateProject'", "ipcMain.handle('archify:cancelGeneration'");
  assert.match(handler, /startsWith\('project\.'\)/);
  assert.match(handler, /startsWith\('archify\.'\)/);
  assert.match(handler, /new AbortController\(\)/);
  assert.match(main, /signal: opts\.signal/);
});

test('saved-chat production proof refuses environment API keys', () => {
  const proof = readFileSync(new URL('../run-saved-chat-generation-proof.mjs', import.meta.url), 'utf8');
  assert.match(proof, /delete env\.ARCHIFY_API_KEY/);
  assert.match(proof, /report\.keySource === 'safeStorage'/);
  assert.match(proof, /report\.authorCompleted === true/);
  // The saved-chat acceptance scenario moved to scenarios/chat/, so its report
  // (which must prove the key came from safeStorage, never the environment) is
  // asserted there rather than in the production modules.
  const scenario = readFileSync(new URL('../scenarios/chat/saved-chat-generation.mjs', import.meta.url), 'utf8');
  assert.match(scenario, /keySource: 'safeStorage'/);
  assert.doesNotMatch(scenario, /process\.env\.ARCHIFY_API_KEY/);
  assert.doesNotMatch(main, /process\.env\.ARCHIFY_API_KEY/);
});
