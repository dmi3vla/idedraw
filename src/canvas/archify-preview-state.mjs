// S6 — pure, browser-safe preview/confirm registry logic, factored out of
// adapter.mjs so it can be unit-tested in plain Node WITHOUT pulling in
// @excalidraw/excalidraw (which needs JSON import attributes and React).
//
// This module answers three S6 questions:
//   * what content makes a scene fingerprint differ (id alone is NOT enough);
//   * how a per-preview opaque token is minted;
//   * how the pending/applied registries stay bounded (TTL + cap) on a long-lived
//     session, so a project link/unlink/reset keeps them from growing unbounded
//     and a legitimate re-confirm after an undo is not blocked by a stale entry.

// Bounded-registry defaults (adapter.mjs re-exports the same values).
export const PENDING_TTL_MS = 5 * 60 * 1000; // a pending preview expires after 5 min
export const PENDING_MAX = 20;
export const APPLIED_MAX = 256;

/**
 * Content-complete scene fingerprint. IDs alone are NOT enough (Round 17 P0/P1):
 * a user can move / resize / re-style / re-frame / re-text an element between
 * preview and confirm without changing its id — for Merge that changes the
 * placement base, so the preview must be considered stale. We hash the stable
 * identity + geometry + text, so ANY content change makes the fingerprint differ.
 *
 * @param {Array} elements Excalidraw scene elements (or a structural lookalike).
 * @returns {string} a compact, deterministic fingerprint.
 */
export function sceneFingerprintFromElements(elements) {
  const parts = (Array.isArray(elements) ? elements : [])
    .filter((e) => e && !e.isDeleted)
    .map((e) => [
      e.id,
      e.version ?? 0,
      e.versionNonce ?? 0,
      typeof e.x === 'number' ? e.x : 0,
      typeof e.y === 'number' ? e.y : 0,
      typeof e.width === 'number' ? e.width : 0,
      typeof e.height === 'number' ? e.height : 0,
      e.frameId ?? null,
      e.containerId ?? null,
      e.text ?? null,
      e.originalText ?? null,
      e.type ?? null,
      e.angle ?? 0,
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(parts);
}

/**
 * Mint an opaque, non-deterministic per-preview token. The token identifies ONE
 * preview (a specific plan for a specific scene at a specific moment), never the
 * content itself — content identity lives in projectionId/sourceHash. A
 * `now`/`rand` parameter is injectable for deterministic tests.
 */
let fallbackCounter = 0;
export function newPreviewToken({ now = () => Date.now(), rand = null } = {}) {
  let bytes;
  if (rand && typeof rand === 'function') {
    bytes = rand(16);
  } else if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // fallback: counter + timestamp is unique within one process
    fallbackCounter = (fallbackCounter || 0) + 1;
    return `pt-${now().toString(36)}-${fallbackCounter}`;
  }
  return 'pt-' + [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Prune a pending map + an applied set to a bounded, TTL-respecting size.
 * Mutates the collections in place (they are Maps/Sets) and returns what was
 * removed. `nowMs` injectable for tests.
 *
 * @param {Map} pending       previewToken -> { createdAt }
 * @param {Set} applied       projectionId set
 * @param {object} opts       { nowMs, ttlMs, pendingMax, appliedMax }
 * @returns {{ expiredPending: number, evictedPending: number, evictedApplied: number }}
 */
export function prunePendingState(pending = new Map(), applied = new Set(), opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? PENDING_TTL_MS;
  const pendingMax = opts.pendingMax ?? PENDING_MAX;
  const appliedMax = opts.appliedMax ?? APPLIED_MAX;
  let expiredPending = 0;
  let evictedPending = 0;
  let evictedApplied = 0;

  for (const [token, p] of pending) {
    if (nowMs - (p && p.createdAt ? p.createdAt : nowMs) > ttl) {
      pending.delete(token);
      expiredPending++;
    }
  }
  while (pending.size > pendingMax) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
    evictedPending++;
  }
  while (applied.size > appliedMax) {
    const oldest = applied.values().next().value;
    applied.delete(oldest);
    evictedApplied++;
  }
  return { expiredPending, evictedPending, evictedApplied };
}
