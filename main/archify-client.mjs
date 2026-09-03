// Main-process helper that runs the archify CLI and returns the architecture IR.
//
// WHY THIS LIVES IN MAIN: the renderer has no fs/child_process access, so a
// "run archify" invocation must cross the IPC boundary to the main process.
// This mirrors how the config/secret stores and the Anthropic client already
// work — the renderer never touches the CLI, it just asks over IPC and gets a
// result back.
//
// HONEST LIMIT (verified against the CLI, not assumed): archify has NO command
// that scans a repository and produces an architecture spec. Its commands
// (`validate`, `render`, `deliver`, `preview`, ...) all operate on an
// ALREADY-AUTHORED input.json. The authoring step is the archify skill/agent
// reading the code and writing the spec. So "run archify against a project"
// means "run archify against that project's published spec" — the spec path is
// the parameter. That path comes from the linked project (project-store), so
// the button is not hardcoded to this repo; it runs against whatever spec the
// linked project points at.

import { execFileSync } from 'node:child_process';
import { accessSync, realpathSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Archify is a user-installed agent skill, not an npm dependency of this
// package, so its path is never project-relative. This is the same
// predictable location the tests/archify-import.test.mjs already use.
export const ARCHIFY_BIN = path.join(os.homedir(), '.agents/skills/archify/bin/archify.mjs');

// A spec path stored in project-store may be authored as a marker instead of an
// absolute path, so it survives a repo move. Resolve `@app/...` against the app
// root here in main. Everything else is used as-is (absolute or cwd-relative).
export function resolveSpecPath(specPath) {
  if (!specPath) return null;
  if (typeof specPath !== 'string') return null;
  const marker = '@app/';
  if (specPath.startsWith(marker)) {
    return path.join(process.cwd(), specPath.slice(marker.length));
  }
  return specPath;
}

// Is `child` inside `dir` (both must be realpaths)? Guards the scoped validator
// so the spec cannot point at an arbitrary file outside the allowed root.
function isInsideDir(dir, child) {
  if (!dir || !child) return false;
  const rel = path.relative(dir, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Scoped archify validate (S4.1.1 hardening). Unlike `runArchifyValidate` this
 * refuses to run against an arbitrary spec path: the spec's realpath must live
 * inside `root` (the main-owned project root or a known run dir), and it spawns
 * `binary` (the enabled archify skill's frozen binary) rather than a hardcoded
 * home path. The renderer never supplies `binary`/`root` — the IPC handler does.
 */
export function runArchifyValidateScoped(specPath, { binary, root } = {}) {
  if (!specPath) return { ok: false, error: { code: 'BAD_INPUT', message: 'No archify spec path provided.' } };
  if (!binary) return { ok: false, error: { code: 'ARCHIFY_NOT_FOUND', message: 'archify binary not available (enable the Archify skill).' } };

  // Resolve the spec and verify it is a real file inside the allowed root.
  const resolved = resolveSpecPath(specPath);
  let realSpec;
  try { realSpec = realpathSync(resolved); } catch { realSpec = null; }
  if (!realSpec || !existsSync(realSpec) || !statSync(realSpec).isFile()) {
    return { ok: false, error: { code: 'BAD_INPUT', message: `Spec not found: ${resolved}` } };
  }
  if (!root || !isInsideDir(root, realSpec)) {
    return {
      ok: false,
      error: { code: 'FORBIDDEN_PATH', message: `Spec is outside the allowed project directory: ${resolved}` },
    };
  }

  try {
    accessSync(binary);
  } catch {
    return { ok: false, error: { code: 'ARCHIFY_NOT_FOUND', message: 'archify CLI not found at the resolved skill path.' } };
  }

  try {
    const raw = execFileSync('node', [binary, 'validate', 'architecture', realSpec, '--layout-json'], {
      encoding: 'utf8', cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024,
    });
    const jsonText = raw.slice(raw.indexOf('{'));
    if (!jsonText) throw new Error('archify validate produced no JSON output');
    const ir = JSON.parse(jsonText);
    if (!ir || typeof ir !== 'object' || !Array.isArray(ir.components)) {
      throw new Error('archify validate returned an object without a components array');
    }
    return { ok: true, data: { ir, specPath: realSpec } };
  } catch (e) {
    return { ok: false, error: { code: 'CLI_ERROR', message: `archify validate failed: ${String((e && e.message) || e)}` } };
  }
}

/**
 * runArchifyValidate(specPath) -> { ok, data } | { ok: false, error }
 *
 * Runs `archify validate architecture <spec> --layout-json`, the same CLI call
 * the unit tests use, which is what produces a resolved IR (x/y/width/height
 * already laid out) that importArchifyIR can consume without a second path.
 * `--quality standard` is deliberately NOT requested here: the shape of the
 * returned layout JSON is identical for either quality, and validate's job for
 * the importer is to produce the IR, not to grade the spec.
 */
export function runArchifyValidate(specPath) {
  const resolved = resolveSpecPath(specPath);
  if (!resolved) {
    return { ok: false, error: { code: 'BAD_INPUT', message: 'No archify spec path provided.' } };
  }

  // Fail loudly (with a code the UI can turn into a message) when the CLI is not
  // actually installed, instead of letting execFileSync throw a cryptic ENOENT.
  try {
    accessSync(ARCHIFY_BIN);
  } catch {
    return {
      ok: false,
      error: {
        code: 'ARCHIFY_NOT_FOUND',
        message: 'archify CLI not found. Install the archify skill so it lives at ' + ARCHIFY_BIN,
      },
    };
  }

  try {
    const raw = execFileSync(
      'node',
      [ARCHIFY_BIN, 'validate', 'architecture', resolved, '--layout-json'],
      { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }
    );
    // archify's validate prints prose around the JSON receipt; the IR is the
    // first JSON object in stdout. Same extraction the tests do.
    const jsonText = raw.slice(raw.indexOf('{'));
    if (!jsonText) {
      throw new Error('archify validate produced no JSON output');
    }
    const ir = JSON.parse(jsonText);
    if (!ir || typeof ir !== 'object' || !Array.isArray(ir.components)) {
      throw new Error('archify validate returned an object without a components array');
    }
    return { ok: true, data: { ir, specPath: resolved } };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'CLI_ERROR',
        message: `archify validate failed: ${String((e && e.message) || e)}`,
      },
    };
  }
}
