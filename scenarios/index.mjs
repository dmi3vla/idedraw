// The scenario registry. This replaces the ~170-line `if (scenario === ...)`
// chain in main.mjs, including the "requires a mounted canvas" check that used
// to be copy-pasted into nine of those branches.
//
// Scenario modules are imported LAZILY: acceptance code is not loaded into the
// production main process on a normal `npm start`, which was the biggest
// complaint about the old god-file.

const SCENARIOS = {
  // draw-and-ask is the only non-terminal scenario: it seeds the canvas and then
  // falls through to the shared --visual-proof capture, exactly as before.
  'draw-and-ask': { load: () => import('./canvas/draw-and-ask.mjs'), skipUnlessCanvas: true, terminal: false },
  'stress-test': { load: () => import('./canvas/stress.mjs'), requiresCanvas: true },
  'layout-probe': { load: () => import('./canvas/layout-probe.mjs') },
  'config-selftest': { load: () => import('./chat/config-selftest.mjs') },
  'chat-toggle': { load: () => import('./chat/chat-toggle.mjs') },
  'skills-ui': { load: () => import('./chat/skills-ui.mjs') },
  'saved-chat-generation': { load: () => import('./chat/saved-chat-generation.mjs'), requiresCanvas: true },
  'archify-import': { load: () => import('./archify/import.mjs'), requiresCanvas: true },
  'archify-button': { load: () => import('./archify/button.mjs'), requiresCanvas: true },
  'archify-unlinked': { load: () => import('./archify/unlinked.mjs'), requiresCanvas: true },
  'archify-authoring': { load: () => import('./archify/authoring.mjs'), requiresCanvas: true },
  'archify-agent': { load: () => import('./archify/agent.mjs'), requiresCanvas: true },
  'archify-projection': { load: () => import('./archify/projection.mjs'), requiresCanvas: true },
  'archify-projection-ui': { load: () => import('./archify/projection-ui.mjs'), requiresCanvas: true },
  'archify-diag': { load: () => import('./archify/diag.mjs'), requiresCanvas: true },
  'archify-ast-anchor': { load: () => import('./ast/ast-anchor.mjs'), requiresCanvas: true },
};

export function scenarioNames() {
  return Object.keys(SCENARIOS);
}

export function isScenario(name) {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, name);
}

// Acceptance-only injections a scenario needs INSIDE production IPC handlers.
// Registered here so production code never checks the scenario name itself
// (refactor rule 4): main.mjs passes these into registerAllIpc as deps.
export async function scenarioIpcOverrides(name) {
  if (name === 'archify-projection-ui') {
    // Keeps the toolbar flow CLI-robust on a machine without the archify skill,
    // without production `archify:validate` knowing a fixture exists.
    const { fixtureProjectionUiIR } = await import('./_helpers/fixtures.mjs');
    return { archifyValidateFallback: fixtureProjectionUiIR };
  }
  return {};
}

/**
 * Runs a scenario by name.
 *
 * Returns { handled, terminal }:
 *  - handled: false  -> unknown/`none` scenario, main.mjs continues normally
 *  - terminal: true  -> the scenario owns the process from here (main.mjs returns)
 *
 * A canvas-requiring scenario launched with --mode=chat-only fails loudly and
 * quits, which is the behaviour the duplicated FATAL branches had.
 */
export async function runScenario(name, ctx = {}) {
  const entry = SCENARIOS[name];
  if (!entry) return { handled: false, terminal: false };

  const mode = (ctx.argv && ctx.argv.mode) || 'full';
  const hasCanvas = mode !== 'chat-only';

  if (!hasCanvas && entry.requiresCanvas) {
    console.error(`FATAL: scenario=${name} requires a mounted canvas (use --mode=full or canvas-only)`);
    ctx.app?.quit();
    return { handled: true, terminal: true };
  }
  // draw-and-ask historically just skipped its canvas seeding in chat-only mode
  // and still produced the screenshot; it must not become a hard failure.
  if (!hasCanvas && entry.skipUnlessCanvas) return { handled: true, terminal: false };

  const mod = await entry.load();
  await mod.run(ctx);
  return { handled: true, terminal: entry.terminal !== false };
}
