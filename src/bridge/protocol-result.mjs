export function ok(data) {
  return { ok: true, data };
}

export function err(code, message) {
  return { ok: false, error: { code, message } };
}

export function fromThrow(fn) {
  try {
    const r = fn();
    // `fn` may be async (e.g. canvas.runArchifyImport, which crosses IPC to the
    // main process to spawn the archify CLI). When it returns a thenable, hand
    // back a promise that resolves to ok(..) / err(..) so callers can await it;
    // for the common synchronous commands the return value is unchanged.
    if (r && typeof r.then === 'function') {
      return r.then(ok).catch((e) => err(e.code || 'INTERNAL', e.message || String(e)));
    }
    return ok(r);
  } catch (e) {
    return err(e.code || 'INTERNAL', e.message || String(e));
  }
}
