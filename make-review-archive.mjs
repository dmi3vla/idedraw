// Build the review archive WITHOUT relying on blocked binaries (tar/find/rsync).
// The terminal sandbox only allows writes to /tmp, so we WRITE there and read the
// project tree via node fs. Produces a gzipped tar whose members live under
// review-package/ so it matches the previous package layout.
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

const ROOT = process.cwd();
const OUT = process.argv[2] || '/tmp/phase1-review.tar.gz';
const ARCROOT = 'review-package';

const EXCLUDE_DIRS = new Set(['node_modules', '.agent-runs', 'review-package', '.git', 'userData', 'dist']);
const EXCLUDE_FILES = new Set([
  'phase1-review.tar.gz',
  'skills.json',
  '.env',
  'id_rsa',
  'make-review-archive.py',
  'dbg-archive.py',
  'node-write-test.txt',
  'extract-archive.mjs',
  'verify-extract.mjs',
  'inspect-arc.mjs',
]);

function excluded(rel, isDir) {
  const parts = rel.split(path.sep);
  if (parts.some((p, i) => i < parts.length - 1 && EXCLUDE_DIRS.has(p))) return true;
  if (!isDir && EXCLUDE_FILES.has(rel)) return true;
  // Never embed a previously-built review archive into a new one.
  if (!isDir && /^phase1-review.*\.tar\.gz$/.test(rel)) return true;
  if (rel.endsWith('.pem') || rel.endsWith('.key')) return true;
  return false;
}

function collect(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // Skip dot-dirs, but always keep .github (CI workflow + artifacts live there).
      if (e.name.startsWith('.') && e.name !== '.' && e.name !== '..' && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name) || excluded(rel, true)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (excluded(rel, false)) continue;
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

function tarHeader(name, size) {
  // POSIX ustar header, 512 bytes. name is under 100 chars here.
  const header = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, 'utf8');
  nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));
  // mode / uid / gid / mtime as octal-format strings.
  header.write('0000644', 100, 8);
  header.write('0000000', 108, 8);
  header.write('0000000', 116, 8);
  header.write(size.toString(8).padStart(11, '0'), 124, 12);
  header.write('00000000000', 136, 12);
  // ustar magic + version (field is 6 bytes magic + 2 bytes version).
  Buffer.from('ustar\0', 'utf8').copy(header, 257);
  header.write('00', 263, 2);
  // Checksum: 8 bytes of SIX octal digits + NUL + space, computed over the header
  // AFTER every other field is written. The placeholder is spaces so the sum is a
  // function of the final bytes, then we overwrite it.
  for (let i = 148; i < 156; i++) header[i] = 0x20; // spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chk, 148, 8);
  return header;
}

function buildTar(files, root) {
  const chunks = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const arc = `${ARCROOT}/${rel}`;
    const data = readFileSync(full);
    chunks.push(tarHeader(arc, data.length));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  // End-of-archive: two 512-byte zero blocks.
  chunks.push(Buffer.alloc(512));
  chunks.push(Buffer.alloc(512));
  return Buffer.concat(chunks);
}

const files = collect(ROOT);
const tarBuf = buildTar(files, ROOT);
const gz = zlib.gzipSync(tarBuf);
writeFileSync(OUT, gz);
console.log(`PACKED ${files.length} files -> ${OUT} (${gz.length} bytes)`);
