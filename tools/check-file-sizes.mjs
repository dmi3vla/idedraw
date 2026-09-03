// Definition of Done, executable: no file under main/ may exceed 400 lines and
// main.mjs must stay a bootstrap. A god-file grows back one "just this once"
// at a time, so the limit is checked by CI rather than by reviewers.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMITS = [
  { dir: 'main', max: 400 },
  { dir: 'scenarios', max: 700 },
];
const MAIN_MAX = 150;
// Refactor rule 8 forbids touching these two pre-existing modules, so they are
// grandfathered explicitly rather than silently ignored: the limit still applies
// to every file this refactor created or moved. Shrinking them is separate work.
const GRANDFATHERED = new Set(['main/agent-scripted-model.mjs', 'main/evidence-builder.mjs']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (/\.(mjs|cjs|js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
}

const violations = [];
const mainLines = readFileSync(path.join(ROOT, 'main.mjs'), 'utf8').split('\n').length;
if (mainLines > MAIN_MAX) violations.push(`main.mjs: ${mainLines} lines (max ${MAIN_MAX})`);

for (const { dir, max } of LIMITS) {
  const abs = path.join(ROOT, dir);
  try { statSync(abs); } catch { continue; }
  for (const file of walk(abs)) {
    const rel = path.relative(ROOT, file);
    if (GRANDFATHERED.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n').length;
    if (lines > max) violations.push(`${rel}: ${lines} lines (max ${max})`);
  }
}

if (violations.length) {
  console.error('FILE SIZE LIMIT EXCEEDED:');
  for (const v of violations) console.error('  - ' + v);
  process.exit(1);
}
console.log('file sizes OK');
