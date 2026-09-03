// Moved out of main.mjs (refactor rule 5). Still MAIN-ONLY: never exposed
// through preload/IPC, so a renderer/XSS cannot pivot the read tools to an
// arbitrary directory. It just no longer lives in production code.
// MAIN-ONLY test hook. Sets the linked project root for an acceptance scenario.
// It is NEVER exposed through preload/IPC — the renderer cannot call it, so a
// renderer/XSS cannot pivot the read tools to an arbitrary directory.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { setProjectRoot } from '../../main/project/project-root.mjs';
import { APP_ROOT } from './paths.mjs';

export function setTestProjectRoot(root) {
  return setProjectRoot(root);
}

// Replaces the hardcoded developer home-directory path. Prefers ARCHIFY_EXAMPLES_DIR,
// falls back to the in-repo fixture project, and fails loudly instead of
// silently linking a directory that only existed on one developer's machine.
export function archifyExamplesDir() {
  const fromEnv = process.env.ARCHIFY_EXAMPLES_DIR;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`ARCHIFY_EXAMPLES_DIR does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const fixture = path.join(APP_ROOT, 'tests', 'fixture-project');
  if (!existsSync(fixture)) {
    throw new Error('No Archify examples dir: set ARCHIFY_EXAMPLES_DIR or restore tests/fixture-project.');
  }
  return fixture;
}
