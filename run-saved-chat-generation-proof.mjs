import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifact = path.join(root, 'artifacts', 'saved-chat-generation.json');
try { unlinkSync(artifact); } catch {}
const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' };
// This proof must exercise the encrypted key saved by Chat settings. An env key
// would make the result ambiguous, so remove it explicitly from the child.
delete env.ARCHIFY_API_KEY;
let stdout = '';
try {
  stdout = execFileSync('npx', ['electron', '.', '--mode=full', '--scenario=saved-chat-generation', '--no-sandbox'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
} catch (error) {
  stdout = String(error.stdout || '') + '\n' + String(error.stderr || '');
}
let report = null;
try { if (existsSync(artifact)) report = JSON.parse(readFileSync(artifact, 'utf8')); } catch {}
const ok = stdout.includes('SAVED-CHAT-GENERATION: ALL CHECKS PASSED') && report && report.ok === true
  && report.keySource === 'safeStorage' && report.storedKeyPresent === true
  && report.usedStoredChatSettings === true && report.usedConfiguredModel === true
  && report.authorCompleted === true && report.projectReadCount > 0
  && report.savedExcalidraw === true;
console.log(stdout.split('\n').filter((line) => /SAVED-CHAT-GENERATION/.test(line)).join('\n'));
console.log(ok ? 'SAVED CHAT PROOF: ALL CHECKS PASSED' : 'SAVED CHAT PROOF: PROBLEM(S)');
process.exit(ok ? 0 : 1);
