import * as canvas from '../canvas/adapter.mjs';

let selection = { ids: [], lastEventAt: null, lastEvent: null };
let debounceTimer = null;
const DEBOUNCE_MS = 120;
const subscribers = new Set();

function commit(next) {
  selection = next;
  // Immutable snapshot out — callers must never mutate our internal state.
  const snapshot = JSON.parse(JSON.stringify(selection));
  for (const cb of subscribers) cb(snapshot);
}

canvas.onCanvasEvent((event) => {
  if (event.type !== 'selectionChange') return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    commit({ ids: event.ids, lastEventAt: new Date().toISOString(), lastEvent: 'selectionChange' });
  }, DEBOUNCE_MS);
});

export function getSelection() {
  return JSON.parse(JSON.stringify(selection));
}

// Used by chat to react to canvas activity without polling.
export function onContextChange(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
