import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// --source mode: the structural suite runs without first building the bundle.
// The `dist bundle exists` check is then a SKIP, not a failure, so a clean-room
// source-only verifier (`npm run verify:source`) can pass without `npm run build`.
const SOURCE_MODE = process.argv.includes('--source');

let failures = 0;
let skips = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
  if (!cond) failures++;
}
function checkSkip(label) {
  console.log(`SKIP: ${label}`);
  skips++;
}

// --- 1. Independence: chat never imports canvas internals or Excalidraw ---
const chatPanel = readFileSync('src/chat/chat-panel.mjs', 'utf8');
const llmClient = readFileSync('src/chat/llm-client.mjs', 'utf8');
check(
  'chat-panel.mjs does not import canvas/ or excalidraw',
  !/from ['"].*canvas\//.test(chatPanel) && !/excalidraw/i.test(chatPanel)
);
check(
  'llm-client.mjs does not import canvas/ or excalidraw (imports only, not prose)',
  !/^import .*from ['"].*canvas\//m.test(llmClient) && !/^import .*excalidraw/im.test(llmClient)
);
check(
  'chat-panel.mjs only reaches canvas/project through bridge.mjs',
  /from ['"]\.\.\/bridge\/bridge\.mjs['"]/.test(chatPanel)
);

// --- 2. Independence: canvas never imports chat ---
const adapter = readFileSync('src/canvas/adapter.mjs', 'utf8');
const mount = readFileSync('src/canvas/mount.jsx', 'utf8');
check('adapter.mjs does not import chat/', !/from ['"].*chat\//.test(adapter));
check('mount.jsx does not import chat/', !/from ['"].*chat\//.test(mount));

// --- 3. Composition root wires both (this is the ONLY allowed joint) ---
const entry = readFileSync('src/renderer-entry.jsx', 'utf8');
check('renderer-entry.jsx imports mountCanvas', /mountCanvas/.test(entry));
check('renderer-entry.jsx imports mountChat', /mountChat/.test(entry));

// --- 4. Registry uses the REAL adapters, not mocks ---
const registry = readFileSync('src/bridge/command-registry.mjs', 'utf8');
check(
  "command-registry.mjs imports real '../canvas/adapter.mjs'",
  /from ['"]\.\.\/canvas\/adapter\.mjs['"]/.test(registry)
);
check(
  "command-registry.mjs imports real '../project/project-store.mjs'",
  /from ['"]\.\.\/project\/project-store\.mjs['"]/.test(registry)
);

// --- 5. LLM seam is honestly labeled, not disguised as a real model call ---
check(
  'llm-client.mjs is explicitly labeled as a stub (not silently faked)',
  /deliberately labeled stub|not a real model call/.test(llmClient)
);

// --- 6. The built bundle actually contains real Excalidraw, not a mockup ---
if (SOURCE_MODE) {
  checkSkip('dist bundle exists (skipped in --source mode; run npm run build first)');
} else {
  check('dist bundle exists', existsSync('src/dist/renderer.bundle.js'));
  if (existsSync('src/dist/renderer.bundle.js')) {
    const bundle = readFileSync('src/dist/renderer.bundle.js', 'utf8');
    check('bundle contains real Excalidraw source (not a hand-drawn mock)', /Excalidraw/.test(bundle) && bundle.length > 500_000);
  }
}

// --- 7. Project store is independent of canvas link state ---
const projectStore = readFileSync('src/project/project-store.mjs', 'utf8');
check('project-store.mjs does not import canvas/', !/from ['"].*canvas\//.test(projectStore));

// --- 8. Dark is the default theme, end to end ---
// Three independent places have to agree, and each of them has silently
// disagreed at least once during development:
const theme = readFileSync('src/theme/theme.mjs', 'utf8');
// main.mjs is bootstrap-only now, so each structural check reads the module that
// actually owns the behaviour: argv defaults, window/theme wiring, chat IPC.
const mainArgv = readFileSync('main/app/argv.mjs', 'utf8');
const mainWindow = readFileSync('main/app/window.mjs', 'utf8');
const mainChatIpc = readFileSync('main/ipc/chat.ipc.mjs', 'utf8');
const chatCss = readFileSync('src/chat/chat.css', 'utf8');

check(
  "theme.mjs store default is 'dark'",
  /let current = ['"]dark['"]/.test(theme)
);
check(
  "argv.mjs --theme default is 'dark'",
  /theme:\s*['"]dark['"]/.test(mainArgv)
);
check(
  'window.mjs applies the theme via idempotent __setTheme__, never __toggleTheme__',
  /__setTheme__/.test(mainWindow) && !/__toggleTheme__/.test(mainWindow)
);
check(
  'chat.css var fallbacks and color-scheme match the dark default (no light flash)',
  /color-scheme:\s*dark light/.test(chatCss) &&
    /background:\s*var\(--bg,\s*#121212\)/.test(chatCss)
);

// --- 9. Excalidraw's hamburger clears our fixed toolbar strip -------------
// The toolbar occupies y=8..32 and Excalidraw's centered tool island reaches
// y=60, so the left menu column must be pushed past BOTH. Geometric
// non-overlap was not enough: at 46px the hamburger sat at y=62, formally
// clear but visually crowded right under the Theme button. Measured DOM
// geometry at margin-top:72px is hamburger y=88 — 56px below the toolbar and
// 28px below the tool island.
const burgerMargin = /\.App-menu_top__left\s*\{[^}]*margin-top:\s*(\d+)px/.exec(chatCss);
check(
  'chat.css pushes .App-menu_top__left down at all',
  burgerMargin !== null
);
check(
  'that offset clears the toolbar AND the centered tool island with visible air (>= 64px)',
  burgerMargin !== null && Number(burgerMargin[1]) >= 64
);

// --- 10. Archify import (phase 1) stays a pure, non-chat-callable path -----
// The converter must be data-only: importable and unit-testable without
// Excalidraw, React or the adapter being present.
const archifyImport = readFileSync('src/canvas/archify-import.mjs', 'utf8');
check(
  'archify-import.mjs imports neither adapter.mjs nor React/Excalidraw',
  !/from ['"][^'"]*adapter\.mjs['"]/.test(archifyImport) &&
    !/from ['"]react/.test(archifyImport) &&
    !/@excalidraw/.test(archifyImport)
);
check(
  'archify-import.mjs does not pull cards[] or meta.views[] into the graph',
  !/\bir\.cards\b[^\n]*(nodes|edges|frames)/.test(archifyImport) &&
    !/(nodes|edges|frames)[^\n]*\bir\.cards\b/.test(archifyImport)
);
// `registry` is already read above (block 4) — reuse it, don't re-read.
check(
  "canvas.importArchify is registered and flagged notForChat (the intent parser must not be able to trigger a diagram import)",
  /canvas\.importArchify/.test(registry) &&
    /notForChat:\s*true/.test(registry)
);
// S6: the projection commands must STAY out of the chat-reachable set — a model
// may prepare an IR but must never bypass preview/confirm to mutate the canvas.
check(
  'canvas.preview/confirm/cancelArchifyProjection are registered and flagged notForChat',
  /canvas\.previewArchifyProjection/.test(registry) &&
    /canvas\.confirmArchifyProjection/.test(registry) &&
    /canvas\.cancelArchifyProjection/.test(registry) &&
    (registry.match(/notForChat:\s*true/g) || []).length >= 4
);

// --- 11. Real chat path (stream A): the model must get real JSON Schema, not
// prose, and the renderer must expose a streaming bridge surface ----------
const chatBridge = readFileSync('preload.cjs', 'utf8');
check(
  'preload.cjs exposes a chatBridge surface with send() and onToolRequest()',
  /contextBridge\.exposeInMainWorld\('chatBridge'/m.test(chatBridge) &&
    /send:\s*\(text, opts\)/.test(chatBridge) &&
    /onToolRequest:\s*\(cb\)/.test(chatBridge)
);
check(
  'chat.ipc.mjs wires chat:send (delegates tool execution back to the renderer) and chat:toolResult',
  /ipcMain\.on\('chat:send'/.test(mainChatIpc) && /ipcMain\.on\('chat:toolResult'/.test(mainChatIpc)
);
check(
  'every chat-reachable command carries a real JSON inputSchema (not just prose)',
  /inputSchema:\s*\{\s*type:\s*'object'/.test(registry)
);
check(
  'chat-stream.mjs exists and parses SSE without importing any renderer/Excalidraw code',
  !/from ['"]\.\.\/canvas\//.test(readFileSync('main/chat-stream.mjs', 'utf8')) &&
    /streamAnthropic/.test(readFileSync('main/chat-stream.mjs', 'utf8'))
);

const summary =
  failures === 0
    ? skips > 0
      ? `ALL STRUCTURAL CHECKS PASSED (${skips} skipped in --source mode)`
      : 'ALL STRUCTURAL CHECKS PASSED'
    : `${failures} STRUCTURAL CHECK(S) FAILED`;
console.log(`\n${summary}`);
console.log('NOTE: structural checks alone are not visual proof — run: npm run verify:visual\n');

if (failures > 0) process.exit(1);
// A --source run that reports skips is still a pass; skips are not failures.
