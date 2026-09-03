// S6.1 — pure Archify projection plan. This is the "preview" slice of S6 turned
// into a DETERMINISTIC, scene-agnostic contract: it turns an Archify layout IR
// (plus a mode and the current scene) into a serializable plan that describes
// what WOULD be added/removed — WITHOUT touching Excalidraw.
//
// WHY PURE:
//   * It can be unit-tested in plain Node (no Electron, no Excalidraw, no bridge).
//   * Preview and Confirm both consume the SAME plan object, so the user sees
//     exactly what gets committed (no drift between "shown" and "applied").
//   * The plan is a pure function of (ir, mode, existing scene ids, provenance
//     context, viewport) — identical inputs produce an identical plan, which is
//     what makes stale/preview protection and idempotent confirm possible given
//     `projectionId` + `sourceHash`.
//   * It reuses the existing pure converter `importArchifyIR` rather than
//     duplicating the Archify -> node/edge/frame mapping.
//
// PLAN SHAPE (what the caller gets):
//   version, projectionId, sourceHash, mode, sourceElementKind,
//   nodes[] (remapped + placed), edges[] (remapped, with id), frames[],
//   elementIdsToDelete[], counts{components,connections,boundaries,excalidrawElements},
//   bounds{x,y,width,height}, warnings[], unsupported{cards,views},
//   provenance{diagramType,skillHash,projectSnapshot,evidenceRefs,projectionId,sourceHash}
//
// The plan NEVER mutates the scene and never reads node:crypto (browser-safe).
// Placing detail lives here so Merge places to the right of existing content and
// Replace/Reset normalises to a deterministic origin — all without a second pass.

import { importArchifyIR } from './archify-import.mjs';
import { buildArchifyProvenance, sanitizeEvidenceRefs, sanitizeAstAnchor } from './archify-provenance.mjs';

// Deterministic gap (scene px) between existing content and a Merge projection.
const MERGE_GAP = 160;

// --- pure SHA-256 (browser-safe, no node:crypto) ----------------------------
// The projection is long-lived and written into `customData` + a registry, so an
// 8-char FNV hash is too weak: two different projections must NEVER collide on
// `sourceHash`/`projectionId`. We implement SHA-256 over UTF-8 bytes so the renderer
// (which has no `node:crypto`) and the Node tests produce the identical digest.
// Verified against the NIST/FIPS-180-4 test vectors in a unit test.
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function sha256(bytes) {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const l = bytes.length;
  const bitLen = l * 8;
  // Pad: 0x80 then zeros until (len % 64 === 56), then the 8-byte big-endian length.
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// UTF-8 encode a string, then SHA-256 it. Deterministic and pure.
export function sha256Hex(str) {
  const s = String(str ?? '');
  // TextEncoder yields a Uint8Array of UTF-8 bytes.
  const bytes = new TextEncoder().encode(s);
  return sha256(bytes);
}

function boundsOf(items) {
  const withRect = items.filter((i) => typeof i?.x === 'number' && typeof i?.y === 'number' && typeof i?.width === 'number' && typeof i?.height === 'number');
  if (!withRect.length) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...withRect.map((i) => i.x));
  const minY = Math.min(...withRect.map((i) => i.y));
  const maxX = Math.max(...withRect.map((i) => i.x + i.width));
  const maxY = Math.max(...withRect.map((i) => i.y + i.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(a, b) {
  const aEmpty = !a.width && !a.height;
  const bEmpty = !b.width && !b.height;
  // An empty box (no geometry) must NOT pull the union toward its own origin —
  // otherwise a projection whose content starts at (180,-50) would report a
  // bounds box that reaches back to (0,0), breaking replace-origin normalisation.
  if (aEmpty && bEmpty) return { x: 0, y: 0, width: 0, height: 0 };
  if (aEmpty) return b;
  if (bEmpty) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

const VALID_MODES = new Set(['merge', 'replace', 'reset']);

/**
 * buildArchifyProjectionPlan({ ir, mode, existingElements, projectContext, skillContext, viewport })
 *
 * @param {object}   ir           the Archify architecture layout IR (components/boundaries/connections)
 * @param {string}   mode         'merge' | 'replace' | 'reset'
 * @param {Array}    existingElements  current scene elements; only `id` + `isDeleted` are consumed
 * @param {object}   projectContext    { label?, snapshot?, evidenceRefs? }
 * @param {object}   skillContext      { hash?, name? }
 * @param {object}   viewport          ignored by layout for now (kept in the signature for the
 *                                     future "fit to imported" origin); always deterministic.
 *
 * Throws `{ code }` on bad input (reuses the converter's codes) — it never
 * silently drops a broken IR.
 */
export function buildArchifyProjectionPlan({
  ir,
  mode = 'merge',
  existingElements = [],
  projectContext = null,
  skillContext = null,
  viewport = null, // eslint-disable-line no-unused-vars
}) {
  const resolvedMode = VALID_MODES.has(mode) ? mode : 'merge';
  const converted = importArchifyIR(ir); // throws { code } on bad input
  const warnings = [...(converted.warnings || [])];

  const existing = (existingElements && Array.isArray(existingElements)) ? existingElements : [];
  const liveExisting = existing.filter((e) => !(e && e.isDeleted));
  const existingIds = liveExisting.map((e) => e.id).filter((id) => typeof id === 'string').sort();
  // Reserve the id space for the scene we are merging INTO. Replace/Reset have no
  // such space (the scene is cleared), so those ids can be reused without a clash.
  const occupied = new Set(resolvedMode === 'merge' ? existingIds : []);

  // --- deterministic collision remap (merge only) -----------------------------
  let nodes = converted.nodes;
  let frames = converted.frames;
  let edges = converted.edges;

  if (resolvedMode === 'merge') {
    const idMap = new Map();
    nodes = nodes.map((n) => {
      let next = n.id;
      let base = n.id;
      let i = 2;
      // A component occupies BOTH its rectangle id and its bound-text id.
      while (occupied.has(`node-${next}`) || occupied.has(`text-${next}`)) next = `${base}-${i++}`;
      idMap.set(n.id, next);
      occupied.add(`node-${next}`);
      occupied.add(`text-${next}`);
      return { ...n, id: next };
    });

    const frameIdMap = new Map();
    frames = frames.map((f) => {
      let next = f.id;
      const base = f.id;
      let i = 2;
      while (occupied.has(next)) next = `${base}-${i++}`;
      frameIdMap.set(f.id, next);
      occupied.add(next);
      return { ...f, id: next };
    });
    nodes = nodes.map((n) => (n.frameId ? { ...n, frameId: frameIdMap.get(n.frameId) ?? n.frameId } : n));

    edges = edges.map((e) => ({
      ...e,
      fromId: idMap.get(e.fromId) ?? e.fromId,
      toId: idMap.get(e.toId) ?? e.toId,
    }));
  }

  // Allocate edge ids through ONE collision-safe path in every mode. Parallel
  // Archify connections may share endpoints, so endpoint-only ids are not unique.
  // Prefer the immutable connection sourceId; fall back to endpoints, then suffix.
  edges = edges.map((e) => {
    const sourcePart = typeof e.sourceId === 'string' && e.sourceId.trim()
      ? e.sourceId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      : '';
    const base = sourcePart ? `edge-${sourcePart}` : `edge-${e.fromId}-${e.toId}`;
    let id = base;
    let i = 2;
    while (occupied.has(id)) id = `${base}-${i++}`;
    occupied.add(id);
    return { ...e, id };
  });

  // --- deterministic placement ------------------------------------------------
  const projectedBounds = unionBounds(boundsOf(nodes), boundsOf(frames));
  let offsetX = 0;
  let offsetY = 0;
  if (resolvedMode === 'merge' && existingIds.length) {
    const existingBounds = boundsOf(liveExisting);
    offsetX = existingBounds.x + existingBounds.width + MERGE_GAP;
    offsetY = existingBounds.y;
  } else {
    // Replace/Reset (or an empty scene): normalise the projection to the origin
    // so a repeated import is byte-identical regardless of where the IR placed it.
    offsetX = -(projectedBounds.x || 0);
    offsetY = -(projectedBounds.y || 0);
  }

  const placedNodes = nodes.map((n) => ({ ...n, x: n.x + offsetX, y: n.y + offsetY }));
  const placedFrames = frames.map((f) => ({ ...f, x: f.x + offsetX, y: f.y + offsetY }));
  const placedBounds = unionBounds(boundsOf(placedNodes), boundsOf(placedFrames));
  // Frameless arrow geometry is derived at apply time from node rects; no offset needed here.

  // --- deterministic, CONTENT-COMPLETE identity hash --------------------------
  // `sourceHash` identifies the SOURCE: the full Archify IR plus the provenance
  // context it will be projected with. Two projections that differ in ANY content
  // (a label, a coordinate, a schema version, a snapshot, a skill hash, evidence
  // refs) MUST get a different sourceHash — otherwise the idempotency registry and
  // the preview->confirm contract can silently apply the WRONG projection (Round
  // 17 P0). `projectionId` then fingerprints the exact PLANNED projection (the
  // remapped/placed elements + mode + deletions + bounds), so a confirm always
  // matches the payload the user actually previewed.
  const evidenceRefs = sanitizeEvidenceRefs(projectContext?.evidenceRefs);
  // Deterministic deletion list: merge never deletes; replace/reset delete every
  // currently-live element id. Declared here so it can feed the projection hash.
  const elementIdsToDelete = resolvedMode === 'merge' ? [] : existingIds.slice();

  // Evidence per component id: the immutable sourceId -> its own project-relative
  // refs. Per-node provenance must NEVER fall back to a global list (Round 17 P1).
  const evidenceMap = {};
  const anchorMap = {};
  const rawMap = projectContext?.evidenceMap || {};
  const rawAnchors = projectContext?.filesManifest?.components || {};
  for (const n of placedNodes) {
    const sId = n.sourceId ?? n.id;
    const own = rawMap[sId] ?? n.meta?.sources ?? null;
    const refs = sanitizeEvidenceRefs(own);
    if (refs.length) evidenceMap[sId] = refs;
    const anchor = sanitizeAstAnchor(rawAnchors[sId], sId);
    if (anchor) anchorMap[sId] = anchor;
  }

  // Source identity is independent of the current canvas, merge placement and
  // collision remaps. It covers the complete input IR (including unsupported
  // cards/views) plus the frozen provenance context. projectionId below remains
  // the identity of the exact placed/remapped plan.
  const stableValue = (value) => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
  };
  const canonicalSource = JSON.stringify(stableValue({
    ir,
    projectSnapshot: projectContext?.snapshot ?? null,
    skillHash: skillContext?.hash ?? null,
    evidenceMap,
    anchorMap,
  }));
  const sourceHash = sha256Hex(canonicalSource);

  const canonicalProjection = JSON.stringify({
    sourceHash,
    mode: resolvedMode,
    existingIds,
    elementIdsToDelete,
    placedNodes: placedNodes.map((n) => ({ id: n.id, sourceId: n.sourceId ?? n.id, x: n.x, y: n.y, width: n.width, height: n.height, frameId: n.frameId ?? null, label: n.label })),
    placedFrames: placedFrames.map((f) => ({ id: f.id, sourceId: f.sourceId ?? f.id, name: f.name ?? null, x: f.x, y: f.y, width: f.width, height: f.height })),
    edges: edges.map((e) => ({ id: e.id, sourceId: e.sourceId ?? null, fromId: e.fromId, toId: e.toId, label: e.label ?? null })),
    bounds: placedBounds,
  });
  const projectionId = `proj-${sha256Hex(canonicalProjection).slice(0, 32)}`;

  const provenance = buildArchifyProvenance({
    sourceElementKind: 'projection',
    sourceElementId: null,
    diagramType: ir.diagram_type || 'architecture',
    evidenceRefs,
    projectSnapshot: projectContext?.snapshot ?? null,
    skillHash: skillContext?.hash ?? null,
    projectionId,
  });
  provenance.sourceHash = sourceHash;

  const excalidrawElements = placedFrames.length + placedNodes.length * 2 + edges.length;
  const unsupported = { cards: (converted.source.cards || []).length, views: (converted.source.views || []).length };

  if (resolvedMode === 'merge' && existingIds.length && !placedBounds.width) {
    warnings.push('projection has no resolvable bounds; placed at origin');
  }

  return {
    version: 1,
    projectionId,
    sourceHash,
    mode: resolvedMode,
    nodes: placedNodes,
    edges,
    frames: placedFrames,
    elementIdsToDelete,
    evidenceMap,
    anchorMap,
    counts: {
      components: placedNodes.length,
      connections: edges.length,
      boundaries: placedFrames.length,
      excalidrawElements,
    },
    bounds: placedBounds,
    warnings,
    unsupported,
    provenance,
  };
}

export { VALID_MODES };
