// Shared "is a project linked?" guard. The renderer and the model never supply
// a root: the main process owns the canonical realpath of the linked project.
import { getProjectRoot } from '../project/project-root.mjs';

export function requireRoot() {
  const root = getProjectRoot();
  if (!root) {
    return { ok: false, error: { code: 'NOT_LINKED', message: 'No project linked — choose a project directory first.' } };
  }
  return { ok: true, root };
}
