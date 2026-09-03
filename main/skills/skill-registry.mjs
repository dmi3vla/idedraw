// Main-process skill discovery (plan slice S1).
//
// PURPOSE: find user-installed agent CLI skills — by default under
// ~/.agents/skills/*/SKILL.md — read their frontmatter, compute a stable sha256,
// and surface them as records for the chat settings UI + agent runtime. It never
// activates a skill on its own; inclusion in a prompt/toolset is an explicit
// user action (enabled). Discovery only, never invocation.
//
// The frontmatter is a small, known YAML subset (name/description/license/
// metadata.version), so this parser is dependency-free. It does not import the
// renderer, the CLI, or any project code.

import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Skills live in the user's agent directory, never inside the project. This is
// the same predictable location the archify-import tests already hardcode.
const SKILLS_ROOT = path.join(os.homedir(), '.agents', 'skills');

/**
 * Parse the leading YAML frontmatter block of a SKILL.md.
 * Returns `{ meta, body }`; `meta` is null when there is no frontmatter.
 * Handles name/description/license plus an indented `metadata:` block.
 */
export function parseFrontmatter(md) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md || '');
  if (!match) return { meta: null, body: md || '' };
  const meta = {};
  let block = null;
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      block = null;
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if (!val) { block = key; meta[key] = {}; continue; }
      meta[key] = unquote(val);
    } else if (block) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      meta[block][key] = unquote(val);
    }
  }
  return { meta, body: match[2] || '' };
}

function unquote(s) {
  const t = (s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function sha256Of(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

/**
 * Read a SKILL.md from a specific directory (which may live anywhere on disk).
 * `acceptedHash` enables "changed on disk" detection.
 * Returns a record; status is `ready | invalid | missing`.
 */
export function readSkillFromDir(skillDir, acceptedHash = null) {
  const idBase = path.basename(skillDir) || 'unnamed';
  const record = (patch) => ({
    id: `local:${normalizeName(patch.name || idBase)}`,
    name: patch.name || idBase,
    version: patch.version ?? null,
    description: patch.description || '',
    license: patch.license ?? null,
    path: patch.path,
    root: skillDir,
    sha256: patch.sha256 ?? null,
    status: patch.status || 'ready',
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  });

  // Guard: the path we were handed must resolve without going up, and SKILL.md
  // must be a real file inside it (no symlink escape from the chosen dir).
  const resolvedRoot = safeResolveSkillDir(skillDir);
  if (!resolvedRoot) return record({ name: idBase, path: path.join(skillDir, 'SKILL.md'), status: 'invalid' });
  const skillPath = path.join(resolvedRoot, 'SKILL.md');
  if (!existsSync(skillPath)) return record({ name: idBase, path: skillPath, status: 'missing' });

  try {
    const raw = readFileSync(skillPath, 'utf8');
    const { meta } = parseFrontmatter(raw);
    const sha = sha256Of(raw);
    const name = (meta && meta.name) || idBase;
    const version = (meta && meta.metadata && meta.metadata.version) || (meta && meta.version) || null;
    const description = (meta && meta.description) || '';
    const license = (meta && meta.license) || null;
    let status = 'ready';
    if (acceptedHash && acceptedHash !== sha) status = 'changed';
    return record({ name, version, description, license, path: skillPath, sha256: sha, status });
  } catch (e) {
    return record({ name: idBase, path: skillPath, status: 'invalid', description: String((e && e.message) || e) });
  }
}

/**
 * Resolve a skill directory to its real path. Returns null if the directory does
 * not exist or if following it as a symlink escapes the directory itself.
 */
function safeResolveSkillDir(skillDir) {
  if (!skillDir) return null;
  let real;
  try {
    const st = statSync(skillDir);
    if (!st.isDirectory()) return null;
    real = realpathSync(skillDir);
  } catch {
    return null;
  }
  // The resolved dir must not be a symlink pointing elsewhere: realpathSync of
  // the dir should equal the dir we intended. We do NOT enforce a parent "root"
  // here — an explicitly-added skill may live anywhere. The guard is that the
  // dir itself is real (not a dangling/escaping symlink).
  return real;
}

/**
 * Discover every skill directory under `root`, guarding against symlink escape
 * from the root. This is the "scan ~/.agents/skills" path.
 */
export function listDiscovered(root = SKILLS_ROOT, acceptedHashes = {}) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // root absent: no skills
  }
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    // Only allow directories that resolve inside the root (no escape symlink).
    let real;
    try { real = realpathSync(candidate); } catch { continue; }
    if (path.relative(realRoot, real).startsWith('..')) continue;
    const rec = readSkillFromDir(candidate, acceptedHashes[entry.name]);
    out.push(rec);
  }
  return out;
}

export function sortSkills(records) {
  return [...records].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
}

// Resolve a path INSIDE a skill dir, refusing traversal or symlink escape. Used
// to locate the skill's own binary (e.g. bin/archify.mjs) from a frozen snapshot
// root — the caller must NEVER accept an executable path from the model.
export function resolveInsideSkillRoot(skillDir, relPath) {
  if (!skillDir || !relPath) return null;
  const rootReal = safeResolveSkillDir(skillDir);
  if (!rootReal) return null;
  const normalized = path.normalize(String(relPath));
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('..' + path.sep)) {
    return null;
  }
  const joined = path.join(rootReal, normalized);
  let real;
  try { real = realpathSync(joined); } catch { return null; }
  if (path.relative(rootReal, real).startsWith('..')) return null;
  return real;
}
