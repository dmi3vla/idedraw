// Moved out of main.mjs (refactor rule 4): the fixture IR is acceptance-only.
// Production `archify:validate` no longer knows it exists — it is injected by
// the scenario through deps.archifyValidateFallback instead.
// Deterministic fixture IR used ONLY when the archify CLI binary is unavailable
// during an acceptance scenario (`--scenario=archify-projection-ui`). Keeps the
// toolbar flow CLI-robust (the claimed behaviour) so the live UI acceptance can
// run on a machine without the archify skill. Never used in normal production
// runs (which still refuse with ARCHIFY_NOT_FOUND when the skill is missing).

export function fixtureProjectionUiIR() {
  const components = [];
  for (let i = 0; i < 11; i++) {
    components.push({ id: `c${i}`, label: `Component ${i}`, x: (i % 6) * 220, y: Math.floor(i / 6) * 160, width: 160, height: 60, sublabel: `src/c${i}.ts` });
  }
  const boundaries = [];
  for (let i = 0; i < 4; i++) {
    boundaries.push({ label: `Zone ${i}`, wraps: [`c${i}`] });
  }
  const connections = [];
  for (let i = 0; i < 10; i++) {
    connections.push({ id: `e${i}`, from: `c${i % 11}`, to: `c${(i + 1) % 11}`, label: `Edge ${i}` });
  }
  return { diagram_type: 'architecture', components, connections, boundaries, cards: [], meta: { schema_version: 1, views: [], title: 'Projection UI Fixture' } };
}
