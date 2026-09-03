// Archify authoring loop (plan S4.1 / S5.1). The CLI has no repo-scan command —
// the agent authors the candidate JSON. This module owns the
// "write candidate → validate → (repair, bounded) → layout IR" loop in the MAIN
// process. It is ASYNC (execFile, not execFileSync) so a slow CLI never freezes
// the Electron main thread, and it never takes a filesystem path or runId from
// the model — only an opaque, server-owned runToken (see archify-runs.mjs).
//
// SECURITY:
//   - `binary` is resolved from the FROZEN archify skill snapshot root by the
//     caller (main.mjs). The model never supplies an executable path.
//   - `runToken` is an opaque UUID mapped to a canonical dir under userData;
//     it is never converted into a path by the caller.
//   - `appUserData` is where run scratch dirs live (never process.cwd()).

import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ARCHIFY_BIN } from './archify-client.mjs';
import { resolveRun, recordCandidateHash, markStatus, runReceipt, cleanupExpired, cleanupStaleRunDirs } from './archify-runs.mjs';

// Author-diagnostics trace (terminal). Shows the CLI validation/layout outcome so
// a failing `archify.author` is not just "ok:false" — the code, message and
// diagnostics are printed here.
const aLog = (...parts) => console.log('[AUTHOR]', ...parts);
const aErr = (...parts) => console.error('[AUTHOR]', ...parts);

// Types the CLI understands (verified against `archify guide`).
export const DIAGRAM_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];
export const QUALITY_PROFILES = ['standard', 'showcase'];

export const CLI_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, maxBuffer: MAX_BUFFER, timeout: CLI_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        // The CLI exits non-zero on validation failure but STILL prints the JSON
        // receipt to stdout — capture and resolve it so diagnostics can relay.
        if (stdout && String(stdout).trim()) resolve({ stdout: String(stdout), err });
        else reject(Object.assign(err, { stderr: String(stderr || '') }));
        return;
      }
      resolve({ stdout: String(stdout || ''), err: null });
    });
  });
}

function stripJson(raw) {
  const s = String(raw || '');
  const i = s.indexOf('{');
  return i >= 0 ? s.slice(i) : '';
}

async function runValidateJson(binary, candidatePath, type, quality) {
  const { stdout } = await execFileAsync('node', [binary, 'validate', type, candidatePath, '--quality', quality, '--json']);
  const receipt = JSON.parse(stripJson(stdout));
  if (receipt && receipt.ok) {
    return { ok: true, checks: receipt.checks || [], diagnostics: [], raw: receipt };
  }
  return {
    ok: false,
    error: { code: 'VALIDATION', message: (receipt && receipt.error) || 'archify validate failed' },
    diagnostics: Array.isArray(receipt && receipt.diagnostics) ? receipt.diagnostics : [],
    raw: receipt,
  };
}

async function runLayoutJson(binary, candidatePath, type) {
  const { stdout } = await execFileAsync('node', [binary, 'validate', type, candidatePath, '--layout-json']);
  return JSON.parse(stripJson(stdout));
}

/**
 * Author + validate + layout in one async call, bounded by a repair budget.
 *
 *   authorArchify({ type, candidate, quality, maxRepairRounds, runToken, appUserData, binary, skillHash })
 *
 * - `runToken` (opaque) continues an existing run (repair) or, when omitted,
 *   mints a fresh one. An unknown token -> UNKNOWN_RUN; an expired or terminal
 *   one -> RUN_EXPIRED / TRANSITION_FORBIDDEN.
 * - `maxRepairRounds` is pinned on the run AT CREATION (or read from the skill
 *   profile) and is IGNORED on a continuation, so the model can never enlarge
 *   its own repair budget mid-run. Exceeding it -> REPAIR_BUDGET_EXHAUSTED.
 * - `binary` is REQUIRED: the IPC caller resolves it from the enabled archify
 *   skill snapshot and passes it explicitly. There is deliberately NO home-path
 *   fallback here — a caller that maps to a random global binary would break the
 *   security invariant that the CLI is tied to the enabled skill snapshot.
 * - `skillHash` records the frozen skill snapshot; a mid-run change ->
 *   SKILL_CHANGED_DURING_RUN.
 */
export async function authorArchify({ type, candidate, quality = 'showcase', maxRepairRounds = 2, runToken, appUserData, binary, skillHash = null }) {
  if (!DIAGRAM_TYPES.includes(type)) {
    return { ok: false, error: { code: 'BAD_INPUT', message: `Unknown diagram type: ${type}. Use one of: ${DIAGRAM_TYPES.join(', ')}` }, diagnostics: [] };
  }
  if (!QUALITY_PROFILES.includes(quality)) {
    return { ok: false, error: { code: 'BAD_INPUT', message: `Unknown quality profile: ${quality}. Use: ${QUALITY_PROFILES.join(', ')}` }, diagnostics: [] };
  }
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, error: { code: 'BAD_INPUT', message: 'candidate must be an object (the authored diagram JSON).' }, diagnostics: [] };
  }
  if (!appUserData) {
    return { ok: false, error: { code: 'BAD_INPUT', message: 'appUserData is required (run scratch dirs live there).' }, diagnostics: [] };
  }

  // The run is born pinned to this exact diagram/quality/skill/binary, so a
  // continuation can only repair the same thing and cannot change the budget.
  // maxRepairRounds is IGNORED on a continuation (resolveRun keeps the value
  // recorded at creation), so the model can never enlarge its own repair budget.
  const context = {
    diagramType: type,
    quality,
    skillHash,
    binary: binary || null,
    budget: maxRepairRounds,
  };
  // Sweep stale/expired runs BEFORE minting a fresh one, so a long-lived session
  // cannot accumulate scratch dirs. Only for fresh runs; a continuation must not
  // be disturbed mid-repair (its token is still live in the map).
  if (!runToken) {
    try { cleanupExpired(); cleanupStaleRunDirs(appUserData); } catch { /* best-effort */ }
  }
  let resolved;
  try {
    resolved = resolveRun(runToken, appUserData, context);
  } catch (e) {
    return { ok: false, error: { code: 'RUN_ERROR', message: String((e && e.message) || e) }, diagnostics: [] };
  }
  if (!resolved.ok) {
    return { ok: false, error: resolved.error, diagnostics: [], runToken: runToken || null };
  }
  const run = resolved.run;
  const budget = run.maxRepairRounds;

  // Write candidate into the canonical run dir (under appUserData, never cwd).
  const candidatePath = path.join(run.dir, 'candidate.json');
  const text = JSON.stringify(candidate, null, 2);
  writeFileSync(candidatePath, text, 'utf8');
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  recordCandidateHash(run, hash);

  // Resolve the binary against the frozen archify skill root is the caller's
  // duty; refuse a missing/empty binary here rather than spawning anything.
  if (!binary || typeof binary !== 'string') {
    markStatus(run, 'validation_failed', []);
    return {
      ok: false,
      error: { code: 'ARCHIFY_NOT_FOUND', message: 'archify CLI path not provided — the archify skill must be enabled.' },
      diagnostics: [],
      ...runReceipt(run, { candidateHash: hash }),
    };
  }

  aLog('author имя=' + type + ' quality=' + quality + ' budget=' + budget + ' binary=' + String(binary).split(path.sep).slice(-3).join('/') + ' runToken=' + (runToken || 'fresh'));
  let res;
  try {
    res = await runValidateJson(binary, candidatePath, type, quality);
    aLog('validate ok=' + res.ok + (res.ok ? ` checks=${(res.checks || []).length}` : ' code=' + (res.error && res.error.code) + ' msg=' + (res.error && res.error.message)));
  } catch (e) {
    markStatus(run, 'cli_error', []);
    aErr('CLI_ERROR validate', String((e && e.message) || e), 'stderr=' + String((e && e.stderr) || '').slice(0, 300));
    return { ok: false, error: { code: 'CLI_ERROR', message: `archify validate failed: ${String((e && e.message) || e)}` }, diagnostics: [], ...runReceipt(run, { candidateHash: hash }) };
  }

  if (!res.ok) {
    markStatus(run, 'validation_failed', res.diagnostics);
    if (resolved.budgetExhausted) {
      aErr('REPAIR_BUDGET_EXHAUSTED', (res.diagnostics || []).slice(0, 8).join(' | '));
      return { ok: false, error: { code: 'REPAIR_BUDGET_EXHAUSTED', message: `Repair budget exceeded (${budget}). Start a fresh run.` }, diagnostics: res.diagnostics, ...runReceipt(run, { candidateHash: hash }) };
    }
    aErr('VALIDATION_FAILED', JSON.stringify(res.error), 'diagnostics=' + JSON.stringify((res.diagnostics || []).slice(0, 12)));
    return { ok: false, error: res.error, diagnostics: res.diagnostics, ...runReceipt(run, { candidateHash: hash }) };
  }

  let layout;
  try {
    layout = await runLayoutJson(binary, candidatePath, type);
    aLog('layout ok components=' + (Array.isArray(layout.components) ? layout.components.length : 0) + ' connections=' + (Array.isArray(layout.connections) ? layout.connections.length : 0));
  } catch (e) {
    markStatus(run, 'layout_error', []);
    aErr('LAYOUT_ERROR', String((e && e.message) || e));
    return { ok: false, error: { code: 'LAYOUT_ERROR', message: `archify layout failed: ${String((e && e.message) || e)}` }, diagnostics: [], checks: res.checks, ...runReceipt(run, { candidateHash: hash }) };
  }

  markStatus(run, 'layout_ready', []);
  const ir = {
    diagram_type: layout.diagram_type || type,
    viewBox: layout.viewBox || null,
    components: layout.components || [],
    boundaries: layout.boundaries || [],
    connections: layout.connections || [],
  };

  return {
    ok: true,
    data: {
      ...runReceipt(run, { candidateHash: hash, checks: res.checks, layout, ir }),
    },
  };
}

// Re-exported for callers that still need the marker resolution (IPC).
export { ARCHIFY_BIN };
