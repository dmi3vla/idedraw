// Archify run registry (plan S4.1 / S5.1). The model NEVER supplies a run
// path — `runId` is gone from the model-facing surface. Instead the main
// process mints an opaque, non-sequential runToken (a UUID) and maps it to a
// canonical run directory under `userData/agent-runs/<uuid>`. The token is only
// ever *looked up*, never converted into a path by the caller, so `../../outside`
// traversal is impossible.
//
// It also carries the repair state machine so `archify.author` can honestly
// enforce a bounded budget instead of pretending `maxRepairRounds` is advisory.
//
// "IMMUTABLE CONTEXT" — a run is born with the audit trail that ties it to the
// exact skill/binary/diagram/quality that authored it. Continuations can only
// repair the SAME diagram under the SAME skill; they cannot change the budget,
// the diagram type, or the binary. This is what makes a repair run reproducible
// and prevents a mid-turn settings change from silently swapping the toolchain.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

// runToken -> { runId, dir, base, candidateHashes[], attempt, maxRepairRounds,
//               status, lastDiagnostics, diagramType, quality, skillHash, binary,
//               createdAt, expiresAt }
const runs = new Map();

// Runs are ephemeral scratch: after 24h they are unreachable and their
// candidate artifacts can be garbage-collected. A run with no activity for this
// long cannot be a meaningful in-flight diagram.
const TTL_MS = 24 * 60 * 60 * 1000;

// Cap live runs so a long-lived session cannot become an unbounded disk/registry
// leak. This is a soft cap; the oldest run is dropped first.
const MAX_SESSION_RUNS = 64;

export function baseRunDir(appUserData) {
  return path.join(appUserData, 'agent-runs');
}

/**
 * Mint a fresh run token + its canonical directory. Context pins the immutable
 * audit fields ({ diagramType, quality, skillHash, binary, budget }); a fresh
 * run is ALREADY attempt 1 (there is no "attempt 0" — the first validation is
 * the first attempt).
 */
export function createRun(appUserData, context = {}) {
  const token = randomUUID();
  const dir = path.join(baseRunDir(appUserData), token);
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const run = {
    token,
    runId: token,
    dir,
    candidateHashes: [],
    attempt: 1,
    maxRepairRounds: clampBudget(context.budget),
    status: 'created',
    lastDiagnostics: [],
    diagramType: context.diagramType || null,
    quality: context.quality || null,
    skillHash: context.skillHash || null,
    binary: context.binary || null,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  runs.set(token, run);
  evictIfOverCap();
  return run;
}

function clampBudget(v) {
  // Profile-driven, capped: a model can never request an unbounded repair loop.
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(0, n));
}

/** Look up an existing run by opaque token. Returns null if unknown. */
export function getRun(token) {
  if (!token || typeof token !== 'string') return null;
  return runs.get(token) || null;
}

function isExpired(run) {
  return Date.now() > run.expiresAt;
}

/** Drop expired in-memory runs and remove their on-disk dirs. Returns count removed. */
export function cleanupExpired() {
  const now = Date.now();
  const expired = [];
  for (const [token, run] of runs) {
    if (now > run.expiresAt) expired.push(token);
  }
  for (const token of expired) {
    const run = runs.get(token);
    runs.delete(token);
    try { rmSync(run.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return expired.length;
}

/**
 * Remove on-disk run dirs under `appUserData/agent-runs` that are NO LONGER in
 * the in-memory map (e.g. stale dirs left by a crashed previous session, or the
 * process restarted after the map was lost). Returns count removed.
 *
 * This must be called at startup and on a rare interval, NOT only when a new run
 * is minted — otherwise a long-lived app can leak scratch dirs indefinitely.
 */
export function cleanupStaleRunDirs(appUserData) {
  if (!appUserData || typeof appUserData !== 'string') return 0;
  const base = baseRunDir(appUserData);
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (runs.has(e.name)) continue; // live (or expired, handled by cleanupExpired)
    try { rmSync(path.join(base, e.name), { recursive: true, force: true }); removed++; } catch { /* best-effort */ }
  }
  return removed;
}

function evictIfOverCap() {
  while (runs.size > MAX_SESSION_RUNS) {
    // Oldest by createdAt first.
    let oldest = null;
    for (const run of runs.values()) {
      if (!oldest || run.createdAt < oldest.createdAt) oldest = run;
    }
    if (!oldest) break;
    runs.delete(oldest.token);
    try { rmSync(oldest.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

const TERMINAL_STATUSES = new Set(['layout_ready', 'cancelled', 'expired']);

/**
 * Resolve the run to use:
 *   - no token        -> create a fresh run (attempt 1, context pinned)
 *   - valid token     -> a repair continuation; context must still MATCH the
 *                        immutable audit fields, and the run must not be terminal
 *   - unknown/expired -> error
 * Returns { ok, run, attempt } or { ok:false, error:{code} }.
 *
 * `context` is the incoming call's { diagramType, quality, skillHash, binary, budget }.
 * Only the fields present are checked; a fresh run pins all of them.
 */
export function resolveRun(token, appUserData, context = {}) {
  if (!token) {
    return { ok: true, run: createRun(appUserData, context), attempt: 1, budgetExhausted: false };
  }
  const run = getRun(token);
  if (!run) {
    return { ok: false, error: { code: 'UNKNOWN_RUN', message: 'runToken is unknown or has expired.' } };
  }
  if (isExpired(run)) {
    runs.delete(token);
    try { rmSync(run.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, error: { code: 'RUN_EXPIRED', message: 'This run has expired; start a fresh one.' } };
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      ok: false,
      error: {
        code: 'TRANSITION_FORBIDDEN',
        message: `Run is already ${run.status}; it cannot be repaired or re-authored.`,
      },
    };
  }
  // Immutability: the repair must target the SAME diagram, quality, skill and
  // binary recorded at creation. The budget is NEVER taken from a continuation.
  if (context.diagramType && run.diagramType && context.diagramType !== run.diagramType) {
    return { ok: false, error: { code: 'TRANSITION_FORBIDDEN', message: `Cannot change diagram type from ${run.diagramType} to ${context.diagramType}. Start a fresh run.` } };
  }
  if (context.quality && run.quality && context.quality !== run.quality) {
    return { ok: false, error: { code: 'TRANSITION_FORBIDDEN', message: `Cannot change quality profile from ${run.quality} to ${context.quality}. Start a fresh run.` } };
  }
  if (context.skillHash && run.skillHash && context.skillHash !== run.skillHash) {
    return { ok: false, error: { code: 'SKILL_CHANGED_DURING_RUN', message: 'The archify skill changed on disk during this run; start a fresh run.' } };
  }
  if (context.binary && run.binary && path.resolve(context.binary) !== path.resolve(run.binary)) {
    return { ok: false, error: { code: 'TRANSITION_FORBIDDEN', message: 'Cannot change the archify binary mid-run. Start a fresh run.' } };
  }

  const budget = run.maxRepairRounds;
  const attempt = run.attempt + 1;
  if (attempt > budget + 1) { // attempt 1 is the initial validation; repairs maxRepairRounds more
    return {
      ok: false,
      error: { code: 'REPAIR_BUDGET_EXHAUSTED', message: `Repair budget exceeded (${budget}). Start a fresh run with a new candidate.` },
      attempt,
      budgetExhausted: true,
    };
  }
  run.attempt = attempt;
  run.status = 'repair';
  return { ok: true, run, attempt, budgetExhausted: false };
}

export function recordCandidateHash(run, hash) {
  run.candidateHashes.push(hash);
}

export function markStatus(run, status, diagnostics = []) {
  run.status = status;
  if (diagnostics) run.lastDiagnostics = diagnostics;
  return run;
}

/** Back-compat shim: budget is pinned at creation, never mutated on a continuation. */
export function markBudget(run, maxRepairRounds) {
  run.maxRepairRounds = clampBudget(maxRepairRounds);
  return run;
}

/** A safe, small summary a caller may keep. runToken doubles as the stable key. */
export function runReceipt(run, extra = {}) {
  return {
    runToken: run.token,
    runId: run.runId,
    attempt: run.attempt,
    maxRepairRounds: run.maxRepairRounds,
    status: run.status,
    candidateHashes: run.candidateHashes.slice(),
    diagramType: run.diagramType,
    quality: run.quality,
    // The skill hash is public identity (a SHA-256, not a path): exposing it lets
    // the caller prove a repair run is pinned to a specific skill snapshot. It is
    // deliberately safe to surface, unlike binary/candidate paths below.
    skillHash: run.skillHash || null,
    // NO binary path and NO candidatePath leak out of the receipt: those are
    // internal scratch paths, never model/renderer-visible.
    ...extra,
  };
}

/** Test helper: forget all runs (no references to live dirs kept). */
export function _resetRuns() {
  runs.clear();
}
