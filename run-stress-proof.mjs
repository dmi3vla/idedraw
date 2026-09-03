// Automated stress-proof runner (plan stream D6/D7).
//
// Runs the SAME synthetic graph through two insertion paths at each scale
// checkpoint and produces comparable metrics:
//
//   bridge   — node batches via bridge.use_command('canvas.addNodes') and
//              per-edge canvas.addEdge calls (what a real agent does today)
//   baseline — the identical graph inserted with ONE direct updateScene call
//              (pure Excalidraw cost, no bridge layer)
//
// Plus a leak check: 10 x (add 500 -> remove 500) cycles with per-cycle RSS.
//
// Output: artifacts/stress-<mode>-<count>.json (+ .png screenshot per run,
// so "elements are really on screen" is verifiable, not asserted) and a
// summary table printed at the end.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COUNTS = [100, 500, 1500];
const MODES = ['bridge', 'baseline'];
const LEAK_CYCLES = 10;
const LEAK_COUNT = 500;
const RUN_TIMEOUT_MS = 300_000;

function runElectron(extraArgs) {
  execFileSync(
    'npx',
    ['electron', '.', '--mode=canvas-only', '--theme=light', '--no-sandbox', ...extraArgs],
    { encoding: 'utf8', cwd: __dirname, stdio: ['ignore', 'pipe', 'inherit'], timeout: RUN_TIMEOUT_MS }
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(__dirname, 'artifacts', file), 'utf8'));
}

const rows = [];

for (const count of COUNTS) {
  for (const mode of MODES) {
    console.log(`\n=== stress: mode=${mode} count=${count} ===`);
    runElectron(['--scenario=stress-test', `--count=${count}`, `--stress-mode=${mode}`, '--visual-proof']);
    rows.push(readJson(`stress-${mode}-${count}.json`));
  }
}

console.log(`\n=== leak check: ${LEAK_CYCLES} x (add ${LEAK_COUNT} -> remove ${LEAK_COUNT}) via bridge ===`);
runElectron(['--scenario=stress-test', `--count=${LEAK_COUNT}`, '--stress-mode=bridge', `--stress-cycles=${LEAK_CYCLES}`, '--visual-proof']);
const leak = readJson(`stress-bridge-${LEAK_COUNT}-cycles${LEAK_CYCLES}.json`);

console.log(`\n=== leak check with compaction: same cycles + canvas.compact ===`);
runElectron(['--scenario=stress-test', `--count=${LEAK_COUNT}`, '--stress-mode=bridge', `--stress-cycles=${LEAK_CYCLES}`, '--stress-compact', '--visual-proof']);
const leakCompacted = readJson(`stress-bridge-${LEAK_COUNT}-cycles${LEAK_CYCLES}-compacted.json`);

// --- D7: report ---------------------------------------------------------------

function pad(s, n) {
  return String(s).padStart(n);
}

console.log('\n================ STRESS REPORT ================');
console.log(
  pad('mode', 9) + pad('nodes', 7) + pad('edges', 7) +
  pad('addNodesMs', 12) + pad('addEdgesMs', 12) + pad('fillMs', 9) +
  pad('avgFps', 8) + pad('KB before', 11) + pad('KB after', 11)
);
console.log('-'.repeat(86));
for (const r of rows) {
  console.log(
    pad(r.mode, 9) + pad(r.nodes, 7) + pad(r.edges, 7) +
    pad(r.addNodesMs, 12) + pad(r.addEdgesMs ?? '-', 12) + pad(r.fillMs, 9) +
    pad(r.avgFps, 8) + pad(r.rssBefore.totalKb, 11) + pad(r.rssAfter.totalKb, 11)
  );
}

function printCycleTable(label, data) {
  console.log(`\n--- memory across add/remove cycles (${label}) ---`);
  console.log(pad('cycle', 7) + pad('addMs', 10) + pad('removeMs', 11) + pad('compactMs', 11) + pad('totalKb', 10) + pad('rendererKb', 12));
  for (const c of data.cycles || []) {
    console.log(pad(c.cycle, 7) + pad(c.addMs, 10) + pad(c.removeMs, 11) + pad(c.compactMs ?? '-', 11) + pad(c.mem.totalKb, 10) + pad(c.mem.rendererKb, 12));
  }
  const cyc = data.cycles || [];
  if (cyc.length > 1) {
    const drift = cyc[cyc.length - 1].mem.totalKb - cyc[0].mem.totalKb;
    const per = drift / (cyc.length - 1);
    console.log(`RSS drift across cycles 1->${cyc.length}: ${drift > 0 ? '+' : ''}${drift} KB (${per > 0 ? '+' : ''}${Math.round(per)} KB/cycle)`);
  }
}

printCycleTable('plain (auto-threshold only)', leak);
printCycleTable('explicit canvas.compact per cycle', leakCompacted);

if (leak.cycles && leakCompacted.cycles) {
  const last = (d) => d.cycles[d.cycles.length - 1].mem;
  console.log('\n--- compacted vs plain, end-of-run memory ---');
  console.log(pad('', 14) + pad('totalKb', 10) + pad('rendererKb', 12));
  console.log(pad('plain', 14) + pad(last(leak).totalKb, 10) + pad(last(leak).rendererKb, 12));
  console.log(pad('compacted', 14) + pad(last(leakCompacted).totalKb, 10) + pad(last(leakCompacted).rendererKb, 12));
  console.log(pad('run start', 14) + pad(leak.rssBefore.totalKb, 10) + pad(leak.rssBefore.rendererKb, 12));
}
console.log('\nAll stress artifacts in artifacts/stress-*.json / artifacts/stress-*.png');
