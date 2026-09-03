import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(dirname, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const themes = ['dark', 'light'];

let anyFail = false;

for (const theme of themes) {
  console.log(`\n--- archify-ast-anchor (${theme}) ---`);
  let out;
  try {
    out = execFileSync(
      'npx',
      ['electron', '.', '--mode=full', `--theme=${theme}`, '--scenario=archify-ast-anchor', '--visual-proof', '--no-sandbox'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }, timeout: 180000 }
    );
  } catch (e) {
    out = (e.stdout || '') + '\n' + (e.stderr || '');
  }

  const passed = out.includes('ARCHIFY-AST-ANCHOR: ALL CHECKS PASSED');
  const screenshot = path.join(artifacts, `archify-ast-anchor-${theme}.png`);
  const wrote = existsSync(screenshot);
  const jsonPath = path.join(artifacts, `archify-ast-anchor-${theme}.json`);
  const wroteJson = existsSync(jsonPath);
  let jsonOk = false;
  try {
    jsonOk = !!JSON.parse(readFileSync(jsonPath, 'utf8')).ok;
  } catch { jsonOk = false; }

  if (passed) {
    const lines = out.split('\n').filter((l) => l.includes('ARCHIFY-AST-ANCHOR'));
    console.log(lines.join('\n'));
  } else {
    console.log(out.trim().split('\n').filter((l) => /PROBLEM|FAILED|FATAL|Error/.test(l)).join('\n'));
  }
  console.log(`${theme}: scenario ${passed ? 'PASS' : 'FAIL'} · screenshot ${wrote ? `written (${screenshot})` : 'MISSING'} · json ${jsonOk ? 'ok' : 'missing/invalid'} (${jsonPath})`);

  if (!passed || !wrote || !jsonOk) anyFail = true;
}

console.log(anyFail ? '\nAST-ANCHOR PROOF: PROBLEM(S)' : '\nAST-ANCHOR PROOF: ALL CHECKS PASSED');
process.exit(anyFail ? 1 : 0);
