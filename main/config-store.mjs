// Chat connection config (plan stream C1). The NON-secret part only:
// endpoint + model + timestamps, persisted as JSON in the app's userData
// directory — never in the project repository, never with the API key.
// The key lives separately through safeStorage (main/secret-store.mjs).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG = {
  endpoint: 'https://api.anthropic.com/v1/messages',
  model: '',
};

export function createConfigStore(userDataDir) {
  const file = path.join(userDataDir, 'chat-config.json');

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // Only whitelisted fields are ever written — callers cannot smuggle extra
  // keys (or secrets) into the file through this surface.
  function save(patch) {
    const prev = load();
    const next = {
      ...prev,
      endpoint: typeof patch.endpoint === 'string' ? patch.endpoint : prev.endpoint,
      model: typeof patch.model === 'string' ? patch.model : prev.model,
    };
    const now = new Date().toISOString();
    next.updatedAt = now;
    if (!prev.createdAt) next.createdAt = now;
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
  }

  return { load, save, file };
}

// Basic shape validation for values arriving over IPC (config:set). Returns
// { ok, error? } — the UI layer decides what to show.
export function validateConfigPatch(patch) {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'Config patch must be an object' };
  }
  if (patch.endpoint !== undefined) {
    if (typeof patch.endpoint !== 'string' || !/^https:\/\//.test(patch.endpoint)) {
      return { ok: false, error: 'Endpoint must be an https:// URL' };
    }
  }
  if (patch.model !== undefined) {
    // Empty string is legitimate here — it means "not configured yet" (the
    // default state). The UI enforces non-empty before saving; the IPC layer
    // only guarantees the value is a string.
    if (typeof patch.model !== 'string') {
      return { ok: false, error: 'Model must be a string' };
    }
  }
  return { ok: true };
}
