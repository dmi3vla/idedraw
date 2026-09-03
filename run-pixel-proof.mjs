// S7 mandatory dark/light ELECTRON PIXEL GATE.
//
// The reviewer's live pixel acceptance is the arbiter of "no horizontal label
// clipping": it reads the REAL rendered canvas (not stored text.width) per node
// and requires every node to keep >= 8px of visible padding on BOTH sides.
// This script runs the `archify-import` scenario for dark AND light, then FAILS
// (exit 1) unless every gate holds regardless of what the scenario itself printed:
//
//   * archify-import-pixel-<theme>.json -> ok === true
//   * all 11 nodes satisfy lPad >= 8 AND rPad >= 8
//   * nullExtent is empty (no node whose label measured no ink)
//   * overflow is empty (no node whose label touches/surpasses a border)
//
// Wired as `npm run verify:pixel` and into `verify:visual` + CI, so a red pixel
// gate cannot be skipped. The threshold is NOT lowered here; if it fails, fix the
// S7 glyph coefficients / horizontal guard, then re-run.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(dirname, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const themes = ['dark', 'light'];
const MIN_PAD = 8;

let anyFail = false;

function gateSummary(theme, json) {
  const per = json.per || [];
  const bad = per.filter((p) => p.lPad === null || p.rPad === null || p.lPad < MIN_PAD || p.rPad < MIN_PAD);
  const fail = {
    ok: json.ok === true,
    nodes: per.length,
    nullExtent: (json.nullExtent || []).length,
    overflow: (json.overflow || []).length,
  };
  return { per, bad, fail };
}

for (const theme of themes) {
  console.log(`\n--- archify-import pixel gate (${theme}) ---`);
  let out;
  try {
    out = execFileSync(
      'npx',
      ['electron', '.', '--mode=full', `--theme=${theme}`, '--scenario=archify-import', '--visual-proof', '--no-sandbox'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }, timeout: 180000 }
    );
  } catch (e) {
    out = (e.stdout || '') + '\n' + (e.stderr || '');
  }
  const scenarioPassed = out.includes('ARCHIFY-IMPORT: ALL CHECKS PASSED');

  const jsonPath = path.join(artifacts, `archify-import-pixel-${theme}.json`);
  const pngPath = path.join(artifacts, `archify-import-${theme}.png`);
  let json = null;
  try { json = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { json = null; }

  if (!json) {
    console.log(`${theme}: pixel JSON missing/invalid — GATE FAIL`);
    anyFail = true;
    continue;
  }

  const { per, bad, fail } = gateSummary(theme, json);
  // Print a compact per-node pad table so downstream CI logs are useful.
  for (const p of per) {
    const flag = (p.lPad === null || p.rPad === null || p.lPad < MIN_PAD || p.rPad < MIN_PAD) ? ' <8!' : '';
    console.log(`  ${String(p.id).padEnd(18)} lPad=${String(p.lPad).padStart(4)} rPad=${String(p.rPad).padStart(4)}${flag}`);
  }

  const gates = [
    [`scenario ${theme} ALL CHECKS`, scenarioPassed],
    [`${theme} pixel ok===true`, fail.ok],
    [`${theme} nullExtent empty`, fail.nullExtent === 0],
    [`${theme} overflow empty`, fail.overflow === 0],
    [`${theme} all ${fail.nodes} nodes pad>=${MIN_PAD}`, bad.length === 0],
    [`${theme} PNG artifact exists`, existsSync(pngPath)],
    [`${theme} live overlapCount===0`, json.layoutSafety && json.layoutSafety.overlapCount === 0],
    [`${theme} live minimumRowGap>=32`, json.layoutSafety && json.layoutSafety.minimumRowGap >= 32],
  ];
  let broken = gates.filter(([, ok]) => !ok);
  for (const [label, ok] of gates) console.log(`  GATE ${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (broken.length) {
    console.log(`${theme}: PIXEL GATE BROKEN (${broken.map(([l]) => l).join('; ')})` + (bad.length ? ' -> ' + JSON.stringify(bad.map((b) => ({ id: b.id, lPad: b.lPad, rPad: b.rPad }))) : ''));
    anyFail = true;
  } else {
    console.log(`${theme}: PIXEL GATE PASSED (${fail.nodes} nodes, min pads within >=${MIN_PAD})`);
  }
}

console.log(anyFail ? '\nPIXEL GATE: PROBLEM(S) — S7 stays open' : '\nPIXEL GATE: ALL PASSED (dark + light)');
process.exit(anyFail ? 1 : 0);
