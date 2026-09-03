import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAutosaveQueue } from '../main/project/project-autosave.mjs';

function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn) { const id = ++seq; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
    async tick() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) await fn(); await Promise.resolve(); },
    size() { return timers.size; },
  };
}

test('autosave debounces and persists only the latest snapshot', async () => {
  const clock = fakeClock();
  const saved = [];
  const queue = createProjectAutosaveQueue({ save: async (payload) => { saved.push(payload); return { ok: true }; }, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  queue.queue('w1', { generation: 1, document: { id: 'old' } });
  queue.queue('w1', { generation: 1, document: { id: 'new' } });
  assert.equal(clock.size(), 1);
  await queue.flush('w1');
  assert.deepEqual(saved.map((x) => x.document.id), ['new']);
  assert.equal(queue.pending('w1'), false);
});

test('flush drains an edit queued during an in-flight save in order', async () => {
  let release;
  const firstGate = new Promise((resolve) => { release = resolve; });
  const saved = [];
  const queue = createProjectAutosaveQueue({ save: async (payload) => { saved.push(payload.document.id); if (saved.length === 1) await firstGate; return { ok: true }; } });
  queue.queue('w1', { document: { id: 'a' } });
  const flushing = queue.flush('w1');
  await Promise.resolve();
  queue.queue('w1', { document: { id: 'b' } });
  release();
  await flushing;
  assert.deepEqual(saved, ['a', 'b']);
});

test('failed autosave retries within its bound and then succeeds', async () => {
  const clock = fakeClock();
  let attempts = 0;
  const queue = createProjectAutosaveQueue({
    save: async () => (++attempts < 3 ? { ok: false, error: { code: 'SAVE_FAILED' } } : { ok: true }),
    maxRetries: 2,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  queue.queue('w1', { document: { id: 'a' } });
  await queue.flush('w1');
  assert.equal(attempts, 3);
  assert.equal(queue.pending('w1'), false);
});

test('discard cancels a pending project save', () => {
  const clock = fakeClock();
  const queue = createProjectAutosaveQueue({ save: async () => ({ ok: true }), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  queue.queue('w1', { document: {} });
  queue.discard('w1');
  assert.equal(queue.pending('w1'), false);
  assert.equal(clock.size(), 0);
});
