// Frozen tool execution (plan S4.2.1). The AgentRunContext freezes the prompt and
// the allowed-tool list, but the reviewer correctly flagged that the ACTUAL
// execution of project.* and archify.* tools still re-reads main's CURRENT global
// state (getProjectRoot(), resolveArchifyBinary(), readSkillProfile()) at call
// time. A mid-turn change to the linked project or to the Archify skill would then
// diverge from the receipt's snapshot.
//
// To make execution reproducible, a tool call is routed by NAME:
//   - canvas.*  -> the renderer (owns Excalidraw; the only one who can mutate the scene)
//   - project.* -> executed HERE in main, strictly against the frozen ctx.projectRoot
//   - archify.* -> executed HERE in main, strictly against the frozen ctx.archify
//
// The model never receives the internal context id; the turn passes its own frozen
// `ctx` down through the closure. These functions are pure (import only the stdlib
// + the same implementations the IPC handlers call) so they can be unit-tested
// without booting Electron, including the "change global state mid-turn" case.

import path from 'node:path';

import { authorArchify } from './archify-author.mjs';
import { readArchifySkillFile } from './archify-skill-files.mjs';
import { listProjectFiles, readProjectFile, searchProjectFiles, getProjectSnapshot } from './project/project-fs.mjs';

/**
 * Classify a tool_use name into the executor that handles it:
 *   'canvas'   -> renderer
 *   'project'  -> main (frozen ctx.projectRoot)
 *   'archify'  -> main (frozen ctx.archify)
 *   null       -> not a chat-executable tool (upstream allowlist gating also applies)
 */
export function classifyTool(name) {
  if (typeof name !== 'string') return null;
  if (name.startsWith('canvas.')) return 'canvas';
  if (name.startsWith('project.')) return 'project';
  if (name.startsWith('archify.')) return 'archify';
  return null;
}

/**
 * Execute a project.* tool in main against the FROZEN ctx.projectRoot. It never
 * calls getProjectRoot() — the root comes from the turn context, not from whatever
 * the user linked mid-turn. Returns a Bridge-style result ({ ok, data } | { ok:false, error }).
 */
export function executeProjectTool(ctx, name, input = {}) {
  const root = ctx && ctx.projectRoot;
  if (!root && name !== 'project.getStatus') {
    return { ok: false, error: { code: 'NOT_LINKED', message: 'No project linked — choose a project directory first.' } };
  }
  switch (name) {
    case 'project.getStatus':
      return { ok: true, data: { linked: !!root, projectId: root ? path.basename(root) : null } };
    case 'project.listFiles':
      return listProjectFiles(root);
    case 'project.readFile':
      return readProjectFile(root, (input && input.rel) || '');
    case 'project.search':
      return searchProjectFiles(root, (input && input.query) || '');
    case 'project.getSnapshot':
      return getProjectSnapshot(root);
    default:
      return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `No such project tool: ${name}` } };
  }
}

/**
 * Execute an archify.* tool in main against the FROZEN ctx.archify
 * ({ root, binary, skillHash, profile }). It never re-reads the skill store at
 * call time, so disabling/changing the Archify skill mid-turn cannot silently swap
 * the CLI mid-run — the binary/hash/profile are pinned for the whole turn.
 * Returns a Bridge-style result.
 */
export async function executeArchifyTool(ctx, name, input = {}) {
  const arch = ctx && ctx.archify;
  if (!arch) {
    return { ok: false, error: { code: 'SKILL_DISABLED', message: 'Archify skill is not enabled.' } };
  }
  // Repair budget comes from the FROZEN profile, not from a re-read of the store,
  // so a mid-turn profile edit cannot enlarge the budget on this turn.
  const profile = arch.profile || {};
  const budget = Number.isFinite(profile.maxRepairRounds) ? Math.max(0, Math.trunc(profile.maxRepairRounds)) : 2;

  if (name === 'archify.author') {
    const result = await authorArchify({
      type: (input && input.type) || '',
      candidate: (input && input.candidate) || null,
      quality: (input && input.quality) || 'showcase',
      maxRepairRounds: budget,
      runToken: (input && input.runToken) || undefined,
      appUserData: ctx.appUserData,
      binary: arch.binary,
      skillHash: arch.skillHash || null,
    });
    // A failed author must not dead-end the turn: a weak model sees {ok:false}
    // and stops with an empty end_turn instead of repairing. Attach the recovery
    // action INSIDE the same JSON (parseArchifyResult and the scripted repair
    // loop keep working) so the model always knows the next step.
    if (result && result.ok === false) {
      const exhausted = result.error && result.error.code === 'REPAIR_BUDGET_EXHAUSTED';
      return {
        ...result,
        retry: exhausted
          ? { action: 'new_run', hint: 'Исправь candidate по error/diagnostics и вызови archify.author снова БЕЗ runToken — бюджет repair этого run исчерпан.' }
          : { action: 'repair', hint: 'Исправь candidate по error/diagnostics и вызови archify.author снова с тем же runToken из этого результата.' },
      };
    }
    return result;
  }
  if (name === 'archify.getSkillFile') {
    return readArchifySkillFile(arch.root, { kind: (input && input.kind) || '', type: (input && input.type) || '' });
  }
  return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `No such archify tool: ${name}` } };
}

/**
 * Convert a Bridge-style result into the STRING content fed back as a tool_result.
 * On success: the data (string or JSON). On failure: the full result JSON so the
 * model sees error code + diagnostics (e.g. archify validation diagnostics) rather
 * than a lossy one-line message.
 */
export function toToolContent(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');
  if (result.ok) {
    if (typeof result.data === 'string') return result.data;
    return JSON.stringify(result.data);
  }
  // Preserve error + diagnostics for repair loops.
  return JSON.stringify(result);
}

/**
 * True when a tool name is a `project.*` or `archify.*` tool that main should
 * execute directly (rather than delegating to the renderer).
 */
export function isMainExecuted(name) {
  const kind = classifyTool(name);
  return kind === 'project' || kind === 'archify';
}
