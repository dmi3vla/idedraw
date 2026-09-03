import { mountCanvas } from './canvas/mount.jsx';
import { mountChat } from './chat/chat-panel.mjs';
import { getTheme, toggleTheme, setTheme, onThemeChange, applyThemeVars } from './theme/theme.mjs';
import { bridge } from './bridge/bridge.mjs';
import { _getRawElements, _getSelectedIds, _sceneToViewport, loadExcalidrawDocument, emptyExcalidrawDocument, serializeExcalidrawDocument } from './canvas/adapter.mjs';
import { showArchifyProjectionPreview } from './canvas/archify-projection-overlay.jsx';
import { mountAstView } from './ast-view/ast-view.mjs';

const mode = window.__MODE__ || 'full'; // 'full' | 'chat-only' | 'canvas-only'

const canvasRoot = document.getElementById('canvas-root');
const chatRoot = document.getElementById('chat-root');
const astRoot = document.getElementById('ast-root');
const toolbar = document.getElementById('toolbar');

applyThemeVars(document.documentElement, getTheme());
onThemeChange((t) => applyThemeVars(document.documentElement, t));

// The AST dock, the chat panel and the toolbar are OUR chrome, but they must not
// look like a third design system next to Excalidraw. So they get `excalidraw-skin`,
// which only redeclares Excalidraw's tokens (--island-bg-color,
// --default-border-color, --color-primary, --border-radius-lg) and switches with
// theme--dark in the same frame as the canvas.
//
// NEVER add the bare `excalidraw` class here. In Excalidraw's stylesheet that
// class marks the APP ROOT: it carries height: 100% plus its own flex rules, so
// putting it on #toolbar stretched every button to the full window height (and
// did the same to the AST context menu).
function applyExcalidrawSkin(theme) {
  for (const node of [astRoot, chatRoot, toolbar]) {
    if (!node) continue;
    node.classList.add('excalidraw-skin');
    node.classList.toggle('theme--dark', theme === 'dark');
  }
}
applyExcalidrawSkin(getTheme());
onThemeChange(applyExcalidrawSkin);

if (mode === 'chat-only') {
  canvasRoot.style.display = 'none';
} else {
  mountCanvas(canvasRoot);
}

// Chat is tucked behind a top-right button (next to the Library button and
// below the window min/max/close controls), like Excalidraw's Library panel.
// Closed by default in 'full' mode (Chat button visible); open it with the
// button, close it with the X in the chat header (which reverts to the button).
// In 'chat-only' the chat IS the window, so it is always open with no button.
let chatOpen = mode === 'chat-only';
const chatToggleBtn = document.createElement('button');
chatToggleBtn.className = 'chat-toggle';
chatToggleBtn.textContent = 'Chat';
function setChatOpen(open) {
  chatOpen = open;
  chatRoot.style.display = open ? 'flex' : 'none';
  // The button only exists in 'full' mode (it is never mounted in chat-only).
  chatToggleBtn.style.display = open ? 'none' : '';
}
chatToggleBtn.addEventListener('click', () => setChatOpen(true));

if (mode === 'canvas-only') {
  chatRoot.style.display = 'none'; // canvas-only: no chat surface at all
} else {
  // Only in 'full' does the chat collapse behind the Chat button; in 'chat-only'
  // the chat IS the window, so there is no X (no onClose supplied).
  const chat = mountChat(chatRoot, mode === 'full' ? { onClose: () => setChatOpen(false) } : {});
  window.__chat__ = chat; // used by config-selftest to open the settings form on screenshots
}

// Wire the button + default visibility after the panel is mounted.
if (mode === 'full') {
  // Chat lives in the top-right corner (right of the Library button, below the
  // window min/max/close controls) — NOT in the top-left toolbar. Fixed to the
  // window edge so it stays clear of the frameless controls, which occupy the
  // top 30px of the right corner.
  document.body.appendChild(chatToggleBtn);
  setChatOpen(false);
} else {
  setChatOpen(chatOpen);
}
window.__setChatOpen__ = setChatOpen; // scenario/driver hook (e.g. draw-and-ask)

// AST dock (S6 UI). Collapsed by default; the canvas right-click dispatcher in
// mount.jsx opens it. It reads only through the rootless projectBridge IPC and
// never mutates the canvas. On open/close we toggle the .ast-open class.
if (mode !== 'chat-only') {
  const setAstOpen = (open) => astRoot.classList.toggle('ast-open', open);
  const astView = mountAstView(astRoot, {
    getGeneration: () => activeProjectGeneration,
    onOpen: () => setAstOpen(true),
    onClose: () => setAstOpen(false),
  });
  window.__astView__ = astView;
  // Hide the dock whenever the project is unlinked/cleared so stale anchors from
  // a previous project never linger.
  window.addEventListener('project:open-request', () => {
    setAstOpen(false);
    astView.reset();
  });
}

// Stress-test hooks (main.mjs drives them via executeJavaScript when
// scenario=stress-test). Dynamic import of the BUNDLED module — same module
// registry, so the same bridge/adapter instances.
if (mode !== 'chat-only' && window.__SCENARIO__ === 'stress-test') {
  import('./stress/run-stress.mjs').then(({ runStress, runStressCycle }) => {
    window.__runStress__ = runStress;
    window.__runStressCycle__ = runStressCycle;
  });
}

const themeBtn = document.createElement('button');
themeBtn.textContent = 'Theme';
themeBtn.onclick = () => toggleTheme();
toolbar.appendChild(themeBtn);

const linkBtn = document.createElement('button');
const archifyBtn = document.createElement('button');
archifyBtn.textContent = 'Archify';
archifyBtn.disabled = true;
const archifyCancelBtn = document.createElement('button');
archifyCancelBtn.textContent = 'Отменить';
archifyCancelBtn.className = 'archify-cancel';
archifyCancelBtn.style.display = 'none';
const archifyStatus = document.createElement('span');
archifyStatus.className = 'archify-status';
archifyStatus.style.display = 'none';
let activeProjectGeneration = null;
let generationRunning = false;
let generationCancelRequested = false;
let loadingProjectDocument = false;
let autosaveCaptureTimer = null;
// Content fingerprint: serializeExcalidrawDocument() excludes viewport,
// selection and zoom (appState whitelist = viewBackgroundColor + gridSize),
// so pan/zoom/selection-only changes produce identical documents. Hashing the
// serialized doc lets us skip needless disk writes for those events.
let lastAutosaveFingerprint = null;

// Deterministic FNV-1a hash over the serialized document JSON. Collisions were
// chosen to be practically impossible for scene docs, and the worst case would
// only mean dropping a redundant write (never a data loss).
function autosaveFingerprint(document) {
  const str = JSON.stringify(document);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

window.addEventListener('canvas:change', () => {
  if (loadingProjectDocument || activeProjectGeneration === null || !window.projectBridge?.queueAutosave) return;
  clearTimeout(autosaveCaptureTimer);
  autosaveCaptureTimer = setTimeout(() => {
    autosaveCaptureTimer = null;
    if (loadingProjectDocument || activeProjectGeneration === null) return;
    const document = serializeExcalidrawDocument();
    const fingerprint = autosaveFingerprint(document);
    if (fingerprint === lastAutosaveFingerprint) return;
    lastAutosaveFingerprint = fingerprint;
    void window.projectBridge.queueAutosave({
      generation: activeProjectGeneration,
      document,
    });
  }, 500);
});

const GENERATION_STAGE_LABELS = {
  snapshot: 'Фиксирую снимок проекта…',
  evidence: 'Изучаю файлы проекта…',
  author: 'Строю архитектуру…',
  repair: 'Исправляю результат…',
  preview: 'Готовлю preview…',
};

const GENERATION_ERROR_LABELS = {
  NO_API_KEY: 'Добавьте API-ключ в настройках чата.',
  NO_MODEL: 'Выберите модель в настройках чата.',
  ARCHIFY_SKILL_DISABLED: 'Включите Archify skill и повторите.',
  SKILL_DISABLED: 'Включите Archify skill и повторите.',
  TOOL_BUDGET_EXHAUSTED: 'Превышен лимит шагов модели. Повторите генерацию.',
  PROJECT_CHANGED: 'Проект изменился. Запустите генерацию ещё раз.',
  STALE_PROJECT: 'Открытый проект изменился. Запустите генерацию ещё раз.',
  CANCELLED: 'Генерация отменена.',
  GENERATION_FAILED: 'Не удалось построить архитектуру. Проверьте настройки и сеть.',
};

function generationErrorText(error) {
  const code = String(error?.code || 'GENERATION_FAILED');
  if (/^(HTTP_|NETWORK|TIMEOUT)/.test(code)) return 'Ошибка сети или API. Проверьте подключение и повторите.';
  return GENERATION_ERROR_LABELS[code] || error?.message || GENERATION_ERROR_LABELS.GENERATION_FAILED;
}

function setGenerationRunning(running) {
  generationRunning = running;
  archifyCancelBtn.style.display = running ? '' : 'none';
  archifyBtn.style.display = running ? 'none' : '';
  if (!running) generationCancelRequested = false;
}

async function cancelActiveGeneration() {
  if (!generationRunning || generationCancelRequested) return;
  generationCancelRequested = true;
  archifyCancelBtn.disabled = true;
  archifyStatus.style.display = '';
  archifyStatus.className = 'archify-status archify-status-muted';
  archifyStatus.textContent = 'Отменяю генерацию…';
  try { await window.archifyBridge.cancelGeneration(); }
  finally { archifyCancelBtn.disabled = false; }
}

// Renderer-side formation trace (DevTools console, F12). The main process already
// emits `[ARCHIFY-GEN]`/`[CHAT-STREAM]` to the terminal; this mirrors the UI stage
// and final outcome so the whole chain is visible from either console.
const uLog = (...parts) => { try { console.log('[ARCHIFY-UI]', ...parts); } catch {} };
const uErr = (...parts) => { try { console.error('[ARCHIFY-UI]', ...parts); } catch {} };

window.archifyBridge.onGenerationProgress?.((update) => {
  if (!generationRunning || generationCancelRequested) return;
  const label = GENERATION_STAGE_LABELS[update?.stage];
  if (label) {
    uLog('stage', update.stage, label);
    archifyStatus.textContent = label;
  }
});

archifyCancelBtn.addEventListener('click', cancelActiveGeneration);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && generationRunning) {
    event.preventDefault();
    void cancelActiveGeneration();
  }
});

async function activateOpenedProject(opened) {
  if (!opened?.ok) return;
  window.dispatchEvent(new CustomEvent('project:boundary', { detail: { reason: 'open' } }));
  bridge.use_command('canvas.clearProjectionState', {});
  activeProjectGeneration = opened.data.generation;
  lastAutosaveFingerprint = null;
  loadingProjectDocument = true;
  try {
    if (opened.data.document) loadExcalidrawDocument(opened.data.document);
    else emptyExcalidrawDocument();
  } finally {
    requestAnimationFrame(() => requestAnimationFrame(() => { loadingProjectDocument = false; }));
  }
  archifyStatus.style.display = '';
  archifyStatus.className = 'archify-status archify-status-ok';
  archifyStatus.textContent = opened.data.canvasExists ? `Открыт ${opened.data.canvasFileName}` : `Проект ${opened.data.projectName}: новый холст`;
  refreshToolbar();
}

window.addEventListener('project:open-request', async () => {
  await window.archifyBridge.cancelGeneration?.();
  clearTimeout(autosaveCaptureTimer);
  autosaveCaptureTimer = null;
  await window.projectBridge.flushAutosave?.();
  lastAutosaveFingerprint = null;
  const opened = await window.projectBridge.chooseDirectory();
  await activateOpenedProject(opened);
});

function refreshToolbar() {
  const status = bridge.query({ what: 'canvas.linkStatus' }).data;
  linkBtn.textContent = status.linked ? `Unlink (${status.projectId})` : 'Link project';
  const canRun = activeProjectGeneration !== null || (status.linked && !!status.specPath);
  archifyBtn.disabled = !canRun;
  archifyBtn.title = canRun
    ? `Archify-импорт из спецификации: ${status.specPath}`
    : 'Сначала привяжите холст к проекту (кнопка "Link project") — иначе archify-импорту не с чего работать.';
}

linkBtn.onclick = () => {
  const status = bridge.query({ what: 'canvas.linkStatus' }).data;
  if (status.linked) bridge.use_command('canvas.unlinkProject', {});
  else bridge.use_command('canvas.linkProject', { canvasId: 'demo-canvas' });
  // A link/unlink is a project boundary: drop any AST anchors from the previous
  // project so a stale component can never be expanded against the new root.
  window.dispatchEvent(new CustomEvent('project:boundary', { detail: { reason: status.linked ? 'unlink' : 'link' } }));
  if (window.__astView__) document.getElementById('ast-root')?.classList.remove('ast-open');
  refreshToolbar();
};

// S6-UI-1 + Round 32: build a non-mutating preview. Refresh consumes the old
// opaque token first, then re-runs validation/authoring and dispatches a new
// preview with a new token. The old plan can never be confirmed afterwards.
async function generateArchifyPreview({ replacePreviewToken = null } = {}) {
  if (replacePreviewToken) {
    const cancelled = bridge.use_command('canvas.cancelArchifyProjection', { previewToken: replacePreviewToken });
    if (!cancelled?.ok || !cancelled?.data?.cancelled) {
      return { ok: false, error: cancelled?.error || { code: 'REFRESH_CANCEL_FAILED', message: 'Не удалось отменить предыдущий preview' } };
    }
  }
  uLog('generate start', replacePreviewToken ? 'refresh' : 'fresh', 'generation=' + activeProjectGeneration);
  archifyStatus.style.display = '';
  archifyStatus.className = 'archify-status archify-status-muted';
  archifyStatus.textContent = replacePreviewToken ? 'Обновляю архитектуру…' : 'Строю архитектуру…';
  setGenerationRunning(activeProjectGeneration !== null);
  try {
    const status = bridge.query({ what: 'canvas.linkStatus' }).data;
    const validated = activeProjectGeneration !== null
      ? await window.archifyBridge.generateProject({
          generation: activeProjectGeneration,
          tools: bridge.list_commands().data.commands
            .filter((c) => !c.notForChat && (c.name.startsWith('project.') || c.name.startsWith('archify.')))
            .map((c) => ({ name: c.name, description: c.description, input_schema: c.inputSchema })),
        })
      : await window.archifyBridge.validate(status.specPath);
    if (!validated || !validated.ok) throw Object.assign(new Error(validated?.error?.message || 'Archify validate failed'), validated?.error || {});
    uLog('generate ok', JSON.stringify({
      components: validated.data?.ir?.components?.length, connections: validated.data?.ir?.connections?.length,
      projectReadCount: validated.data?.generationProof?.projectReadCount, usedConfiguredModel: validated.data?.generationProof?.usedConfiguredModel,
    }));
    const preview = bridge.use_command('canvas.previewArchifyProjection', {
      ir: validated.data.ir,
      mode: 'replace',
      projectContext: validated.data.projectContext || null,
      skillContext: validated.data.skillContext || null,
    });
    if (!preview || !preview.ok) throw new Error(preview?.error?.message || 'Projection preview failed');
    uLog('preview ok', JSON.stringify({ counts: preview.data?.counts, token: preview.data?.previewToken }));
    archifyStatus.className = 'archify-status archify-status-muted';
    archifyStatus.textContent = 'Ожидает подтверждения';
    showArchifyProjectionPreview({
      preview: preview.data,
      onRegenerate: async (previewToken) => generateArchifyPreview({ replacePreviewToken: previewToken }),
      onConfirm: async (previewToken) => {
        const result = bridge.use_command('canvas.confirmArchifyProjection', { previewToken });
        const receipt = result?.data?.receipt;
        if (result?.ok && result?.data?.applied && activeProjectGeneration !== null) {
          const saved = await window.projectBridge.saveCanvas({ generation: activeProjectGeneration, document: serializeExcalidrawDocument() });
          if (!saved?.ok) {
            archifyStatus.className = 'archify-status archify-status-err';
            archifyStatus.textContent = `Холст применён, но не сохранён: ${saved?.error?.message || 'ошибка'}`;
            return { ...result, save: saved };
          }
        }
        archifyStatus.className = result?.ok && !result?.data?.error ? 'archify-status archify-status-ok' : 'archify-status archify-status-err';
        archifyStatus.textContent = receipt?.status === 'applied'
          ? `Готово: ${receipt.counts?.components || 0} узлов, ${receipt.counts?.connections || 0} связей.`
          : `Результат: ${receipt?.status || result?.error?.message || 'ошибка'}`;
        return result;
      },
      onCancel: async (previewToken) => {
        const result = bridge.use_command('canvas.cancelArchifyProjection', { previewToken });
        archifyStatus.className = 'archify-status archify-status-muted';
        archifyStatus.textContent = 'Импорт отменён';
        return result;
      },
    });
    return { ok: true, data: {
      previewToken: preview.data.previewToken,
      refreshed: !!replacePreviewToken,
      generationProof: validated.data.generationProof || null,
    } };
  } catch (e) {
    const error = { code: e?.code || 'GENERATION_FAILED', message: String((e && e.message) || e) };
    uErr('generate FAILED', JSON.stringify(error));
    archifyStatus.className = error.code === 'CANCELLED' ? 'archify-status archify-status-muted' : 'archify-status archify-status-err';
    archifyStatus.textContent = generationErrorText(error);
    return { ok: false, error };
  } finally {
    setGenerationRunning(false);
  }
}

archifyBtn.addEventListener('click', async () => {
  refreshToolbar();
  if (archifyBtn.disabled) return;
  archifyBtn.disabled = true;
  try { await generateArchifyPreview(); }
  finally { refreshToolbar(); }
});

// Narrow acceptance hooks: only present in the explicit saved-chat scenario.
// They exercise the same renderer → preload → main production path as the UI.
if (window.__SCENARIO__ === 'saved-chat-generation') {
  window.__activateOpenedProjectForProof__ = activateOpenedProject;
  window.__generateArchifyPreviewForProof__ = generateArchifyPreview;
}

refreshToolbar();
toolbar.appendChild(linkBtn);
toolbar.appendChild(archifyBtn);
toolbar.appendChild(archifyCancelBtn);
toolbar.appendChild(archifyStatus);

// Frameless window: custom minimize/maximize/close cluster in the top-right
// corner (the native title bar and menu bar are gone — see main.mjs).
if (window.windowControls) {
  const cluster = document.createElement('div');
  cluster.className = 'window-controls';
  const winButton = (className, text, title, onClick) => {
    const b = document.createElement('button');
    b.className = `win-btn ${className}`;
    b.textContent = text;
    b.title = title;
    b.onclick = onClick;
    return b;
  };
  cluster.appendChild(winButton('win-min', '\u2014', 'Свернуть', window.windowControls.minimize));
  cluster.appendChild(winButton('win-max', '\u25A1', 'Развернуть / восстановить', window.windowControls.toggleMaximize));
  cluster.appendChild(winButton('win-close', '\u2715', 'Закрыть', window.windowControls.close));
  document.body.appendChild(cluster);
}

window.__bridge__ = bridge; // exposed for the electron-driven smoke test only
// Raw scene view for acceptance runs (archify-import scenario): fields the
// public query surface deliberately does not expose. Test-only, like __bridge__.
window.__canvasRaw__ = { elements: _getRawElements, selectedIds: _getSelectedIds, sceneToViewport: _sceneToViewport };
// Acceptance-only serializer (AST-anchor + isolation scenarios). Mirrors the app's
// real save path: the SAME serializeExcalidrawDocument the autosave/save uses.
window.__serialize__ = serializeExcalidrawDocument;
window.__loadDocument__ = loadExcalidrawDocument;
window.__toggleTheme__ = toggleTheme; // must call the SAME bundled module instance,
// not a fresh dynamic import() of the source file (which would create a second,
// disconnected theme store — that was the original bug here).
window.__setTheme__ = setTheme; // explicit + idempotent, used by main.mjs —
// unlike a toggle it does not depend on what the renderer's current default is.
window.__ready__ = true;

// Stream A: the main process delegates tool execution to the renderer because
// only the renderer owns the canvas/bridge (and Excalidraw). Respond to each
// tool request by running the real command through the bridge and sending the
// result back as a tool_result.
if (window.chatBridge && window.chatBridge.onToolRequest) {
  window.chatBridge.onToolRequest((req, respond) => {
    try {
      respond(bridge.use_command(req.name, req.input || {}));
    } catch (e) {
      respond({ ok: false, error: { code: 'THROW', message: String((e && e.message) || e) } });
    }
  });

  // S4.2: consume the per-turn run receipt emitted by the main process. It is
  // purely diagnostic surface (stable public identity only — no secrets/paths),
  // exposed on window for the acceptance harness and for future UI chips.
  if (window.chatBridge.onRunReceipt) {
    window.chatBridge.onRunReceipt((receipt) => {
      window.__lastRunReceipt__ = receipt;
    });
  }
}
