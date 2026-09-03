// Main-owned linked project root (plan S4.1 security closure). The renderer and
// the model NEVER supply a filesystem root for reads — that is the whole point.
// The main process owns the canonical realpath of the linked project directory,
// chosen only through a native directory dialog (project:chooseDirectory). All
// read-only project tools use THIS root exclusively.
//
// The renderer only ever receives a display string (the canonical path, safe to
// show) and a `linked` boolean. It never funnels a user/model-supplied path back
// into the read tools, so "arbitrary directory" is impossible from the model.

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

let currentRoot = null; // canonical realpath of the linked project, or null

/** Resolve an arbitrary path to its realpath, refusing non-directories. */
function canonicalDir(p) {
  if (!p || typeof p !== 'string') return null;
  let real;
  try {
    real = realpathSync(p);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Set the linked project root (called by the native dialog in the main process).
 * Returns { ok, root } on success, or { ok:false, error }.
 */
export function setProjectRoot(p) {
  const real = canonicalDir(p);
  if (!real) {
    return { ok: false, error: { code: 'BAD_ROOT', message: `Not a readable directory: ${p}` } };
  }
  currentRoot = real;
  return { ok: true, root: real };
}

/** Get the canonical linked project root (main-only; used by read tools). */
export function getProjectRoot() {
  return currentRoot;
}

/** Clear the linked root (unlink). */
export function clearProjectRoot() {
  currentRoot = null;
  return { ok: true };
}

/** Safe status for the renderer/model: no absolute filesystem path crosses IPC. */
export function getProjectStatus() {
  return {
    linked: !!currentRoot,
    projectId: currentRoot ? path.basename(currentRoot) : null,
  };
}

// For tests: allow resetting without filesystem side-effects.
export function _resetForTest() {
  currentRoot = null;
}
