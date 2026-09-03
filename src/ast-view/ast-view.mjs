// Rootless AST workspace. Source reads remain bounded and main-owned.
import {
  createState, openTab, activateTab, closeTab, setScope, clearTabs, SCOPES,
  setTabStatus, statusFromGraph, toggleExpandedFile, selectSymbol, rememberScroll,
  setPinned, setDockWidth, refreshStaleTab,
} from './ast-view-state.mjs';
import {
  setAstScope, clearAstScope, getAstScope, registerAstFrameHost, onAstFocusRequest,
  threadIdForTab, SCOPE_MAX_LINES,
} from '../bridge/ast-scope-store.mjs';
import { applyProposedEdit, describeEdit, selectionToLineRange } from './ast-edit-patch.mjs';

const SCOPES_LABEL = { own: 'Сам узел', l1: 'Связи · 1 уровень', l2: 'Связи · 2 уровня' };
const STATUS_LABEL = { idle: 'Ожидание', loading: 'Загрузка', ready: 'Готово', stale: 'Устарело', partial: 'Частично', unsupported: 'Не поддерживается', error: 'Ошибка' };
const PREVIEW_MAX_LINES = 200;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountAstView(containerEl, options = {}) {
  const state = createState();
  const bridge = window.projectBridge;
  const { getGeneration } = options;
  containerEl.innerHTML = '';
  const dock = el('div', 'ast-dock');
  dock.setAttribute('role', 'dialog');
  dock.setAttribute('aria-label', 'AST рабочая область');
  dock.setAttribute('aria-modal', 'true');
  const resizer = el('div', 'ast-resizer');
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-label', 'Изменить ширину AST');
  resizer.tabIndex = 0;
  const header = el('div', 'ast-header');
  header.appendChild(el('span', 'ast-title', 'AST Inspector'));
  const actions = el('div', 'ast-header-actions');
  const pinBtn = el('button', 'ast-gear ast-pin', 'Закрепить');
  pinBtn.setAttribute('aria-pressed', 'false');
  const closeBtn = el('button', 'ast-gear ast-close', '✕');
  closeBtn.title = 'Свернуть AST'; closeBtn.setAttribute('aria-label', 'Свернуть AST');
  actions.append(pinBtn, closeBtn); header.appendChild(actions);
  const tabsBar = el('div', 'ast-tabs');
  const body = el('div', 'ast-body');
  dock.append(resizer, header, tabsBar, body); containerEl.appendChild(dock);

  let returnFocus = null;
  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeId) || null;
  function saveScroll() { const tab = activeTab(); if (tab) rememberScroll(tab, body.scrollTop); }
  body.addEventListener('scroll', saveScroll, { passive: true });

  // --- Сквозное позиционирование -----------------------------------------
  // Оператор → агент: askChat() публикует scope (файл/символ/строки) в
  // единственный чат — отдельного чата в каждом фрейме НЕТ.
  // Агент → оператор: focusTarget ставит фрейм на нужное место и подсвечивает
  // строки. В scope всегда уходят ТОЛЬКО границы: тело файла агент добирает
  // astFrame.readScope, иначе payload раздувается так же, как в циклах генерации.
  let focusTarget = null;

  function tabByRel(rel) {
    const current = activeTab();
    if (current && (current.graph?.files || []).some((file) => file.rel === rel)) return current;
    return state.tabs.find((tab) => (tab.graph?.files || []).some((file) => file.rel === rel)) || null;
  }

  function fileByRel(tab, rel) {
    return (tab?.graph?.files || []).find((file) => file.rel === rel) || null;
  }

  function askChat(tab, rel, extra = {}) {
    const file = fileByRel(tab, rel);
    setAstScope({
      tabId: tab.id,
      rel,
      symbol: extra.symbol || null,
      startLine: extra.startLine ?? null,
      endLine: extra.endLine ?? null,
      totalLines: extra.totalLines ?? file?.lines ?? null,
      astAnchor: tab.context?.astAnchor || null,
      snapshot: tab.context?.snapshot || null,
      scopeLevel: tab.activeScope,
    });
    window.__setChatOpen__?.(true);
    renderAll();
  }

  function askChatButton(tab, rel, extra = {}, label = 'Спросить чат') {
    const button = el('button', 'ast-ask-btn', label);
    button.title = 'Передать этот файл и строки в чат как текущий контекст';
    button.onclick = (event) => { event.stopPropagation(); askChat(tab, rel, extra); };
    return button;
  }

  function scrollToRel(rel) {
    requestAnimationFrame(() => {
      const card = body.querySelector(`[data-rel="${CSS.escape(rel)}"]`);
      card?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      card?.querySelector('.ast-code-mark')?.scrollIntoView({ block: 'nearest' });
    });
  }

  // Подсветка диапазона строк без innerHTML: тело файла — недоверенный текст.
  function codeWithHighlight(text, baseLine, from, to) {
    const pre = el('pre', 'ast-listing-code');
    const lines = String(text || '').split('\n');
    const start = Math.max(0, (from || 1) - (baseLine || 1));
    if (!from || start >= lines.length) { pre.textContent = String(text || ''); return pre; }
    const end = Math.min(lines.length - 1, Math.max(start, (to || from) - (baseLine || 1)));
    const headText = lines.slice(0, start).join('\n');
    if (headText) pre.appendChild(document.createTextNode(`${headText}\n`));
    pre.appendChild(el('mark', 'ast-code-mark', lines.slice(start, end + 1).join('\n')));
    const tail = lines.slice(end + 1);
    if (tail.length) pre.appendChild(document.createTextNode(`\n${tail.join('\n')}`));
    return pre;
  }

  function onClose() {
    saveScroll();
    if (typeof options.onClose === 'function') options.onClose();
    const target = returnFocus; returnFocus = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus();
  }
  closeBtn.addEventListener('click', onClose);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && containerEl.classList.contains('ast-open')) { event.preventDefault(); onClose(); }
  });

  function applyPinned() {
    containerEl.classList.toggle('ast-pinned', state.pinned);
    containerEl.style.setProperty('--ast-dock-width', `${state.width}px`);
    dock.setAttribute('aria-modal', state.pinned ? 'false' : 'true');
    pinBtn.textContent = state.pinned ? 'Открепить' : 'Закрепить';
    pinBtn.setAttribute('aria-pressed', String(state.pinned));
  }
  pinBtn.addEventListener('click', () => { setPinned(state, !state.pinned); applyPinned(); });
  let resizeStart = null;
  resizer.addEventListener('pointerdown', (event) => {
    if (!state.pinned) return;
    resizeStart = { x: event.clientX, width: state.width };
    resizer.setPointerCapture?.(event.pointerId);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!resizeStart) return;
    setDockWidth(state, resizeStart.width + resizeStart.x - event.clientX); applyPinned();
  });
  const stopResize = () => { resizeStart = null; };
  resizer.addEventListener('pointerup', stopResize); resizer.addEventListener('pointercancel', stopResize);
  resizer.addEventListener('keydown', (event) => {
    if (!state.pinned || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); setDockWidth(state, state.width + (event.key === 'ArrowLeft' ? 24 : -24)); applyPinned();
  });

  async function loadGraph(tab) {
    const ctx = tab.context;
    if (!ctx || !bridge) { setTabStatus(tab, 'error', 'Нет контекста для развёртывания'); renderAll(); return; }
    const requestId = (tab.requestId || 0) + 1; tab.requestId = requestId;
    setTabStatus(tab, 'loading'); renderAll();
    try {
      const res = await bridge.expandAstAnchor({
        generation: getGeneration ? getGeneration() : ctx.generation,
        projectNodeId: tab.id, expectedSnapshot: ctx.snapshot,
        scope: tab.activeScope, astAnchor: ctx.astAnchor,
      });
      if (requestId !== tab.requestId) return;
      if (!res?.ok) {
        const code = res?.error?.code;
        setTabStatus(tab, code === 'UNSUPPORTED_LANGUAGE' ? 'unsupported' : code === 'STALE_PROJECT' ? 'stale' : 'error', res?.error?.message || 'Ошибка развёртывания');
      } else {
        tab.graph = res.data;
        tab.listings = {};
        setTabStatus(tab, statusFromGraph(res.data));
        await loadListingCollection(tab, requestId);
      }
    } catch (error) {
      if (requestId === tab.requestId) setTabStatus(tab, 'error', String(error?.message || error));
    } finally {
      if (requestId === tab.requestId) { tab.loading = false; renderAll(); }
    }
  }

  async function loadPreview(tab, rel, opts = {}) {
    const ctx = tab.context;
    if (!ctx || !bridge) return { error: 'Нет контекста' };
    const res = await bridge.readAstPreview({
      generation: getGeneration ? getGeneration() : ctx.generation,
      projectNodeId: tab.id, expectedSnapshot: ctx.snapshot, scope: tab.activeScope,
      astAnchor: ctx.astAnchor, rel, startLine: opts.startLine, endLine: opts.endLine, maxLines: opts.maxLines,
    });
    if (!res?.ok) return { error: res?.error?.message || 'Ошибка предпросмотра' };
    if (res.data.stale) setTabStatus(tab, 'stale');
    return { data: res.data };
  }

  async function loadListingCollection(tab, requestId) {
    const files = (tab.graph?.files || []).slice(0, 30);
    tab.listingLoading = true;
    const results = await Promise.all(files.map(async (file) => [
      file.rel,
      await loadPreview(tab, file.rel, { maxLines: PREVIEW_MAX_LINES }),
    ]));
    if (requestId !== tab.requestId) return;
    tab.listings = Object.fromEntries(results);
    tab.listingLoading = false;
  }

  async function saveEditedFile(tab, rel, content) {
    const ctx = tab.context;
    if (!ctx || !bridge?.writeAstFile) return { error: 'Редактирование недоступно' };
    const res = await bridge.writeAstFile({
      generation: getGeneration ? getGeneration() : ctx.generation,
      projectNodeId: tab.id,
      expectedSnapshot: ctx.snapshot,
      scope: tab.activeScope,
      astAnchor: ctx.astAnchor,
      rel,
      content,
    });
    if (!res?.ok) return { error: res?.error?.message || 'Не удалось сохранить файл', code: res?.error?.code };
    ctx.snapshot = res.data.snapshot;
    if (tab.graph) tab.graph.snapshot = res.data.snapshot;
    return { data: res.data };
  }

  function openPreviewPane(tab, rel, result) {
    tab.preview = { rel, result };
    renderAll();
  }

  function renderPreview(tab) {
    if (!tab.preview) return null;
    const { rel, result } = tab.preview;
    const pane = el('section', 'ast-preview');
    const head = el('div', 'ast-preview-head'); head.appendChild(el('span', 'ast-preview-rel', rel));
    const close = el('button', 'ast-gear', '✕'); close.setAttribute('aria-label', 'Закрыть предпросмотр');
    close.onclick = () => { tab.preview = null; renderAll(); }; head.appendChild(close); pane.appendChild(head);
    if (result.error) { pane.appendChild(el('div', 'ast-preview-error', result.error)); return pane; }
    const data = result.data;
    const metaRow = el('div', 'ast-preview-toolbar');
    const meta = el('div', 'ast-preview-meta', `строки ${data.startLine}–${data.endLine} из ${data.totalLines}`);
    metaRow.appendChild(meta);
    metaRow.appendChild(askChatButton(tab, rel, { startLine: data.startLine, endLine: data.endLine, totalLines: data.totalLines }));
    const complete = data.startLine === 1 && data.endLine >= data.totalLines && !data.byteTruncated;
    if (complete && !tab.editor) {
      const edit = el('button', 'ast-edit-btn', 'Редактировать');
      edit.onclick = () => { tab.editor = { rel, value: data.body, saving: false, error: null }; renderAll(); };
      metaRow.appendChild(edit);
    }
    pane.appendChild(metaRow);
    if (tab.editor?.rel === rel) {
      const editor = el('div', 'ast-editor');
      const area = el('textarea', 'ast-editor-area');
      area.value = tab.editor.value;
      area.setAttribute('aria-label', `Редактор ${rel}`);
      // Ручная правка снимает пометку «предложено агентом»: дальше это уже текст человека.
      area.oninput = () => { tab.editor.value = area.value; tab.editor.pending = null; };
      const pending = tab.editor.pending;
      const status = el(
        'div',
        `ast-editor-status${pending ? ' ast-editor-pending' : ''}`,
        tab.editor.error
          || (pending
            ? `Правку предложил агент (${pending.mode === 'patch' ? 'патч' : 'файл целиком'}, ${pending.summary}) — проверьте и сохраните.${pending.note ? ` Комментарий: ${pending.note}` : ''}`
            : 'Изменения будут записаны в файл проекта.'),
      );
      const actions = el('div', 'ast-editor-actions');
      // Из редактора в чат уходят только ГРАНИЦЫ выделения, не текст.
      const askSelection = el('button', 'ast-ask-btn', 'Спросить чат о выделении');
      askSelection.onclick = () => {
        const range = selectionToLineRange(area.value, area.selectionStart, area.selectionEnd, data.startLine);
        askChat(tab, rel, {
          startLine: range?.startLine ?? data.startLine,
          endLine: range?.endLine ?? data.endLine,
          totalLines: data.totalLines,
        });
      };
      actions.appendChild(askSelection);
      if (pending) {
        const reject = el('button', 'ast-editor-cancel', 'Отклонить правку');
        reject.title = 'Вернуть текст, какой был до предложения агента';
        reject.onclick = () => { tab.editor.value = pending.before; tab.editor.pending = null; renderAll(); };
        actions.appendChild(reject);
      }
      const cancel = el('button', 'ast-editor-cancel', 'Отмена');
      cancel.onclick = () => { tab.editor = null; renderAll(); };
      const save = el('button', 'ast-editor-save', tab.editor.saving ? 'Сохраняю…' : 'Сохранить');
      save.disabled = tab.editor.saving;
      save.onclick = async () => {
        tab.editor.saving = true; tab.editor.error = null; renderAll();
        const saved = await saveEditedFile(tab, rel, tab.editor.value);
        if (saved.error) {
          tab.editor.saving = false; tab.editor.error = saved.error;
          if (saved.code === 'STALE_PROJECT') setTabStatus(tab, 'stale');
          renderAll(); return;
        }
        tab.editor = null;
        tab.preview = null;
        await loadGraph(tab);
      };
      actions.append(cancel, save); editor.append(area, status, actions); pane.appendChild(editor);
    } else {
      const code = el('pre', 'ast-code', data.body); pane.appendChild(code);
    }
    if (data.nextStartLine && data.returnedLines < PREVIEW_MAX_LINES) {
      const more = el('button', 'ast-load-more', 'Загрузить больше');
      more.onclick = async () => {
        more.disabled = true;
        const remaining = PREVIEW_MAX_LINES - data.returnedLines;
        const next = await loadPreview(tab, rel, { startLine: data.nextStartLine, maxLines: remaining });
        if (next?.data) {
          data.body += (data.body && next.data.body ? '\n' : '') + next.data.body;
          data.endLine = next.data.endLine; data.returnedLines += next.data.returnedLines; data.nextStartLine = next.data.nextStartLine;
          renderAll();
        } else { more.disabled = false; }
      };
      pane.appendChild(more);
    }
    return pane;
  }

  function renderTabs() {
    tabsBar.innerHTML = '';
    for (const tab of state.tabs) {
      const button = el('button', `ast-tab${tab.id === state.activeId ? ' ast-tab-active' : ''}`, tab.id);
      button.setAttribute('aria-selected', String(tab.id === state.activeId));
      button.onclick = () => { saveScroll(); if (activateTab(state, tab.id)) renderAll(); };
      const mark = el('span', `ast-tab-state ast-state-${tab.status}`, '●'); mark.title = STATUS_LABEL[tab.status];
      const x = el('span', 'ast-tab-x', '✕');
      x.onclick = (event) => {
        event.stopPropagation();
        closeTab(state, tab.id);
        // Закрыли фрейм — отпускаем и scope, иначе чат остался бы в треде закрытого таба.
        if (getAstScope()?.tabId === tab.id) clearAstScope();
        if (focusTarget && !tabByRel(focusTarget.rel)) focusTarget = null;
        renderAll();
      };
      button.prepend(mark); button.appendChild(x); tabsBar.appendChild(button);
    }
  }

  function renderScopes(tab) {
    const wrap = el('div', 'ast-scopes');
    for (const scope of SCOPES) {
      const button = el('button', `ast-scope${scope === tab.activeScope ? ' ast-scope-active' : ''}`, SCOPES_LABEL[scope]);
      button.onclick = () => { saveScroll(); setScope(state, tab.id, scope); tab.preview = null; void loadGraph(tab); };
      wrap.appendChild(button);
    }
    return wrap;
  }

  function renderStatus(tab) {
    if (!['stale', 'partial', 'unsupported'].includes(tab.status)) return null;
    const box = el('div', `ast-status ast-status-${tab.status}`);
    const text = tab.status === 'stale' ? 'Снимок проекта изменился.' : tab.status === 'partial' ? 'Показана только доступная часть графа.' : 'Часть файлов пока не поддерживается AST-адаптером.';
    box.appendChild(el('span', '', text));
    if (tab.status === 'stale') {
      const refresh = el('button', 'ast-refresh', 'Обновить');
      refresh.onclick = () => { if (refreshStaleTab(tab)) void loadGraph(tab); };
      box.appendChild(refresh);
    }
    return box;
  }

  function graphLayout(graph) {
    const byId = new Map(graph.files.map((file) => [file.id, file]));
    const incoming = new Map(graph.files.map((file) => [file.id, 0]));
    for (const edge of graph.edges) if (incoming.has(edge.target)) incoming.set(edge.target, incoming.get(edge.target) + 1);
    const level = new Map();
    const queue = graph.files.filter((file) => incoming.get(file.id) === 0).map((file) => file.id);
    if (!queue.length && graph.files[0]) queue.push(graph.files[0].id);
    for (const id of queue) level.set(id, 0);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      for (const edge of graph.edges.filter((item) => item.source === id)) {
        if (!byId.has(edge.target)) continue;
        const next = Math.min(6, (level.get(id) || 0) + 1);
        if (!level.has(edge.target) || next > level.get(edge.target)) {
          level.set(edge.target, next); queue.push(edge.target);
        }
      }
    }
    for (const file of graph.files) if (!level.has(file.id)) level.set(file.id, 0);
    const rows = new Map();
    const positions = new Map();
    for (const file of graph.files) {
      const column = level.get(file.id) || 0;
      const row = rows.get(column) || 0;
      rows.set(column, row + 1);
      positions.set(file.id, { x: 36 + column * 430, y: 36 + row * 354 });
    }
    const columns = Math.max(1, ...[...level.values()].map((value) => value + 1));
    const maxRows = Math.max(1, ...rows.values());
    return { positions, width: Math.max(900, 36 + columns * 430), height: Math.max(560, 36 + maxRows * 354) };
  }

  function renderGraph(tab) {
    const wrap = el('div', 'ast-graph');
    if (tab.loading) { wrap.appendChild(el('div', 'ast-muted', 'Разворачиваю граф и листинги…')); return wrap; }
    if (tab.error) { wrap.appendChild(el('div', 'ast-error', tab.error)); return wrap; }
    const graph = tab.graph;
    if (!graph) { wrap.appendChild(el('div', 'ast-muted', 'Разверните компонент, чтобы увидеть AST.')); return wrap; }
    const info = el('div', 'ast-graph-info', `Листингов: ${graph.files.length} · Связей: ${graph.edges.length}`);
    wrap.appendChild(info);
    const shell = el('div', 'ast-canvas-shell');
    const stage = el('div', 'ast-canvas-stage');
    const layout = graphLayout(graph);
    stage.style.width = `${layout.width}px`; stage.style.height = `${layout.height}px`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ast-canvas-edges');
    svg.setAttribute('width', String(layout.width)); svg.setAttribute('height', String(layout.height));
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'ast-arrow'); marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7'); marker.setAttribute('orient', 'auto-start-reverse');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); marker.appendChild(arrow); defs.appendChild(marker); svg.appendChild(defs);
    for (const edge of graph.edges) {
      const from = layout.positions.get(edge.source); const to = layout.positions.get(edge.target);
      if (!from || !to) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const sx = from.x + 360, sy = from.y + 145, tx = to.x, ty = to.y + 145;
      const bend = Math.max(70, Math.abs(tx - sx) * .45);
      path.setAttribute('d', `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`);
      path.setAttribute('class', 'ast-canvas-edge'); path.setAttribute('marker-end', 'url(#ast-arrow)');
      svg.appendChild(path);
    }
    stage.appendChild(svg);

    for (const file of graph.files) {
      const pos = layout.positions.get(file.id);
      const listing = tab.listings?.[file.rel];
      const card = el('article', 'ast-listing-card');
      card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`; card.dataset.rel = file.rel;
      const head = el('div', 'ast-listing-head');
      head.append(el('span', `ast-language-dot ast-lang-${file.language || 'text'}`), el('span', 'ast-listing-rel', file.rel), el('span', 'ast-file-lines', `${file.lines} строк`));
      card.appendChild(head);
      const symbols = el('div', 'ast-listing-symbols');
      for (const symbol of (file.symbols || []).slice(0, 8)) {
        // Символ — самая точная единица разговора, поэтому клик по чипу сразу
        // ставит его в scope единственного чата.
        const chip = el('button', 'ast-symbol-chip', `${symbol.kind} ${symbol.name}`);
        chip.title = 'Обсудить этот символ в чате';
        chip.onclick = (event) => {
          event.stopPropagation();
          askChat(tab, file.rel, {
            symbol: symbol.name,
            startLine: symbol.startLine ?? symbol.line ?? null,
            endLine: symbol.endLine ?? symbol.line ?? null,
            totalLines: file.lines,
          });
        };
        symbols.appendChild(chip);
      }
      if (!file.symbols?.length) symbols.appendChild(el('span', 'ast-listing-empty', file.supported === false ? 'AST не поддерживается' : 'Нет объявлений'));
      card.appendChild(symbols);
      const focused = focusTarget?.rel === file.rel;
      if (focused) card.classList.add('ast-listing-focus');
      let code;
      if (tab.listingLoading && !listing) code = el('pre', 'ast-listing-code', 'Загружаю листинг…');
      else if (listing?.error) code = el('pre', 'ast-listing-code', listing.error);
      else if (focused && focusTarget.startLine) {
        // Агент → оператор: подсветка ровно тех строк, про которые говорит чат.
        code = codeWithHighlight(listing?.data?.body || '', listing?.data?.startLine || 1, focusTarget.startLine, focusTarget.endLine);
      } else code = el('pre', 'ast-listing-code', listing?.data?.body || '‹пустой файл›');
      card.appendChild(code);
      if (focused && focusTarget.note) card.appendChild(el('div', 'ast-focus-note', `Агент: ${focusTarget.note}`));
      const foot = el('div', 'ast-listing-foot');
      const language = el('span', 'ast-listing-language', file.language || file.adapter || 'text');
      const open = el('button', 'ast-preview-btn', 'Открыть');
      open.onclick = async () => openPreviewPane(tab, file.rel, listing || await loadPreview(tab, file.rel, { maxLines: PREVIEW_MAX_LINES }));
      foot.append(language, open, askChatButton(tab, file.rel, { totalLines: listing?.data?.totalLines ?? file.lines }));
      const complete = listing?.data && listing.data.startLine === 1 && listing.data.endLine >= listing.data.totalLines && !listing.data.byteTruncated;
      if (complete) {
        const edit = el('button', 'ast-card-edit', 'Редактировать');
        edit.onclick = () => {
          tab.preview = { rel: file.rel, result: listing };
          tab.editor = { rel: file.rel, value: listing.data.body, saving: false, error: null };
          renderAll();
        };
        foot.appendChild(edit);
      }
      card.appendChild(foot); stage.appendChild(card);
    }
    shell.appendChild(stage); wrap.appendChild(shell);
    return wrap;
  }

  function renderAll() {
    const scroll = activeTab()?.scrollTop || 0;
    renderTabs(); body.innerHTML = '';
    const tab = activeTab();
    if (!tab) body.appendChild(el('div', 'ast-empty', 'Щёлкните по Archify-компоненту или выберите ПКМ → «Развернуть AST».'));
    else {
      body.appendChild(renderScopes(tab));
      const status = renderStatus(tab); if (status) body.appendChild(status);
      body.appendChild(renderGraph(tab));
      const preview = renderPreview(tab); if (preview) body.appendChild(preview);
    }
    requestAnimationFrame(() => { body.scrollTop = scroll; });
  }

  window.addEventListener('canvas:node-context', (event) => {
    const detail = event.detail || {}; if (!detail.sourceElementId) return;
    returnFocus = detail.returnFocus?.isConnected ? detail.returnFocus : document.activeElement;
    const context = { sourceElementId: detail.sourceElementId, astAnchor: detail.astAnchor, snapshot: detail.snapshot || null, generation: detail.generation || (getGeneration ? getGeneration() : null) };
    const tab = openTab(state, detail.sourceElementId, context); setScope(state, tab.id, 'own');
    if (typeof options.onOpen === 'function') options.onOpen(detail.sourceElementId);
    if (!detail.astAnchor) {
      setTabStatus(tab, 'error', 'У этого сохранённого узла нет AST-привязки. Откройте проект и заново выполните Archify, затем повторите «Развернуть AST».');
      renderAll();
    } else {
      void loadGraph(tab);
    }
    queueMicrotask(() => closeBtn.focus());
  });
  const reset = () => { clearTabs(state); clearAstScope(); focusTarget = null; renderAll(); };
  window.addEventListener('project:boundary', reset);
  window.addEventListener('canvas:cleared', reset);
  // --- Хост для инструментов astFrame.* ---------------------------------
  // Реестр команд видит только этот интерфейс — ни DOM дока, ни state,
  // ни projectBridge наружу не утекают.
  const frameHost = {
    listFrames: () => state.tabs.map((tab) => ({
      tabId: tab.id,
      threadId: threadIdForTab(tab.id),
      active: tab.id === state.activeId,
      status: tab.status,
      scopeLevel: tab.activeScope,
      files: (tab.graph?.files || []).map((file) => ({ rel: file.rel, lines: file.lines, language: file.language || null })),
    })),
    readScope: async ({ rel, startLine, endLine } = {}) => {
      const scope = getAstScope();
      const target = rel || scope?.rel;
      if (!target) throw Object.assign(new Error('Не указан rel, а у оператора нет активного scope.'), { code: 'BAD_INPUT' });
      const tab = tabByRel(target);
      if (!tab) throw Object.assign(new Error(`Файл ${target} не открыт ни в одном AST-фрейме.`), { code: 'NOT_IN_FRAME' });
      const sameFile = !rel || rel === scope?.rel;
      const from = startLine || (sameFile ? scope?.startLine : null) || 1;
      const to = endLine || (sameFile ? scope?.endLine : null) || null;
      const maxLines = Math.min(SCOPE_MAX_LINES, to ? Math.max(1, to - from + 1) : SCOPE_MAX_LINES);
      const res = await loadPreview(tab, target, { startLine: from, endLine: to || undefined, maxLines });
      if (res.error) throw Object.assign(new Error(res.error), { code: 'PREVIEW_FAILED' });
      const data = res.data;
      return {
        rel: target, tabId: tab.id, startLine: data.startLine, endLine: data.endLine,
        totalLines: data.totalLines, truncated: !!data.byteTruncated || !!data.nextStartLine,
        body: data.body,
      };
    },
    proposeEdit: async ({ rel, oldStr, newStr, content, note } = {}) => {
      if (!rel) throw Object.assign(new Error('rel обязателен.'), { code: 'BAD_INPUT' });
      const tab = tabByRel(rel);
      if (!tab) throw Object.assign(new Error(`Файл ${rel} не открыт ни в одном AST-фрейме.`), { code: 'NOT_IN_FRAME' });
      // Патч считаем от ПОЛНОГО текста: правка по обрезанному листингу
      // молча испортила бы хвост файла.
      const cached = tab.listings?.[rel];
      const listing = cached?.data && cached.data.startLine === 1 && !cached.data.nextStartLine
        ? cached
        : await loadPreview(tab, rel, { startLine: 1, maxLines: PREVIEW_MAX_LINES });
      if (listing.error) throw Object.assign(new Error(listing.error), { code: 'PREVIEW_FAILED' });
      const data = listing.data;
      if (data.byteTruncated || data.nextStartLine || data.endLine < data.totalLines) {
        throw Object.assign(
          new Error(`Фаил ${rel} длиннее ${PREVIEW_MAX_LINES} строк — целиком его редактор не держит. Позовите оператора через astFrame.revealAt и опишите правку.`),
          { code: 'FILE_TOO_LARGE' },
        );
      }
      const before = tab.editor?.rel === rel ? tab.editor.value : data.body;
      const applied = applyProposedEdit(before, { oldStr, newStr, content });
      if (!applied.ok) throw Object.assign(new Error(applied.error.message), { code: applied.error.code });
      const summary = describeEdit(before, applied.value);
      tab.preview = { rel, result: listing };
      tab.editor = {
        rel, value: applied.value, saving: false, error: null,
        pending: { mode: applied.mode, note: note || null, before, summary },
      };
      if (state.activeId !== tab.id) { saveScroll(); activateTab(state, tab.id); }
      focusTarget = { rel, startLine: null, endLine: null, symbol: null, note: note || null };
      if (typeof options.onOpen === 'function') options.onOpen(tab.id);
      renderAll();
      scrollToRel(rel);
      // written: false — главное в ответе: модель не должна решить, что файл уже на диске.
      return { rel, tabId: tab.id, mode: applied.mode, summary, written: false, awaitingOperator: true };
    },
  };
  const unregisterFrameHost = registerAstFrameHost(frameHost);

  // Агент → оператор. Бросаем исключение, если такого файла нет ни в одном
  // фрейме: тогда requestAstFocus не засчитает доставку и инструмент вернёт
  // ошибку вместо тихого «успешно показал».
  const unsubscribeFocus = onAstFocusRequest((focus) => {
    const tab = (focus.tabId && state.tabs.find((item) => item.id === focus.tabId)) || tabByRel(focus.rel);
    if (!tab) throw Object.assign(new Error(`Файл ${focus.rel} не открыт ни в одном фрейме.`), { code: 'NOT_IN_FRAME' });
    if (state.activeId !== tab.id) { saveScroll(); activateTab(state, tab.id); }
    focusTarget = { ...focus };
    if (typeof options.onOpen === 'function') options.onOpen(tab.id);
    renderAll();
    scrollToRel(focus.rel);
  });

  applyPinned(); renderAll();
  return {
    open: (id) => { const tab = openTab(state, id); void loadGraph(tab); },
    close: onClose,
    reset,
    getState: () => state,
    dispose: () => { unregisterFrameHost(); unsubscribeFocus(); clearAstScope(); },
  };
}
