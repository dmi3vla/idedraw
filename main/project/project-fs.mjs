// Project file tools (plan slice S5). These run in the MAIN process, where fs
// access is available, and are surfaced to the agent as chat tools via the
// projectBridge IPC surface.
//
// READS vs THE ONE WRITE
//   - Everything the AGENT can reach is read-only: it may inspect a linked
//     project to gather evidence for an archify candidate, and no agent tool
//     writes into the project.
//   - `writeProjectTextFile` is the single exception and is NOT an agent tool.
//     It backs the user-driven AST editor save and is exposed only through
//     main/ipc/editor.ipc.mjs, which requires a matching project snapshot and an
//     in-scope anchor path. (The old header claimed this module never writes,
//     which stopped being true when the editor landed.)
//
// SAFETY CONTRACT
//   - Every path is resolved against a single allowed root.
//   - `../` in a relative path is rejected; escaping the root is impossible.
//   - Symlinks that point outside the root are refused (realpath guard).
//   - Binary files are never returned; secret-ish patterns are skipped.
//   - Count / line / byte caps bound the blast radius of a big project.

import { readdirSync, readFileSync, statSync, realpathSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_FILES = 2000; // caps the walk; enough for evidence, not a full repo dump
const MAX_BYTES = 256 * 1024; // per-file read cap (avoid shipping huge files)
const MAX_PATH_DEPTH = 32; // refuse absurdly deep trees

// Files we never read (build output, node_modules, vendored, editor swaps).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.hg', '.svn', '.next', '.cache', 'coverage']);
// Extensions we consider safe text. Everything else is treated as binary.
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdown', '.txt', '.sh', '.py', '.rb', '.go', '.rs', '.java', '.html', '.css', '.scss', '.sass', '.yaml', '.yml', '.toml', '.xml', '.sql', '.vue', '.svelte', '.svg']);
// Path segments that look secret and should not leak to the model.

// ---- path guards ------------------------------------------------------------

function isInside(rootReal, childReal) {
  const rel = path.relative(rootReal, childReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve `rel` against `root`, refusing traversal or symlink escape. */
export function resolveInside(root, rel) {
  if (!root || !rel) return null;
  const rootReal = (() => { try { return realpathSync(root); } catch { return null; } })();
  if (!rootReal) return null;
  // A relative path that is absolute or starts with '..' is rejected outright.
  const normalized = path.normalize(String(rel));
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('..' + path.sep)) {
    return null;
  }
  const joined = path.join(rootReal, normalized);
  // If the file does not exist yet we cannot realpath it; only refuse when the
  // lexical path is clean (no traversal). Existence is handled by the caller.
  if (!existsSync(joined)) return null;
  let childReal;
  try { childReal = realpathSync(joined); } catch { return null; }
  if (!isInside(rootReal, childReal)) return null;
  return childReal;
}

function looksBinary(buf) {
  // NUL byte in the first 8KB is a strong binary signal.
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  // High ratio of non-text bytes (mostly control chars outside \t\n\r).
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b < 7 || (b > 13 && b < 32)) odd++;
  }
  return n > 0 && odd / n > 0.3;
}

// Precise secret detection. We do NOT naivly `includes('key')` — that would
// hide keyboard.ts / keymap.js. Instead match exact well-known secret file names
// and reject config/cred paths that carry the secret markers.
const SECRET_FILE_NAMES = new Set(['.env', '.env.local', '.env.development', '.env.production', '.npmrc', '.pypirc', '.netrc', '.ssh', 'id_rsa', 'id_ed25519', '.git-credentials', '.htpasswd', 'secrets.json', 'credentials.json', '.pem', '.key', '.p12', '.pfx']);
const SECRET_PREFIXES = ['id_rsa', 'id_ed25519', '.env.', 'credentials', 'secret', '.pem', '.p12'];
const SECRET_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', 'credentials.json', 'secret.json'];

function isSecret(p) {
  const lower = String(p).toLowerCase();
  const base = path.basename(lower);
  if (SECRET_FILE_NAMES.has(base)) return true;
  if (SECRET_FILE_NAMES.has(lower)) return true;
  // Any segment equal to one of the exact markers, or a known secret-suffix.
  const segments = lower.split(path.sep);
  for (const seg of segments) {
    if (seg === '.ssh' || seg === '.aws' || seg === '.gnupg') return true;
    for (const prefix of SECRET_PREFIXES) if (seg.startsWith(prefix)) return true;
    for (const suffix of SECRET_SUFFIXES) if (seg.endsWith(suffix)) return true;
  }
  return false;
}

function isTextFile(p) {
  return TEXT_EXT.has(path.extname(p).toLowerCase());
}

// ---- public API -------------------------------------------------------------

/** List files under a root (relative paths), optionally filtered. */
export function listProjectFiles(root, opts = {}) {
  const rootReal = (() => { try { return realpathSync(root); } catch { return null; } })();
  if (!rootReal) return { ok: false, error: { code: 'BAD_ROOT', message: `Not a directory: ${root}` } };
  const out = [];
  let truncated = false;

  const walk = (dir, depth) => {
    if (out.length >= MAX_FILES || depth > MAX_PATH_DEPTH) {
      if (out.length >= MAX_FILES) truncated = true;
      return;
    }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) { truncated = true; break; }
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      let real;
      try { real = realpathSync(full); } catch { continue; }
      if (!isInside(rootReal, real)) continue; // symlink escape refused
      const rel = path.relative(rootReal, full);
      try {
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile()) {
          const st = statSync(full);
          if (!isTextFile(full)) continue; // not text -> skip silently
          if (isSecret(rel)) continue; // secret-ish path -> never list content
          out.push({ rel, size: st.size, mtime: st.mtimeMs });
        }
      } catch { /* unreadable entry: skip */ }
    }
  };

  walk(rootReal, 0);
  return {
    ok: true,
    data: {
      files: out.slice(0, MAX_FILES),
      total: out.length,
      truncated,
    },
  };
}

/** Read one file as UTF-8 text (capped), refusng binary / secret / traversal. */
export function readProjectFile(root, rel, opts = {}) {
  const target = resolveInside(root, rel);
  if (!target) {
    // Distinguish a path that escapes the root from one that merely does not
    // exist yet: the latter should read as NOT_FOUND, the former as forbidden.
    if (isLexicalEscape(rel)) {
      return { ok: false, error: { code: 'FORBIDDEN_PATH', message: `Path escapes the project root: ${rel}` } };
    }
    return { ok: false, error: { code: 'NOT_FOUND', message: `Not found: ${rel}` } };
  }
  if (isSecret(rel)) {
    return { ok: false, error: { code: 'FORBIDDEN_PATH', message: `Refused secret-like path: ${rel}` } };
  }
  let st;
  try { st = statSync(target); } catch { return { ok: false, error: { code: 'NOT_FOUND', message: `Not found: ${rel}` } }; }
  if (!st.isFile()) return { ok: false, error: { code: 'BAD_INPUT', message: `Not a file: ${rel}` } };
  if (st.size > MAX_BYTES) {
    return { ok: false, error: { code: 'TOO_LARGE', message: `File too large (${st.size} bytes). Not sent to the model.` } };
  }
  if (!isTextFile(rel)) {
    return { ok: false, error: { code: 'BINARY', message: `Refused binary file: ${rel}` } };
  }
  const buf = readFileSync(target);
  if (looksBinary(buf)) {
    return { ok: false, error: { code: 'BINARY', message: `Refused binary file: ${rel}` } };
  }
  const text = buf.toString('utf8');
  const maxLines = opts.maxLines || 400;
  const lines = text.split(/\r?\n/);
  const truncated = lines.length > maxLines;
  const body = lines.slice(0, maxLines).join('\n');
  return { ok: true, data: { rel, lines: lines.length, truncated, content: body } };
}

/** Atomically replace one existing, safe text file inside the linked project. */
export function writeProjectTextFile(root, rel, content, opts = {}) {
  const target = resolveInside(root, rel);
  if (!target || isLexicalEscape(rel)) {
    return { ok: false, error: { code: 'FORBIDDEN_PATH', message: `Refused path: ${rel}` } };
  }
  if (isSecret(rel) || !isTextFile(rel)) {
    return { ok: false, error: { code: 'FORBIDDEN_PATH', message: `Refused non-source path: ${rel}` } };
  }
  if (typeof content !== 'string') return { ok: false, error: { code: 'BAD_INPUT', message: 'Source content must be text.' } };
  const byteCap = Math.max(1, Math.min(MAX_BYTES, Number(opts.maxBytes) || MAX_BYTES));
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > byteCap) return { ok: false, error: { code: 'TOO_LARGE', message: `Edited file exceeds ${byteCap} bytes.` } };
  const temp = `${target}.canvas-edit-${process.pid}.tmp`;
  try {
    const current = statSync(target);
    if (!current.isFile()) return { ok: false, error: { code: 'BAD_INPUT', message: `Not a file: ${rel}` } };
    writeFileSync(temp, content, { encoding: 'utf8', mode: current.mode & 0o777 });
    renameSync(temp, target);
    return { ok: true, data: { rel, bytes, lines: content.split(/\r?\n/).length } };
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch {}
    return { ok: false, error: { code: 'WRITE_FAILED', message: error?.message || String(error) } };
  }
}

// Поиск без учёта регистра без аллокации полной lowercase-копии файла.
function includesInsensitive(haystack, needleLower) {
  if (!haystack || !needleLower) return false;
  return haystack.toLowerCase().includes(needleLower);
}

function isLexicalEscape(rel) {
  const normalized = path.normalize(String(rel || ''));
  return path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('..' + path.sep);
}

/** Search file names + text matches for a query. Returns capped matches. */
export function searchProjectFiles(root, query, opts = {}) {
  const q = String(query || '').toLowerCase();
  if (!q) return { ok: false, error: { code: 'BAD_INPUT', message: 'Empty search query.' } };
  const listed = listProjectFiles(root);
  if (!listed.ok) return { ok: false, error: listed.error };
  const maxResults = opts.maxResults || 40;
  const results = [];
  const seen = new Set();
  for (const f of listed.data.files) {
    if (results.length >= maxResults) break;
    const relLower = f.rel.toLowerCase();
    if (relLower.includes(q)) {
      results.push({ rel: f.rel, where: 'name' });
      seen.add(f.rel);
      continue;
    }
    if (seen.has(f.rel)) continue;
    const r = readProjectFile(root, f.rel);
    if (r.ok && includesInsensitive(r.data.content, q)) {
      results.push({ rel: f.rel, where: 'content' });
      seen.add(f.rel);
    }
  }
  return {
    ok: true,
    data: { query, results, truncated: results.length >= maxResults },
  };
}

// A content-derived project snapshot. SHA-256 over a canonical, sorted record
// of `rel + NUL + contentHash + NUL + size` — far more collision-resistant than
// a sum of path lengths/sizes/mtimes, and independent of metadata/now() variance.
// Content hashes are computed lazily per file and the cost is bounded by MAX_FILES.
function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Кэш контент-хешей по (путь, size, mtime). Снимок берётся минимум дважды за
// генерацию (до и после хода) плюс один раз в чек-листе контекста турна, так что
// неизменённые файлы хешируются один раз. Кэш ограничен MAX_FILES.
const snapshotHashCache = new Map(); // `rel|size|mtime` -> sha256

function cachedContentHash(absPath, rel, size, mtime) {
  const key = `${rel}|${size}|${mtime}`;
  const hit = snapshotHashCache.get(key);
  if (hit) return hit;
  let digest;
  try {
    // Хешируем сразу байты: без utf8-декода, без split('\n')/join('\n').
    digest = createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    digest = createHash('sha256').update('', 'utf8').digest('hex');
  }
  if (snapshotHashCache.size > MAX_FILES) snapshotHashCache.clear();
  snapshotHashCache.set(key, digest);
  return digest;
}

export function getProjectSnapshot(root) {
  const listed = listProjectFiles(root);
  if (!listed.ok) return { ok: false, error: listed.error };
  const files = listed.data.files;
  const rootReal = (() => { try { return realpathSync(root); } catch { return root; } })();
  const records = [];
  let totalBytes = 0;
  for (const f of files) {
    totalBytes += f.size;
    const digest = cachedContentHash(path.join(rootReal, f.rel), f.rel, f.size, f.mtime);
    records.push(`${f.rel}\0${digest}\0${f.size}`);
  }
  records.sort(); // канонический порядок, независимый от readdir
  const fingerprint = createHash('sha256').update(records.join('\0'), 'utf8').digest('hex');
  return {
    ok: true,
    data: {
      fileCount: files.length,
      totalBytes,
      fingerprint,
    },
  };
}
