// Vanilla boundary between the React/Excalidraw island and the rest of the
// app (bridge, chat, main process). Nothing outside this file ever imports
// React or @excalidraw/excalidraw directly.

import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords, convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import { baseElementProps, buildNodeElements } from './node-elements.mjs';
import { buildArchifyProjectionPlan } from './archify-projection-plan.mjs';
import { buildArchifyProvenance, sanitizeEvidenceRefs, buildProjectionReceipt } from './archify-provenance.mjs';
import { sceneFingerprintFromElements, newPreviewToken, prunePendingState, PENDING_TTL_MS, PENDING_MAX, APPLIED_MAX } from './archify-preview-state.mjs';

let excalidrawAPI = null;
const listeners = new Set();
let lastSelectedIds = [];

// Compaction is not free (full pass + updateScene with a new array), so it
// never runs per-delete unconditionally — only via canvas.compact, or
// automatically when tombstoned elements exceed this share of the scene.
const AUTO_COMPACT_TOMBSTONE_SHARE = 0.3;

// Called once by mount.jsx after <Excalidraw excalidrawAPI={...}> resolves.
export function _bindExcalidrawAPI(api) {
  excalidrawAPI = api;
}

function isMounted() {
  return excalidrawAPI !== null;
}

function requireMounted() {
  if (!excalidrawAPI) {
    throw new Error('Canvas not mounted yet');
  }
}

// `sublabel` renders as a second, smaller line under the main label (archify
export function getScene() {
  requireMounted();
  const elements = excalidrawAPI.getSceneElements();
  return elements
    .filter((el) => !el.isDeleted)
    .map((el) => ({
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      customData: el.customData ?? null,
    }));
}

export function getElementById(id) {
  requireMounted();
  const el = excalidrawAPI.getSceneElements().find((e) => e.id === id || e.customData?.projectNodeId === id);
  return el ? { id: el.id, type: el.type, x: el.x, y: el.y, customData: el.customData ?? null } : null;
}

// Whether the element is an imported Archify component. Legacy saved canvases
// predate AST anchors, so menu eligibility must not depend on astAnchor being
// present: otherwise right-click falls through to Excalidraw with no action.
export function isArchifyComponent(el) {
  return !!(el && el.type === 'rectangle' && el.customData?.projectNodeId &&
    (!el.customData?.archify?.sourceElementKind || el.customData.archify.sourceElementKind === 'component'));
}

// Point (client/clientX,clientY) -> the topmost Archify component rectangle under it.
// Uses the package's own viewportToScene transform (same rule the app uses to draw
// the scene), so right-click hit-testing stays correct under pan/zoom/offset.
export function hitTestArchifyComponentAt(clientX, clientY) {
  requireMounted();
  const state = excalidrawAPI.getAppState();
  const scene = viewportCoordsToSceneCoords({ clientX, clientY }, {
    zoom: state.zoom,
    offsetLeft: state.offsetLeft,
    offsetTop: state.offsetTop,
    scrollX: state.scrollX,
    scrollY: state.scrollY,
  });
  const elements = excalidrawAPI.getSceneElements();
  const frames = elements.filter((el) => !el.isDeleted && el.type === 'frame');
  const insideFrame = (el) => {
    if (!el.frameId || !frames.length) return true;
    const fr = frames.find((f) => f.id === el.frameId);
    if (!fr) return true;
    return fr.x <= scene.x && scene.x <= fr.x + fr.width && fr.y <= scene.y && scene.y <= fr.y + fr.height;
  };
  // Iterate last-drawn first so a component visually on top wins.
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.isDeleted) continue;
    if (!isArchifyComponent(el)) continue;
    // Inverse-rotate the scene point around the element centre, then test the
    // element-local rectangle. viewportCoordsToSceneCoords already accounts for
    // zoom/pan; this also makes rotated and negatively-sized nodes exact.
    const width = Number(el.width) || 0;
    const height = Number(el.height) || 0;
    const cx = el.x + width / 2;
    const cy = el.y + height / 2;
    const angle = -(Number(el.angle) || 0);
    const dx = scene.x - cx;
    const dy = scene.y - cy;
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle) + cx;
    const localY = dx * Math.sin(angle) + dy * Math.cos(angle) + cy;
    const x0 = Math.min(el.x, el.x + width);
    const x1 = Math.max(el.x, el.x + width);
    const y0 = Math.min(el.y, el.y + height);
    const y1 = Math.max(el.y, el.y + height);
    if (localX >= x0 && localX <= x1 && localY >= y0 && localY <= y1 && insideFrame(el)) {
      const sourceElementId = el.customData?.archify?.sourceElementId || el.customData.projectNodeId;
      const storedAnchor = el.customData?.archify?.astAnchor || null;
      const evidenceRefs = Array.isArray(el.customData?.archify?.evidenceRefs)
        ? el.customData.archify.evidenceRefs.filter((ref) => typeof ref === 'string')
        : [];
      return {
        id: el.id,
        sourceElementId,
        // Evidence-backed fallback migrates old projections that had refs but
        // no manifest. Canvases with neither still get the menu and a clear
        // regeneration message instead of silently showing Excalidraw's menu.
        astAnchor: storedAnchor || (evidenceRefs.length ? { version: 1, componentId: sourceElementId, own: evidenceRefs } : null),
        projectSnapshot: el.customData?.archify?.projectSnapshot ?? null,
      };
    }
  }
  return null;
}

export function addNode(node) {
  requireMounted();
  const built = convertToExcalidrawElements(buildNodeElements(node), { regenerateIds: false });
  const existing = excalidrawAPI.getSceneElements();
  // IMMEDIATELY: a user node edit is its own undo step. The default (EVENTUALLY)
  // leaves the element uncommitted, so a later replace's filterUncomittedElements
  // drops it and undo can never restore it (S6 replace Undo/Redo regression).
  excalidrawAPI.updateScene({ elements: [...existing, ...built], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { id: built[0].id, label: node.label };
}

// Every archify component is ONE rectangle with a bound label (see
// buildNodeElements): the main label and the file-path sublabel are merged into
// a single two-line bound text for the first correct variant. The label is
// created through Excalidraw's OWN converter (convertToExcalidrawElements +
// bindTextToContainer + redrawTextBoundingBox), so it is a valid binding: the
// text is centred inside the rectangle, stays there on every recompute, and
// moves with the rectangle when the node is dragged. A hand-built bound-text
// binding (containerId + boundElements set by hand) was NOT a valid binding and
// got re-laid-out BELOW the box on the first real interaction (the
// 'command_engine sag').
//
// buildNodeElements itself is defined in ./node-elements.mjs (dependency-free,
// importable from plain Node tests without pulling in @excalidraw/excalidraw) and
// re-exported here for the rest of the adapter. See node-elements.mjs for its body.
export { buildNodeElements } from './node-elements.mjs';

// Excalidraw's NATIVE frame element (type: 'frame'), not a hand-drawn
// rectangle. Verified against the shipped types
// (node_modules/@excalidraw/excalidraw/dist/types/excalidraw/element/types.d.ts:140):
//   ExcalidrawFrameElement = _ExcalidrawElementBase & { type: "frame"; name: string | null }
// so the only required field beyond our baseElementProps() is `name`.
// Using the native type is what makes dragging the frame move its members as a
// group and gives the label chrome for free — a plain rectangle gives neither.
function buildFrameElement({ id, name = null, x, y, width, height }) {
  return {
    ...baseElementProps(),
    id,
    type: 'frame',
    x,
    y,
    width,
    height,
    angle: 0,
    name,
    // Frames paint their own chrome; roundness/roughness on one is noise.
    roundness: null,
    roughness: 0,
    customData: { archifyBoundary: true },
  };
}

// Frames go FIRST in the scene array: Excalidraw paints frames before their
// children, and a member whose frameId points at a frame later in the array
// renders on top of nothing. Not interchangeable with appending.
export function addFrames(frames) {
  requireMounted();
  const existing = excalidrawAPI.getSceneElements();
  const built = frames.map(buildFrameElement);
  excalidrawAPI.updateScene({ elements: [...built, ...existing], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { added: built.map((f) => f.id) };
}

export function addNodes(nodes) {
  return nodes.map(addNode);
}

// Resolve every element that makes up one logical node: the rectangle, its
// bound-text label, the arrows routed to/from it, and those arrows' own bound
// label text. A node is NOT a single element — it is a container + its bound
// text + its attached edges — so CRUD (move/rename/delete/select) must act on
// the whole logical node, not just the rectangle that `id` names.
function resolveNodeParts(id) {
  const existing = excalidrawAPI.getSceneElements();
  // Accept either the element id (`node-<id>`) or the logical id; compare on both
  // the element id and customData.projectNodeId so `id` always lands on the rect.
  const rect = existing.find((e) => e.id === id || e.customData?.projectNodeId === id);
  if (!rect) return null;
  const parts = new Set([rect.id]);
  const textRefs = (rect.boundElements || []).filter((b) => b.type === 'text').map((b) => b.id);
  for (const e of existing) {
    if (e.containerId === rect.id || textRefs.includes(e.id)) parts.add(e.id);
  }
  const arrowRefs = (rect.boundElements || []).filter((b) => b.type === 'arrow').map((b) => b.id);
  for (const e of existing) {
    if (e.type !== 'arrow') continue;
    const touches = arrowRefs.includes(e.id) || e.startBinding?.elementId === rect.id || e.endBinding?.elementId === rect.id;
    if (touches) {
      parts.add(e.id);
      for (const t of existing) if (t.containerId === e.id) parts.add(t.id); // arrow's own bound label
    }
  }
  return parts;
}

export function updateNode(id, patch) {
  requireMounted();
  const existing = excalidrawAPI.getSceneElements();
  const target = existing.find((e) => e.id === id || e.customData?.projectNodeId === id);
  if (!target) throw Object.assign(new Error(`Element not found: ${id}`), { code: 'NOT_FOUND' });
  // The bound text is a real binding: Excalidraw's updateScene recomputes it and
  // carries it with the rectangle natively, so we only move/change the rect.
  const updated = existing.map((e) =>
    e.id === target.id ? { ...e, ...patch, version: (e.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : e
  );
  excalidrawAPI.updateScene({ elements: updated, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { id: target.id };
}

export function removeNode(id) {
  requireMounted();
  const existing = excalidrawAPI.getSceneElements();
  const parts = resolveNodeParts(id);
  if (!parts) throw Object.assign(new Error(`Element not found: ${id}`), { code: 'NOT_FOUND' });
  const updated = existing.map((e) => (parts.has(e.id) ? { ...e, isDeleted: true } : e));
  excalidrawAPI.updateScene({ elements: updated, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  maybeAutoCompact(updated);
  return { id: parts.has(id) ? id : (parts.has(`node-${id}`) ? `node-${id}` : [...parts][0]) };
}

export function addEdge({ fromId, toId, label }) {
  requireMounted();
  const from = getElementById(fromId);
  const to = getElementById(toId);
  if (!from || !to) throw Object.assign(new Error('Edge endpoints not found'), { code: 'NOT_FOUND' });
  const arrow = buildArrowElement({ id: `edge-${fromId}-${toId}`, from, to, label });
  const existing = excalidrawAPI.getSceneElements();
  excalidrawAPI.updateScene({ elements: [...existing, arrow], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { id: arrow.id };
}

// Batch mirror of addEdge — ONE updateScene for the whole batch (same model
// as addNodes). Validate-then-commit: every endpoint must resolve before the
// scene is touched, so a bad edge aborts the entire batch instead of leaving
// a half-built graph behind.
export function addEdges(edges) {
  requireMounted();
  const existing = excalidrawAPI.getSceneElements();
  const byRef = new Map();
  for (const e of existing) {
    if (e.id && !byRef.has(e.id)) byRef.set(e.id, e);
    const pid = e.customData && e.customData.projectNodeId;
    if (pid && !byRef.has(pid)) byRef.set(pid, e);
  }
  const built = [];
  for (const { fromId, toId, label } of edges) {
    const from = byRef.get(fromId);
    const to = byRef.get(toId);
    if (!from || !to) {
      throw Object.assign(new Error(`Edge endpoints not found: ${fromId}->${toId}`), { code: 'NOT_FOUND' });
    }
    built.push(buildArrowElement({ id: `edge-${fromId}-${toId}`, from, to, label }));
  }
  excalidrawAPI.updateScene({ elements: [...existing, ...built], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return { added: built.map((b) => b.id) };
}

function buildArrowElement({ id, from, to, label }) {
  return {
    ...baseElementProps(),
    id,
    type: 'arrow',
    x: from.x,
    y: from.y,
    width: to.x - from.x,
    height: to.y - from.y,
    angle: 0,
    points: [[0, 0], [to.x - from.x, to.y - from.y]],
    startBinding: { elementId: from.id, focus: 0, gap: 4 },
    endBinding: { elementId: to.id, focus: 0, gap: 4 },
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    customData: { edgeLabel: label ?? null },
  };
}

// Stress-test baseline path (see ACCEPTANCE.md / stress/): the exact same
// element shapes the bridge commands produce, but inserted with ONE direct
// updateScene call — no per-node round-trip through command-registry.mjs.
// This separates "Excalidraw is slow at scale" from "our bridge layer is slow".
export function addGraphRaw({ nodes, edges }) {
  requireMounted();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const elements = [];
  for (const n of nodes) elements.push(...buildNodeElements(n));
  for (const e of edges || []) {
    const from = byId.get(e.fromId);
    const to = byId.get(e.toId);
    if (!from || !to) {
      throw Object.assign(new Error(`Edge endpoints not found: ${e.fromId}->${e.toId}`), { code: 'NOT_FOUND' });
    }
    elements.push(buildArrowElement({ id: `edge-${e.fromId}-${e.toId}`, from, to, label: e.label }));
  }
  excalidrawAPI.updateScene({ elements });
  return { nodes: nodes.length, edges: (edges || []).length };
}

// Arrow between two boxes, clipped to their BORDERS (plus a small gap) rather
// than drawn corner-to-corner or centre-to-centre.
//
// buildArrowElement (above) stays corner-to-corner: it is what the Stream D
// stress baseline measured, and changing it would invalidate those numbers.
// This variant exists because both alternatives are wrong for an imported
// architecture diagram, and the second failure was only found by probing:
//   * corner-to-corner arrows enter nodes diagonally;
//   * centre-to-centre arrows are drawn straight THROUGH the node interior.
//     updateScene() does not run Excalidraw's binding recalculation (that is
//     internal, and only runs on real pointer interaction), so the stored
//     points are what gets painted AND hit-tested — a real click at a node's
//     centre selected the arrow crossing it instead of the node.
// Bindings are still set, so Excalidraw re-routes these ends itself once the
// user drags either node.
function clipToBorder(box, tx, ty, gap) {
  const cx = box.x + (box.width ?? 0) / 2;
  const cy = box.y + (box.height ?? 0) / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = (box.width ?? 0) / 2 + gap;
  const hh = (box.height ?? 0) / 2 + gap;
  // Scale the direction vector until it touches the padded box border; the
  // smaller of the two axis ratios is the side it exits through.
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy)
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function buildBorderArrowElement({ id, from, to, label, gap = 4 }) {
  const fromCx = from.x + (from.width ?? 0) / 2;
  const fromCy = from.y + (from.height ?? 0) / 2;
  const toCx = to.x + (to.width ?? 0) / 2;
  const toCy = to.y + (to.height ?? 0) / 2;
  const start = clipToBorder(from, toCx, toCy, gap);
  const end = clipToBorder(to, fromCx, fromCy, gap);
  return {
    ...baseElementProps(),
    id,
    type: 'arrow',
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    angle: 0,
    points: [[0, 0], [end.x - start.x, end.y - start.y]],
    startBinding: { elementId: from.id, focus: 0, gap },
    endBinding: { elementId: to.id, focus: 0, gap },
    lastCommittedPoint: null,
    startArrowhead: null,
    endArrowhead: 'arrow',
    customData: { edgeLabel: label ?? null },
  };
}

// Phase 1 of the archify stream: materialise a converted archify IR (see
// archify-import.mjs) as ONE scene commit — frames first, then nodes, then
// edges. Deliberately NOT three separate calls: three updateScene passes would
// paint an intermediate state where members exist without their frame, and
// (measured in Stream D) per-element commits are the expensive path.
//
// `replace: true` starts from an empty scene instead of appending, which is
// what a re-import wants; the default appends so an import can be dropped next
// to an existing sketch.
function importArchifyGraph({ nodes, edges = [], frames = [] }, { replace = false } = {}) {
  requireMounted();
  const existing = replace ? [] : excalidrawAPI.getSceneElements();

  const byRef = new Map();
  for (const e of existing) {
    if (e.id && !byRef.has(e.id)) byRef.set(e.id, e);
    const pid = e.customData && e.customData.projectNodeId;
    if (pid && !byRef.has(pid)) byRef.set(pid, e);
  }

  const builtFrames = frames.map(buildFrameElement);
  // Convert every node skeleton through Excalidraw's own converter so each
  // rectangle gets a VALID bound text: containerId + boundElements both set by
  // Excalidraw, text centred inside, and moved with the rectangle on drag.
  const nodeSkeletons = nodes.map((n) => buildNodeElements(n)).flat();
  const builtNodes = convertToExcalidrawElements(nodeSkeletons, { regenerateIds: false });
  for (const n of nodes) {
    const rect = builtNodes.find((e) => e.id === `node-${n.id}`);
    if (!rect) throw Object.assign(new Error(`Node ${n.id} did not convert`), { code: 'NOT_FOUND' });
    byRef.set(n.id, rect);
    byRef.set(rect.id, rect);
  }

  // Validate-then-commit, same contract as addEdges: a dangling endpoint
  // aborts the whole import rather than leaving a half-drawn diagram.
  const builtEdges = [];
  // Arrow bindings are TWO-WAY in Excalidraw and both directions are required:
  // the arrow's start/endBinding says "I am attached to that shape", but the
  // shape's own `boundElements` is what Excalidraw consults when the shape
  // moves to decide which arrows to re-route. Setting only the arrow side
  // (which is all addEdge/addEdges do today) produces arrows that look bound,
  // hit-test correctly, and then stay put when the node is dragged — measured,
  // not assumed: a real 120px pointer drag moved the node and left the arrow
  // at its original geometry until this back-reference was added.
  const inboundRefs = new Map(); // element id -> [{ id, type: 'arrow' }]
  const noteRef = (elId, arrowId) => {
    if (!inboundRefs.has(elId)) inboundRefs.set(elId, []);
    inboundRefs.get(elId).push({ id: arrowId, type: 'arrow' });
  };
  for (const { fromId, toId, label } of edges) {
    const from = byRef.get(fromId);
    const to = byRef.get(toId);
    if (!from || !to) {
      throw Object.assign(new Error(`Edge endpoints not found: ${fromId}->${toId}`), { code: 'NOT_FOUND' });
    }
    const arrowId = `edge-${fromId}-${toId}`;
    builtEdges.push(buildBorderArrowElement({ id: arrowId, from, to, label }));
    noteRef(from.id, arrowId);
    noteRef(to.id, arrowId);
  }

  const withRefs = (el) => {
    const refs = inboundRefs.get(el.id);
    if (!refs) return el;
    return { ...el, boundElements: [...(el.boundElements || []), ...refs] };
  };

  excalidrawAPI.updateScene({
    elements: [
      ...builtFrames,
      ...existing.map(withRefs),
      ...builtNodes.map(withRefs),
      ...builtEdges,
    ],
  });
  return {
    frames: builtFrames.length,
    nodes: nodes.length,
    edges: builtEdges.length,
    elements: builtFrames.length + builtNodes.length + builtEdges.length,
  };
}

// ============================================================================// S6 — Controlled Canvas Projection
// The S6 contract (see S6.x of the S6 plan) is: build a deterministic plan,
// show it, let the user confirm, then apply EXACTLY that plan in ONE undo
// transaction with safe provenance. preview/confirm/cancel below drive a
// renderer-side pending-plan state machine; importArchifyProjected is the
// backup-compatible one-shot used by the pre-S6 `canvas.importArchify`.
//
// All mutation goes through a SINGLE updateScene (one undo step, frames first,
// then existing, then nodes, then edges — the same order importArchifyGraph
// uses). Nothing here calls updateScene per frame/node/edge, and nothing calls
// compact() after a commit (that would break the one-undo redo).

// Register of not-yet-committed projections keyed by an opaque per-preview token.
// Bounded (TTL + cap) so a long-lived session can't grow it without bound — the
// pure bound/ttl/fingerprint logic lives in archify-preview-state.mjs so it can
// be unit-tested without Electron.
const pendingPlans = new Map(); // previewToken -> { input, plan, baseFingerprint, createdAt }
const appliedByToken = new Map(); // previewToken -> { projectionId, appliedAt, receipt }

export { PENDING_TTL_MS, PENDING_MAX, APPLIED_MAX };

function prunePending() {
  prunePendingState(pendingPlans, new Set(), { nowMs: Date.now(), appliedMax: 0 });
  // Token idempotency is bounded and expires with the same lifetime as previews.
  const nowMs = Date.now();
  for (const [token, entry] of appliedByToken) {
    if (nowMs - entry.appliedAt > PENDING_TTL_MS) appliedByToken.delete(token);
  }
  while (appliedByToken.size > APPLIED_MAX) {
    appliedByToken.delete(appliedByToken.keys().next().value);
  }
}

// Resolve the pending-map key for a confirm/cancel request. An opaque previewToken
// is exact; a legacy projectionId finds the pending entry whose plan carries that
// content id (backward-compatible with the one-shot import tool path).
function resolvePendingKey({ previewToken, projectionId }) {
  prunePending();
  if (previewToken && typeof previewToken === 'string') return previewToken;
  if (projectionId && typeof projectionId === 'string') {
    for (const [token, p] of pendingPlans) {
      if (p && p.plan && p.plan.projectionId === projectionId) return token;
    }
    return projectionId; // will miss -> stale, reported cleanly
  }
  return null;
}

// Content-complete scene fingerprint (delegates to the pure, testable helper).
function sceneFingerprint() {
  requireMounted();
  return sceneFingerprintFromElements(excalidrawAPI.getSceneElements());
}

function provenanceFor(kind, plan, evidenceRefs, sourceId, astAnchor = null) {
  return buildArchifyProvenance({
    sourceElementKind: kind,
    sourceElementId: sourceId,
    diagramType: plan.provenance.diagramType,
    evidenceRefs: evidenceRefs ?? plan.provenance.evidenceRefs ?? [],
    projectSnapshot: plan.provenance.projectSnapshot ?? null,
    skillHash: plan.provenance.skillHash ?? null,
    projectionId: plan.projectionId,
    astAnchor,
  });
}

/**
 * Apply a buildArchifyProjectionPlan output as ONE scene commit (single undo
 * step). Merge keeps the existing scene; Replace/Reset REPLACE it (the old
 * elements are dropped from the new array — Excalidraw snapshots the prior
 * array on updateScene, so a single Ctrl-Z restores them and Ctrl-Shift-Z
 * returns the projection).
 */
export function applyProjectionPlan(plan) {
  requireMounted();
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.nodes) || !Array.isArray(plan.edges) || !Array.isArray(plan.frames)) {
    throw Object.assign(new Error('applyProjectionPlan: invalid plan'), { code: 'BAD_PLAN' });
  }

  const existing = excalidrawAPI.getSceneElements();
  // Replace/Reset must explicitly tombstone every old element whose id is not
  // reused by the new projection. Merely omitting old elements from updateScene
  // changes the visible array but does not give Excalidraw history a deletion to
  // invert, which made replace Undo a no-op. Reused ids are ordinary updates and
  // are restored by history from their previous versions. Merge retains all old
  // elements unchanged.
  const isReplace = plan.mode === 'replace' || plan.mode === 'reset';
  const retainedExisting = isReplace ? [] : existing;

  const byRef = new Map();
  for (const e of retainedExisting) {
    if (e.id && !byRef.has(e.id)) byRef.set(e.id, e);
    const pid = e.customData && e.customData.projectNodeId;
    if (pid && !byRef.has(pid)) byRef.set(pid, e);
  }

  // Frames FIRST (paint before children, same rule importArchifyGraph uses).
  const builtFrames = plan.frames.map((f) => {
    const base = buildFrameElement({ id: f.id, name: f.name, x: f.x, y: f.y, width: f.width, height: f.height });
    // provenance reports the IMMUTABLE boundary sourceId (the label), never the
    // possibly-remapped canvas frame id.
    return { ...base, customData: { ...(base.customData || {}), archify: provenanceFor('boundary', plan, [], f.sourceId ?? null) } };
  });

  // Nodes: rect + native bound text via Excalidraw's own converter.
  const nodeSkeletons = plan.nodes
    .map((n) => {
      const sId = n.sourceId ?? n.id;
      // Per-component evidence: ONLY the refs recorded for THIS component. Never
      // fall back to a project-wide global list (Round 17 P1).
      const refs = (plan.evidenceMap && plan.evidenceMap[sId]) || sanitizeEvidenceRefs(n.meta?.sources);
      const meta = provenanceFor('component', plan, refs, sId, plan.anchorMap?.[sId] || null);
      return buildNodeElements({
        id: n.id,
        label: n.label,
        sublabel: n.sublabel ?? null,
        renderedText: n.renderedText ?? null,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        frameId: n.frameId ?? null,
        meta,
      });
    })
    .flat();
  const builtNodes = convertToExcalidrawElements(nodeSkeletons, { regenerateIds: false });
  for (const n of plan.nodes) {
    const rect = builtNodes.find((e) => e.id === `node-${n.id}`);
    if (!rect) throw Object.assign(new Error(`Node ${n.id} did not convert`), { code: 'NOT_FOUND' });
    byRef.set(n.id, rect);
    byRef.set(rect.id, rect);
  }

  // Edges: two-way arrow bindings (same contract as importArchifyGraph).
  const builtEdges = [];
  const inboundRefs = new Map();
  const noteRef = (elId, arrowId) => {
    if (!inboundRefs.has(elId)) inboundRefs.set(elId, []);
    inboundRefs.get(elId).push({ id: arrowId, type: 'arrow' });
  };
  for (const e of plan.edges) {
    const from = byRef.get(e.fromId);
    const to = byRef.get(e.toId);
    if (!from || !to) {
      throw Object.assign(new Error(`Edge endpoints not found: ${e.fromId}->${e.toId}`), { code: 'NOT_FOUND' });
    }
    const arrowId = e.id || `edge-${e.fromId}-${e.toId}`;
    const arrow = buildBorderArrowElement({ id: arrowId, from, to, label: e.label ?? null });
    // provenance carries the ORIGINAL connection id (e.sourceId), not the derived
    // canvas arrow id (Round 17 P1). Edges never fabricate evidence refs.
    builtEdges.push({
      ...arrow,
      customData: { ...(arrow.customData || {}), archify: provenanceFor('connection', plan, [], e.sourceId ?? null) },
    });
    noteRef(from.id, arrowId);
    noteRef(to.id, arrowId);
  }

  const withRefs = (el) => {
    const refs = inboundRefs.get(el.id);
    if (!refs) return el;
    return { ...el, boundElements: [...(el.boundElements || []), ...refs] };
  };

  const projected = [...builtFrames, ...builtNodes.map(withRefs), ...builtEdges];
  const projectedIds = new Set(projected.map((e) => e.id));
  const replacedTombstones = isReplace
    ? existing
        .filter((e) => !e.isDeleted && !projectedIds.has(e.id))
        .map((e) => ({
          ...e,
          isDeleted: true,
          version: (e.version ?? 1) + 1,
          versionNonce: ((e.versionNonce ?? 0) + 1) >>> 0,
          updated: Date.now(),
        }))
    : [];

  // ONE updateScene == ONE undo step. `captureUpdate: IMMEDIATELY` guarantees
  // this single commit lands on the undo stack without waiting for a later
  // increment. Replace includes explicit tombstones in this SAME transaction,
  // so one Undo can restore the exact prior scene and one Redo the projection.
  excalidrawAPI.updateScene({
    elements: [...builtFrames, ...retainedExisting.map(withRefs), ...replacedTombstones, ...builtNodes.map(withRefs), ...builtEdges],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return {
    ...plan.counts,
    mode: plan.mode,
    projectionId: plan.projectionId,
    sourceHash: plan.sourceHash,
    elementIdsToDelete: plan.elementIdsToDelete,
    applied: true,
    provenanceApplied: true,
  };
}

/**
 * Build + cache a preview plan. PURELY PREVIEW — no scene mutation, no history
 * entry, no CLI. The returned plan is the SAME object confirm would apply.
 * Returns the plan PLUS an opaque, per-preview `previewToken`. The token — not
 * the content hash — is what confirm/cancel use to address THIS preview, so a
 * user's confirm can never replay a re-edited plan under the wrong id.
 */
export function previewArchifyProjection({ ir, mode = 'merge', projectContext = null, skillContext = null } = {}) {
  requireMounted();
  prunePending();
  const plan = buildArchifyProjectionPlan({
    ir,
    mode,
    existingElements: excalidrawAPI.getSceneElements(),
    projectContext,
    skillContext,
  });
  const previewToken = newPreviewToken();
  pendingPlans.set(previewToken, {
    input: { ir, mode, projectContext, skillContext },
    plan,
    baseFingerprint: sceneFingerprint(),
    createdAt: Date.now(),
  });
  return { ...plan, previewToken };
}

/**
 * Apply a previously previewed plan. Idempotent: a second confirm of the same consumed previewToken returns
 * alreadyApplied and does NOT re-apply. A new previewToken is a new user intent. Stale protection:
 * if the scene changed since the preview was built, the plan is refused (never
 * applied silently) and the pending state is dropped.
 *
 * Accepts either the opaque `previewToken` (preferred) or the legacy
 * `projectionId` (kept for backward compatibility with the one-shot import
tool path). Resolving by token guarantees the exact previewed plan is applied.
 */
export function confirmArchifyProjection({ previewToken, projectionId } = {}) {
  requireMounted();
  prunePending();
  // Resolve the CONTENT identity first (an opaque token yields its pending plan's
  // projectionId; a legacy projectionId is used as-is). Idempotency is scoped to the consumed preview token; projectionId is
  // content identity, not a global suppression key.
  let pid = null;
  let token = null;
  if (previewToken && typeof previewToken === 'string') {
    token = previewToken;
    // Already applied by this SAME token -> idempotent, no re-apply.
    if (appliedByToken.has(previewToken)) {
      const applied = appliedByToken.get(previewToken);
      return {
        alreadyApplied: true,
        applied: false,
        projectionId: applied.projectionId,
        previewToken,
        receipt: { ...applied.receipt, status: 'already_applied' },
      };
    }
    const pending = pendingPlans.get(previewToken);
    if (pending && pending.plan) pid = pending.plan.projectionId;
  } else if (projectionId && typeof projectionId === 'string') {
    pid = projectionId;

    // A projectionId usually refers to the pending preview that produced it.
    for (const [t, p] of pendingPlans) {
      if (p && p.plan && p.plan.projectionId === projectionId) { token = t; break; }
    }
  }
  if (!pid) {
    throw Object.assign(new Error('Missing required field: previewToken (or projectionId)'), { code: 'BAD_INPUT' });
  }
  if (!token) {
    // No active pending for this content id -> stale/expired/cancelled. Reported
    // as stale so the caller never applies a plan that is no longer the preview.
    return { stale: true, alreadyApplied: false, reason: 'no pending projection for this id', receipt: buildProjectionReceipt({ result: { stale: true } }) };
  }
  const pending = pendingPlans.get(token);
  if (sceneFingerprint() !== pending.baseFingerprint) {
    const receipt = buildProjectionReceipt({ plan: pending.plan, result: { stale: true } });
    pendingPlans.delete(token);
    return { stale: true, alreadyApplied: false, reason: 'scene changed since preview', receipt };
  }
  let result;
  try {
    result = applyProjectionPlan(pending.plan);
  } catch (error) {
    const receipt = buildProjectionReceipt({
      plan: pending.plan,
      result: { error: { code: error && error.code ? error.code : 'INTERNAL' } },
    });
    pendingPlans.delete(token);
    return { applied: false, error: { code: error && error.code ? error.code : 'INTERNAL', message: error && error.message ? error.message : String(error) }, receipt };
  }
  const appliedAt = Date.now();
  const receipt = buildProjectionReceipt({ plan: pending.plan, result: { ...result, appliedAt } });
  if (token) appliedByToken.set(token, { projectionId: pid, appliedAt, receipt });
  pendingPlans.delete(token);
  return { ...result, applied: true, previewToken: token, projectionId: pid, appliedAt, receipt };
}

/** Drop a pending projection without touching the scene. */
export function cancelArchifyProjection({ previewToken, projectionId } = {}) {
  const key = resolvePendingKey({ previewToken, projectionId });
  if (!key) {
    throw Object.assign(new Error('Missing required field: previewToken (or projectionId)'), { code: 'BAD_INPUT' });
  }
  const pending = pendingPlans.get(key);
  const cancelled = pendingPlans.delete(key);
  return { cancelled, receipt: buildProjectionReceipt({ plan: pending && pending.plan, result: { cancelled } }) };
}

/**
 * Drop every pending projection and the idempotency memory. Called on project
 * link/unlink / scene reset so a previous canvas's projections can never
 * block a legitimate confirm on a new canvas (Round 17 P1).
 */
export function clearProjectionState() {
  pendingPlans.clear();
  appliedByToken.clear();
  return { cleared: true };
}

/**
 * One-shot projected import (backward-compatible path used by the pre-S6
 * `canvas.importArchify`). Builds the plan, applies it immediately.
 */
export function importArchifyProjected({ ir, mode = 'merge', projectContext = null, skillContext = null } = {}) {
  requireMounted();
  const plan = buildArchifyProjectionPlan({
    ir,
    mode,
    existingElements: excalidrawAPI.getSceneElements(),
    projectContext,
    skillContext,
  });
  const result = applyProjectionPlan(plan);
  return {
    ...result,
    warnings: plan.warnings,
    unconverted: plan.unsupported,
    sourceHash: plan.sourceHash,
    bounds: plan.bounds,
  };
}

// Batch mirror of addNodes — one updateScene for all deletions.
export function removeNodes(ids) {
  requireMounted();
  const idSet = new Set(ids);
  let removed = 0;
  const updated = excalidrawAPI.getSceneElements().map((e) => {
    if (idSet.has(e.id) || (e.customData && idSet.has(e.customData.projectNodeId))) {
      if (!e.isDeleted) removed++;
      return { ...e, isDeleted: true };
    }
    return e;
  });
  excalidrawAPI.updateScene({ elements: updated });
  maybeAutoCompact(updated);
  return { removed };
}

function tombstoneShare(elements) {
  if (elements.length === 0) return 0;
  let deleted = 0;
  for (const e of elements) if (e.isDeleted) deleted++;
  return deleted / elements.length;
}

function maybeAutoCompact(elements) {
  if (tombstoneShare(elements) >= AUTO_COMPACT_TOMBSTONE_SHARE) compact();
}

// Drop tombstoned (isDeleted) elements from the scene array. Explicit command
// (canvas.compact) and the automatic fallback for removeNode/removeNodes when
// the scene accumulates more than AUTO_COMPACT_TOMBSTONE_SHARE of dead
// elements. No-op (no updateScene) when there is nothing to drop.
export function compact() {
  requireMounted();
  const existing = excalidrawAPI.getSceneElements();
  const before = existing.length;
  const kept = existing.filter((e) => !e.isDeleted);
  if (kept.length === before) {
    return { before, after: before, removed: 0 };
  }
  excalidrawAPI.updateScene({ elements: kept });
  return { before, after: kept.length, removed: before - kept.length };
}

export function panBy(dx, dy) {
  requireMounted();
  const appState = excalidrawAPI.getAppState();
  excalidrawAPI.updateScene({ appState: { scrollX: appState.scrollX + dx, scrollY: appState.scrollY + dy } });
}

export function selectElement(id) {
  requireMounted();
  const el = excalidrawAPI.getSceneElements().find((e) => e.id === id || e.customData?.projectNodeId === id);
  if (!el) throw Object.assign(new Error(`Element not found: ${id}`), { code: 'NOT_FOUND' });
  excalidrawAPI.updateScene({ appState: { selectedElementIds: { [el.id]: true } } });
  return { id: el.id };
}

export function clearSelection() {
  requireMounted();
  excalidrawAPI.updateScene({ appState: { selectedElementIds: {} } });
}

export function fitToScreen() {
  requireMounted();
  excalidrawAPI.scrollToContent(undefined, { fitToViewport: true });
}

export function loadExcalidrawDocument(document) {
  requireMounted();
  if (!document || document.type !== 'excalidraw' || !Array.isArray(document.elements)) {
    throw Object.assign(new Error('Invalid Excalidraw document'), { code: 'INVALID_EXCALIDRAW_FILE' });
  }
  clearProjectionState();
  if (typeof excalidrawAPI.resetScene !== 'function') {
    throw Object.assign(new Error('This Excalidraw build cannot safely isolate project files'), { code: 'RESET_UNAVAILABLE' });
  }
  // resetScene clears elements, history AND the binary-files store. Merely
  // updateScene([])+addFiles() leaks embedded files from the previous project.
  excalidrawAPI.resetScene();
  if (document.files && typeof excalidrawAPI.addFiles === 'function') {
    excalidrawAPI.addFiles(Object.values(document.files));
  }
  const savedState = document.appState || {};
  const appState = {
    viewBackgroundColor: savedState.viewBackgroundColor,
    gridSize: savedState.gridSize ?? null,
    selectedElementIds: {},
    editingElement: null,
  };
  excalidrawAPI.updateScene({
    elements: document.elements,
    appState,
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  return { loaded: true, elements: document.elements.length };
}

export function emptyExcalidrawDocument() {
  requireMounted();
  clearProjectionState();
  if (typeof excalidrawAPI.resetScene !== 'function') {
    throw Object.assign(new Error('This Excalidraw build cannot safely isolate project files'), { code: 'RESET_UNAVAILABLE' });
  }
  excalidrawAPI.resetScene();
  excalidrawAPI.updateScene({ elements: [], appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
  return { loaded: true, elements: 0 };
}

export function serializeExcalidrawDocument() {
  requireMounted();
  const elements = typeof excalidrawAPI.getSceneElementsIncludingDeleted === 'function'
    ? excalidrawAPI.getSceneElementsIncludingDeleted()
    : excalidrawAPI.getSceneElements();
  const state = excalidrawAPI.getAppState();
  return {
    type: 'excalidraw',
    version: 2,
    source: 'canvas-v2-rebuild',
    elements,
    appState: { viewBackgroundColor: state.viewBackgroundColor, gridSize: state.gridSize ?? null },
    files: typeof excalidrawAPI.getFiles === 'function' ? excalidrawAPI.getFiles() : {},
  };
}

// Test-only raw scene accessor (underscore prefix, same convention as
// _bindExcalidrawAPI). getScene() is the public, deliberately narrow view;
// acceptance runs need fields it does not expose (width/height, frameId,
// frame `name`, `version` to prove an arrow re-routed). Exposed to the
// renderer as window.__canvasRaw__ by renderer-entry.jsx, never used by chat.
export function _getRawElements() {
  requireMounted();
  const elements = typeof excalidrawAPI.getSceneElementsIncludingDeleted === 'function'
    ? excalidrawAPI.getSceneElementsIncludingDeleted()
    : excalidrawAPI.getSceneElements();
  return elements.map((e) => ({
    id: e.id,
    type: e.type,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    frameId: e.frameId ?? null,
    containerId: e.containerId ?? null,
    startBinding: e.startBinding ?? null,
    endBinding: e.endBinding ?? null,
    boundElements: e.boundElements ?? null,
    name: e.name ?? null,
    text: e.text ?? null,
    originalText: e.originalText ?? null,
    version: e.version,
    isDeleted: !!e.isDeleted,
    customData: e.customData ?? null,
  }));
}

// Scene -> viewport (CSS pixel) coordinates, using the package's OWN exported
// transform rather than re-deriving zoom/scroll arithmetic here. The export is
// real: dist/types/excalidraw/index.d.ts:25 re-exports it from ./utils, and the
// prod bundle carries `xt as sceneCoordsToViewportCoords` (a grep for the plain
// name in the minified bundle misses it — that is what made it look absent).
// Needed by acceptance runs that synthesise real pointer events, and by the
// upcoming selection-bounds overlay.
export function _sceneToViewport(sceneX, sceneY) {
  requireMounted();
  const st = excalidrawAPI.getAppState();
  return sceneCoordsToViewportCoords(
    { sceneX, sceneY },
    {
      zoom: st.zoom,
      offsetLeft: st.offsetLeft,
      offsetTop: st.offsetTop,
      scrollX: st.scrollX,
      scrollY: st.scrollY,
    }
  );
}

export function _getSelectedIds() {
  requireMounted();
  const s = excalidrawAPI.getAppState().selectedElementIds || {};
  return Object.keys(s).filter((k) => s[k]);
}

// Registered by mount.jsx's onChange handler — the ONLY place a real
// Excalidraw event enters this module.
export function _emitSelectionChange(ids) {
  if (JSON.stringify(ids) === JSON.stringify(lastSelectedIds)) return;
  lastSelectedIds = ids;
  for (const cb of listeners) cb({ type: 'selectionChange', ids });
}

export function onCanvasEvent(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
