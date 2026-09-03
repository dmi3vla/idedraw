import { execFileSync } from 'node:child_process';

const combos = [
  ['full', 'light', 'draw-and-ask'],
  ['full', 'dark', 'draw-and-ask'],
  ['chat-only', 'light', 'none'],
  ['canvas-only', 'dark', 'draw-and-ask'],
];

for (const [mode, theme, scenario] of combos) {
  console.log(`\n--- Capturing mode=${mode} theme=${theme} scenario=${scenario} ---`);
  const out = execFileSync(
    'npx',
    ['electron', '.', `--mode=${mode}`, `--theme=${theme}`, `--scenario=${scenario}`, '--visual-proof', '--no-sandbox'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' } }
  );
  console.log(out.trim().split('\n').filter(l => l.startsWith('WROTE')).join('\n'));
}
console.log('\nAll visual proofs captured in artifacts/.');
