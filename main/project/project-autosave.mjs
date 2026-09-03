// Main-owned debounced autosave queue. The renderer may offer many snapshots;
// only the newest pending document per webContents is persisted. Saves are
// serialized, retry-bounded, and flushable before project/window transitions.
export function createProjectAutosaveQueue({
  save,
  debounceMs = 700,
  retryMs = 250,
  maxRetries = 2,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof save !== 'function') throw new TypeError('save must be a function');
  const states = new Map();

  const stateFor = (key) => {
    let state = states.get(key);
    if (!state) {
      state = { latest: null, timer: null, running: null, retries: 0, lastResult: null };
      states.set(key, state);
    }
    return state;
  };

  const schedule = (key, delay = debounceMs) => {
    const state = stateFor(key);
    if (state.timer) clearTimer(state.timer);
    state.timer = setTimer(() => {
      state.timer = null;
      void run(key);
    }, delay);
  };

  const run = async (key) => {
    const state = stateFor(key);
    if (state.running) return state.running;
    if (!state.latest) return state.lastResult || { ok: true, data: { idle: true } };
    const payload = state.latest;
    state.latest = null;
    state.running = Promise.resolve().then(() => save(payload));
    let result;
    try {
      result = await state.running;
    } catch (error) {
      result = { ok: false, error: { code: 'SAVE_FAILED', message: String(error?.message || error) } };
    } finally {
      state.running = null;
    }
    state.lastResult = result;
    if (!result?.ok && state.retries < maxRetries) {
      state.retries += 1;
      // Do not overwrite a newer edit that arrived while this save ran.
      if (!state.latest) state.latest = payload;
      schedule(key, retryMs);
    } else if (result?.ok) {
      state.retries = 0;
    }
    if (state.latest && !state.timer) schedule(key);
    return result;
  };

  return {
    queue(key, payload) {
      const state = stateFor(key);
      state.latest = payload;
      state.retries = 0;
      schedule(key);
      return { ok: true, data: { queued: true } };
    },
    async flush(key) {
      const state = states.get(key);
      if (!state) return { ok: true, data: { idle: true } };
      if (state.timer) { clearTimer(state.timer); state.timer = null; }
      if (state.running) await state.running;
      // Keep draining if edits arrived during an in-flight save.
      let result = state.lastResult || { ok: true, data: { idle: true } };
      while (state.latest) {
        if (state.timer) { clearTimer(state.timer); state.timer = null; }
        result = await run(key);
      }
      if (state.timer) { clearTimer(state.timer); state.timer = null; }
      return result;
    },
    discard(key) {
      const state = states.get(key);
      if (state?.timer) clearTimer(state.timer);
      states.delete(key);
    },
    pending(key) {
      const state = states.get(key);
      return !!(state && (state.latest || state.timer || state.running));
    },
  };
}
