// Project store: the "ground truth" project graph (files/symbols/deps),
// deliberately separate from canvas.js/adapter.mjs. A canvas can exist
// with NO project linked (freeform sketch/draw), or can be linked to
// exactly one project at a time. Canvas and project never import each other
// directly — the bridge composes them.

// Demo/mock project graph — stands in for a real AST/dependency-graph
// extraction (layer 2 from the wider plan). Swappable without touching
// canvas or chat code.
const MOCK_PROJECT = {
  projectId: 'demo-project',
  name: 'Code Canvas Focus Dock (demo slice)',
  nodes: [
    { id: 'proj:onec-plugin', kind: 'module', label: 'main/plugins/onec/', path: 'main/plugins/onec/' },
    { id: 'proj:bsl-parser', kind: 'file', label: 'bsl.js', path: 'main/plugins/onec/bsl.js' },
    { id: 'proj:project-service', kind: 'file', label: 'project-service.js', path: 'main/plugins/onec/project-service.js' },
    { id: 'proj:dap-session', kind: 'file', label: 'debug/session.js', path: 'main/plugins/onec/debug/session.js' },
  ],
  edges: [
    { from: 'proj:bsl-parser', to: 'proj:project-service', kind: 'feeds' },
    { from: 'proj:project-service', to: 'proj:onec-plugin', kind: 'part-of' },
    { from: 'proj:dap-session', to: 'proj:onec-plugin', kind: 'part-of' },
  ],
};

let linkState = {
  linked: false,
  canvasId: null,
  projectId: null,
  specPath: null,
  root: null,
};

export function getProjectGraph() {
  return structuredClone(MOCK_PROJECT);
}

export function getProjectNode(id) {
  const node = MOCK_PROJECT.nodes.find((n) => n.id === id);
  if (!node) return null;
  const related = MOCK_PROJECT.edges
    .filter((e) => e.from === id || e.to === id)
    .map((e) => (e.from === id ? { direction: 'out', kind: e.kind, node: e.to } : { direction: 'in', kind: e.kind, node: e.from }));
  return { ...node, related };
}

export function searchProject(query) {
  const q = query.toLowerCase();
  return MOCK_PROJECT.nodes.filter(
    (n) => n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
  );
}

// A canvas is independent by default (freeform sketch). Linking is an
// explicit, reversible action — never implicit. The optional specPath is the
// archify architecture spec the linked project is described by; it is resolved
// (and spawned) in the MAIN process, never here. The '@app/...' marker lets the
// demo spec travel with the repo instead of hardcoding an absolute path.
export function linkCanvas(canvasId, projectId = MOCK_PROJECT.projectId, specPath = null, root = null) {
  if (projectId !== MOCK_PROJECT.projectId) {
    return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` } };
  }
  const resolvedSpec = specPath || '@app/canvas-v2-architecture.json';
  linkState = { linked: true, canvasId, projectId, specPath: resolvedSpec, root };
  return { ok: true, data: { ...linkState } };
}

export function unlinkCanvas() {
  linkState = { linked: false, canvasId: null, projectId: null, specPath: null, root: null };
  return { ok: true, data: { ...linkState } };
}

// Link the canvas to a real project directory on disk (plan slice S5). Unlike
// linkCanvas this is not bounded to the demo mock project: it records the real
// `root` the read-only project tools will be confined to. The demo project id is
// kept so existing callers that only care about the linked flag still work.
function linkDirectory(canvasId, root, projectId = 'linked-project', specPath = null) {
  if (!root || typeof root !== 'string') {
    return { ok: false, error: { code: 'BAD_INPUT', message: 'linkDirectory requires a project root (absolute path).' } };
  }
  linkState = { linked: true, canvasId, projectId, specPath, root };
  return { ok: true, data: { ...linkState } };
}

export function getLinkStatus() {
  return { ...linkState };
}
