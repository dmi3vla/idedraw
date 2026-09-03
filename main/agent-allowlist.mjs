// Main-owned command allowlist for the agent runtime (plan S4.2). This is the
// SECURITY BOUNDARY for tool use: the renderer builds the `tools` array it sends
// to the chat, but the main process does NOT trust it. It computes its own
// allowlist from an explicit policy and intersects it with whatever the renderer
// offered, and it rejects any tool_use the model issues outside that allowlist.
//
// WHY THIS LIVES IN MAIN: the command-registry.mjs lives on the renderer side and
// imports the Excalidraw adapter / project store (which need `window`), so the
// main process cannot import it. The policy here is a deliberate, minimal,
// reviewable mirror of the chat-reachable surface. A skill-gated command (e.g.
// archify.author) is only allowed when that skill name is in the frozen enabled
// snapshot, and project.* read tools are only allowed when a project is linked.
//
// This module is pure: it imports only the standard library, so it can be
// unit-tested without booting Electron.

// Base, always-chat-reachable canvas commands (the chat-reachable subset of the
// renderer command registry; canvas.importArchify is notForChat and excluded).
const BASE_CANVAS_COMMANDS = new Set([
  'canvas.addNode',
  'canvas.addNodes',
  'canvas.updateNode',
  'canvas.removeNode',
  'canvas.removeNodes',
  'canvas.addEdge',
  'canvas.addEdges',
  'canvas.compact',
  'canvas.selectElement',
  'canvas.clearSelection',
  'canvas.fitToScreen',
  'canvas.linkProject',
  'canvas.unlinkProject',
]);

// Read-only project evidence tools. These are only allowed when a project is
// linked (the main-owned project root is set); otherwise the model must not be
// able to read anything.
const PROJECT_COMMANDS = new Set([
  'project.getStatus',
  'project.listFiles',
  'project.readFile',
  'project.search',
  'project.getSnapshot',
]);

// Sweep-through positioning tools for the AST frames (chat <-> frame). They are
// only reachable when a project is linked, exactly like project.*: without a
// project root there is no file to position on and nothing to read. Note that
// astFrame.proposeEdit does NOT write to disk — it fills the frame editor with a
// pending patch that the human still has to save — so the write boundary stays
// where it was (project-fs writeAstFile, with expectedSnapshot).
const AST_FRAME_COMMANDS = new Set([
  'astFrame.getScope',
  'astFrame.readScope',
  'astFrame.revealAt',
  'astFrame.proposeEdit',
]);

// Commands that a specific skill enables. The key is the skill NAME as it appears
// in the enabled snapshot. A command is only granted when that skill is enabled.
const SKILL_COMMANDS = new Map([
  ['archify', new Set(['archify.author', 'archify.getSkillFile'])],
]);

/**
 * Compute the main-owned allowlist for a chat turn.
 *
 * @param {{ skillNames?: string[], projectLinked?: boolean }} opts
 * @returns {Set<string>} the set of command names the model may call this turn.
 */
export function resolveAllowedCommands({ skillNames = [], projectLinked = false } = {}) {
  const allowed = new Set(BASE_CANVAS_COMMANDS);
  if (projectLinked) {
    for (const name of PROJECT_COMMANDS) allowed.add(name);
    for (const name of AST_FRAME_COMMANDS) allowed.add(name);
  }
  for (const name of skillNames) {
    const cmds = SKILL_COMMANDS.get(name);
    if (cmds) for (const c of cmds) allowed.add(c);
  }
  return allowed;
}

/**
 * Filter a renderer-provided tools array (each with `name`) down to the names the
 * main allowlist permits. Returns the filtered array. The renderer filter is
 * UX-only; this is the authoritative intersection at the security boundary.
 */
export function intersectToolsWithAllowlist(tools, allowedCommands) {
  if (!Array.isArray(tools)) return [];
  return tools.filter((t) => t && typeof t.name === 'string' && allowedCommands.has(t.name));
}

/** True when a tool_use name is permitted by the turn allowlist. */
export function isToolAllowed(name, allowedCommands) {
  return typeof name === 'string' && allowedCommands.has(name);
}
