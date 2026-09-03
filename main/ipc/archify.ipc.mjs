// archify:validate / author / readSkillFile, plus the generation endpoints that
// used to be buried in registerConfigIpc.
import { ipcMain } from 'electron';
import path from 'node:path';
import { runArchifyValidateScoped } from '../archify-client.mjs';
import { authorArchify } from '../archify-author.mjs';
import { readArchifySkillFile } from '../archify-skill-files.mjs';
import { getProjectRoot } from '../project/project-root.mjs';
import { readSkillProfile } from '../skill-profile.mjs';
import { resolveArchifyBinary } from '../archify/binary.mjs';
import { registerGenerationIpc } from '../archify/generation.mjs';

// `archifyValidateFallback` is injected ONLY by an acceptance scenario (see
// scenarios/index.mjs -> scenarioIpcOverrides). Production passes nothing, so
// a missing Archify skill keeps its strict ARCHIFY_NOT_FOUND refusal and this
// handler no longer inspects the global scenario name.
export function registerArchifyIpc({ app, skillStore, configStore, secretStore, agentRuntime, logger, archifyValidateFallback = null }) {
  ipcMain.handle('archify:validate', (event, input) => {
    // S4.1.1 hardening: the spec must live inside the main-owned project root,
    // and the CLI binary comes from the enabled Archify skill (not a hardcoded
    // home path and not a renderer-supplied path).
    const bin = resolveArchifyBinary(skillStore);
    if (!bin.ok) {
      // Acceptance-only fallback: drive the real toolbar flow with a fixture IR
      // when the archify binary is not installed (so the UI acceptance is still
      // live and CLI-robust). Production runs keep the strict refusal.
      if (archifyValidateFallback) return { ok: true, data: { ir: archifyValidateFallback(), specPath: null }, cliGated: false };
      return { ok: false, error: bin.error };
    }
    const projectRoot = getProjectRoot();
    if (!projectRoot) return { ok: false, error: { code: 'NOT_LINKED', message: 'No project linked — choose a project directory first.' } };
    const res = runArchifyValidateScoped((input && input.specPath) || null, { binary: bin.binary, root: projectRoot });
    return res.ok ? { ...res, cliGated: true } : res;
  });

  ipcMain.handle('archify:author', async (event, input) => {
    // The runner must be the enabled Archify skill's own binary, never a path the
    // caller chose. If archify is disabled we refuse before spawning anything.
    const bin = resolveArchifyBinary(skillStore);
    if (!bin.ok) return { ok: false, error: bin.error };
    // The repair budget is PROFILE-DRIVEN, never model-supplied. A model can ask
    // for 1000000 repairs; the skill profile cap wins. The run pins it at creation
    // and a continuation cannot raise it (see archify-runs.mjs).
    const profile = readSkillProfile(skillStore);
    const budget = (profile && Number.isFinite(profile.maxRepairRounds)) ? Math.max(0, Math.trunc(profile.maxRepairRounds)) : 2;
    return authorArchify({
      type: (input && input.type) || '',
      candidate: (input && input.candidate) || null,
      quality: (input && input.quality) || 'showcase',
      maxRepairRounds: budget,
      runToken: (input && input.runToken) || undefined,
      appUserData: app.getPath('userData'),
      binary: bin.binary,
      skillHash: bin.skillHash,
    });
  });

  // Read a known Archify skill file (schema/example/guide) from the ENABLED
  // skill root. The model only supplies kind + type, never a path, so it cannot
  // read arbitrary files. Refused when archify is not enabled.
  ipcMain.handle('archify:readSkillFile', (event, input) => {
    const bin = resolveArchifyBinary(skillStore);
    if (!bin.ok) return { ok: false, error: bin.error };
    const root = bin.root || (bin.binary ? path.dirname(bin.binary) : null);
    return readArchifySkillFile(root, { kind: (input && input.kind) || '', type: (input && input.type) || '' });
  });

  registerGenerationIpc({ ipcMain, configStore, secretStore, skillStore, agentRuntime, logger });
}
