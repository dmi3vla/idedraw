// CLI flags, parsed in one place instead of inline argValue() calls scattered
// through the bootstrap. Pure function of an argv array, so it is unit-testable
// without electron (tests/argv.test.mjs).

export const ARGV_DEFAULTS = Object.freeze({
  mode: 'full', // full | chat-only | canvas-only
  theme: 'dark',
  scenario: 'none',
  archifySpec: 'canvas-v2-architecture.json',
});

export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const value = (flag, fallback) => {
    const found = args.find((a) => typeof a === 'string' && a.startsWith(`${flag}=`));
    // Only the first '=' separates flag from value, so a value may contain '='.
    return found ? found.slice(flag.length + 1) : fallback;
  };
  return Object.freeze({
    mode: value('--mode', ARGV_DEFAULTS.mode),
    theme: value('--theme', ARGV_DEFAULTS.theme),
    scenario: value('--scenario', ARGV_DEFAULTS.scenario),
    archifySpec: value('--archify-spec', ARGV_DEFAULTS.archifySpec),
    // Isolated userData dir for config self-tests / acceptance runs (C7) so the
    // "fresh profile" state can be reproduced without touching the real one.
    profile: value('--profile', null),
    visualProof: args.includes('--visual-proof'),
  });
}
