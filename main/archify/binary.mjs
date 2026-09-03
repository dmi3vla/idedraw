// Resolve the archify CLI binary from the FROZEN enabled archify skill.
// Takes the skill store as a parameter instead of reading a module-level
// `skillStoreInstance` (refactor rule 2/3).
import path from 'node:path';
import { resolveInsideSkillRoot } from '../skills/skill-registry.mjs';

// --- Phase 2: run the archify CLI (in main) and return the resolved IR -------
// The renderer triggers this from the Archify toolbar button via preload; the
// heavy lifting (spawn node archify.mjs validate --layout-json) happens here so
// the renderer never needs fs/child_process. Errors are returned as a structured
// { ok:false, error } the UI can render into a banner, not thrown to the console.
// Resolve the archify CLI binary from the FROZEN enabled archify skill. The
// model never nominates an executable; if archify is not enabled/ready there is
// no binary and authoring is refused. This keeps the runner tied to the skill
// the user actually enabled, not to a hardcoded home path.
export function resolveArchifyBinary(skillStore) {
  const store = skillStore;
  if (!store) return { ok: false, error: { code: 'SKILL_DISABLED', message: 'Skill registry unavailable.' } };
  const snaps = store.enabledSnapshots();
  const archify = snaps.find((s) => s.name === 'archify');
  if (!archify) {
    return { ok: false, error: { code: 'SKILL_DISABLED', message: 'Archify skill is not enabled — enable it in Chat → Skills first.' } };
  }
  // archifySnapshot.root is the skill dir; resolve bin/archify.mjs inside it.
  const root = archify.root || (archify.path ? path.dirname(archify.path) : null);
  if (!root) return { ok: false, error: { code: 'ARCHIFY_NOT_FOUND', message: 'Archify skill has no readable root.' } };
  const bin = resolveInsideSkillRoot(root, 'bin/archify.mjs');
  if (!bin) {
    return { ok: false, error: { code: 'ARCHIFY_NOT_FOUND', message: 'Could not locate bin/archify.mjs inside the enabled Archify skill.' } };
  }
  return { ok: true, binary: bin, root, skillHash: archify.sha256 };
}
