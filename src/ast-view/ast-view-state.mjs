// Pure tab/scope state for the AST workspace. DOM and IPC stay in ast-view.mjs.
export const SCOPES = ['own', 'l1', 'l2'];
const TAB_STATES = ['idle', 'loading', 'ready', 'stale', 'partial', 'unsupported', 'error'];

export function createState() {
  return { tabs: [], activeId: null, generation: null, pinned: false, width: 480 };
}

function scopeValid(scope) { return SCOPES.includes(scope); }
export function tabById(state, id) { return state.tabs.find((tab) => tab.id === id) || null; }

function freshTab(id, context) {
  return {
    id, context, activeScope: 'own', graph: null, error: null, loading: false,
    status: 'idle', requestId: 0, expandedFiles: [], selectedSymbol: null,
    scrollTop: 0, preview: null,
  };
}

export function openTab(state, id, context = null) {
  const existing = tabById(state, id);
  if (existing) {
    if (context) existing.context = context;
    state.activeId = id;
    return existing;
  }
  state.tabs.push(freshTab(id, context));
  if (state.tabs.length > 8) {
    const drop = state.tabs.find((tab) => tab.id !== id);
    if (drop) state.tabs = state.tabs.filter((tab) => tab.id !== drop.id);
  }
  state.activeId = id;
  return tabById(state, id);
}

export function activateTab(state, id) {
  if (!tabById(state, id)) return false;
  state.activeId = id;
  return true;
}

export function closeTab(state, id) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return null;
  const [removed] = state.tabs.splice(index, 1);
  if (state.activeId === id) {
    const next = state.tabs[index] || state.tabs[index - 1] || null;
    state.activeId = next ? next.id : null;
  }
  return removed;
}

export function setScope(state, id, scope) {
  const tab = tabById(state, id);
  if (!tab || !scopeValid(scope)) return tab;
  tab.activeScope = scope;
  return tab;
}

export function setTabStatus(tab, status, error = null) {
  tab.status = TAB_STATES.includes(status) ? status : 'error';
  tab.loading = tab.status === 'loading';
  tab.error = error;
  return tab;
}

export function statusFromGraph(graph) {
  if (!graph) return 'idle';
  if (graph.stale) return 'stale';
  if (graph.unsupported) return 'unsupported';
  if (graph.partial) return 'partial';
  return 'ready';
}

export function toggleExpandedFile(tab, rel) {
  const values = new Set(tab.expandedFiles || []);
  if (values.has(rel)) values.delete(rel); else values.add(rel);
  tab.expandedFiles = [...values];
  return values.has(rel);
}

export function selectSymbol(tab, symbolId) { tab.selectedSymbol = symbolId || null; }
export function rememberScroll(tab, scrollTop) { tab.scrollTop = Math.max(0, Number(scrollTop) || 0); }
export function setPinned(state, pinned) { state.pinned = !!pinned; }
export function setDockWidth(state, width) { state.width = Math.max(360, Math.min(960, Math.round(Number(width) || 480))); }

export function refreshStaleTab(tab) {
  if (!tab?.graph?.snapshot || !tab.context) return false;
  tab.context = { ...tab.context, snapshot: tab.graph.snapshot };
  tab.graph = null;
  setTabStatus(tab, 'idle');
  return true;
}

export function clearTabs(state) {
  state.tabs = [];
  state.activeId = null;
  state.generation = null;
}

function setGeneration(state, generation) {
  if (generation === state.generation) return false;
  state.generation = generation;
  return true;
}
