// S6 AST anchors: precompute bounded file ownership + dependency layers while
// Archify already has the resolved component graph. Pure and deterministic.

const AST_ANCHOR_LIMITS = Object.freeze({
  ownFiles: 16,
  neighborComponents: 12,
  filesPerNeighbor: 8,
  totalFiles: 64,
});

function uniqSorted(values) {
  return [...new Set((values || []).filter((v) => typeof v === 'string' && v))].sort();
}

function entries(ids, tierFiles, firstHopById = null) {
  return [...ids].sort().slice(0, AST_ANCHOR_LIMITS.neighborComponents).map((componentId) => ({
    componentId,
    ...(firstHopById?.get(componentId) ? { via: firstHopById.get(componentId) } : {}),
    files: uniqSorted(tierFiles[componentId]).slice(0, AST_ANCHOR_LIMITS.filesPerNeighbor),
  }));
}

function layers(start, adjacency) {
  const l1 = new Set(adjacency.get(start) || []);
  l1.delete(start);
  const l2 = new Set();
  const via = new Map();
  for (const mid of [...l1].sort()) {
    for (const next of adjacency.get(mid) || []) {
      if (next === start || l1.has(next)) continue;
      l2.add(next);
      if (!via.has(next)) via.set(next, mid);
    }
  }
  return { l1, l2, via };
}

/**
 * Return componentId -> bounded AST anchor. Connections are directed `from -> to`:
 * dependencies are outgoing, dependents are incoming.
 */
export function buildAstAnchorManifest(tierFiles = {}, connections = []) {
  const ids = uniqSorted(Object.keys(tierFiles));
  const outgoing = new Map(ids.map((id) => [id, new Set()]));
  const incoming = new Map(ids.map((id) => [id, new Set()]));
  for (const edge of connections || []) {
    const from = String(edge?.from || '');
    const to = String(edge?.to || '');
    if (!outgoing.has(from) || !incoming.has(to) || from === to) continue;
    outgoing.get(from).add(to);
    incoming.get(to).add(from);
  }
  const components = {};
  for (const componentId of ids) {
    const deps = layers(componentId, outgoing);
    const users = layers(componentId, incoming);
    components[componentId] = {
      version: 1,
      componentId,
      own: uniqSorted(tierFiles[componentId]).slice(0, AST_ANCHOR_LIMITS.ownFiles),
      dependenciesL1: entries(deps.l1, tierFiles),
      dependenciesL2: entries(deps.l2, tierFiles, deps.via),
      dependentsL1: entries(users.l1, tierFiles),
      dependentsL2: entries(users.l2, tierFiles, users.via),
    };
  }
  return { version: 1, components };
}

export function refsForAstAnchor(anchor, scope = 'own') {
  if (!anchor || typeof anchor !== 'object') return [];
  const refs = [...(Array.isArray(anchor.own) ? anchor.own : [])];
  const add = (key) => {
    for (const item of Array.isArray(anchor[key]) ? anchor[key] : []) {
      if (Array.isArray(item?.files)) refs.push(...item.files);
    }
  };
  if (scope === 'l1' || scope === 'l2') {
    add('dependenciesL1'); add('dependentsL1');
  }
  if (scope === 'l2') {
    add('dependenciesL2'); add('dependentsL2');
  }
  return uniqSorted(refs).slice(0, AST_ANCHOR_LIMITS.totalFiles);
}
