// S6 provenance — build the safe `customData.archify` object that is written onto
// every Excalidraw element an Archify projection produces. Pure, browser-safe (no
// fs, no Node built-ins), so it can be unit-tested in plain Node AND imported by
// the renderer.
//
// SECURITY INVARIANTS (S6.7):
//   * Only project-RELATIVE evidence paths are ever kept — absolute paths, drive
//     letters, `.`/`..` segments and backslash paths are dropped.
//   * Evidence refs are deduplicated, sorted (deterministic) and capped.
//   * Never carries: project root, Archify binary path, API keys, prompt content,
//     source code, run directory, IPC sender key, or raw session/thread id.
//   * `runToken` is owned by the main run registry — it is never written here.
//   * A component/edge/frame carries ONLY the provenance we can actually state
//     (e.g. edges never fabricate evidence refs that an import did not produce).

const MAX_EVIDENCE_REFS = 64;
const MAX_EVIDENCE_REF_LEN = 200;

/** True for a path that is absolute (POSIX `/…`, Windows `C:\…`) or a `.`/`..` segment. */
function isUnsafeRel(ref) {
  if (!ref) return true;
  if (ref.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return true;
  // a `.` or `..` path segment (a dot mid-filename like `app.test.ts` is fine)
  if (/(^|\/)(\.\.?)(\/|$)/.test(ref)) return true;
  return false;
}

/**
 * Normalise + sanitize a list of evidence file refs to a deterministic, safe,
 * project-relative set. Returns a fresh array (never mutates the input).
 */
export function sanitizeEvidenceRefs(refs, { maxRefs = MAX_EVIDENCE_REFS, maxLen = MAX_EVIDENCE_REF_LEN } = {}) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  const seen = new Set();
  for (const r of refs) {
    if (typeof r !== 'string') continue;
    const trimmed = r.trim().replace(/\\/g, '/');
    if (!trimmed || trimmed.length > maxLen) continue;
    if (isUnsafeRel(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  out.sort();
  if (out.length > maxRefs) return out.slice(0, maxRefs);
  return out;
}

function safeComponentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id && id.length <= 128 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) ? id : null;
}

/** Sanitize one bounded component-local S6 AST anchor for customData. */
export function sanitizeAstAnchor(anchor, expectedComponentId = null) {
  if (!anchor || typeof anchor !== 'object') return null;
  const componentId = safeComponentId(expectedComponentId || anchor.componentId);
  if (!componentId) return null;
  const cleanLayer = (value) => {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
      const id = safeComponentId(raw?.componentId);
      if (!id || id === componentId || seen.has(id)) continue;
      seen.add(id);
      const files = sanitizeEvidenceRefs(raw?.files, { maxRefs: 8 });
      const via = safeComponentId(raw?.via);
      out.push({ componentId: id, ...(via ? { via } : {}), files });
      if (out.length >= 12) break;
    }
    return out.sort((a, b) => a.componentId.localeCompare(b.componentId));
  };
  return {
    version: 1,
    componentId,
    own: sanitizeEvidenceRefs(anchor.own, { maxRefs: 16 }),
    dependenciesL1: cleanLayer(anchor.dependenciesL1),
    dependenciesL2: cleanLayer(anchor.dependenciesL2),
    dependentsL1: cleanLayer(anchor.dependentsL1),
    dependentsL2: cleanLayer(anchor.dependentsL2),
  };
}

/**
 * buildArchifyProvenance({ ... }) -> the `customData.archify` value for one
 * element. Fields are only included when present, so the object is always
 * minimal and serializable. `sourceElementKind` is one of
 * `component | connection | boundary`; `sourceElementId` is the Archify-side id
 * (e.g. `api`, `web-api`, `backend-zone`) the element derives from.
 */
export function buildArchifyProvenance({
  sourceElementKind,
  sourceElementId,
  diagramType,
  evidenceRefs = [],
  projectSnapshot = null,
  skillHash = null,
  projectionId = null,
  astAnchor = null,
}) {
  const archify = {
    version: 1,
    ...(projectionId ? { projectionId } : {}),
    ...(diagramType ? { diagramType } : {}),
    sourceElementKind,
    ...(sourceElementId != null ? { sourceElementId } : {}),
  };
  if (skillHash) archify.skillHash = skillHash;
  if (projectSnapshot) archify.projectSnapshot = projectSnapshot;
  const refs = sanitizeEvidenceRefs(evidenceRefs);
  if (refs.length) archify.evidenceRefs = refs;
  const safeAnchor = sanitizeAstAnchor(astAnchor, sourceElementId);
  if (safeAnchor) archify.astAnchor = safeAnchor;
  return archify;
}

/**
 * Build a safe, user-facing projection receipt from a confirm/cancel result.
 * This is the ONLY surface that gets handed back to chat/UI after a projection
 * commit — never the raw plan (which carries the IR, per-node evidence refs and
 * the full projection element list). It persists only the fields the UI needs to
 * show "Imported to canvas" and remains auditable on stale/cancel/failure.
 *
 * Security invariants: no absolute paths (only hashes + relative refs that are
 * already sanitized upstream), no Archify binary path, no API keys, no prompt
 * content, no source code, no run directory, no internal sender/session ids, and
 * no `runToken` (owned by the main run registry).
 *
 * @param {object} plan   the buildArchifyProjectionPlan output (or undefined)
 * @param {object} result applied result / alreadyApplied / stale / cancelled
 * @returns {object} a minimal serializable receipt
 */
export function buildProjectionReceipt({ plan, result = {}, sourceHash = null, status = null } = {}) {
  const counts = (plan && plan.counts) || result.counts || null;
  const safe = {
    status: status || (result.applied ? 'applied' : result.alreadyApplied ? 'already_applied' : result.stale ? 'stale' : result.cancelled ? 'cancelled' : result.error ? 'failed' : 'unknown'),
    mode: result.mode || (plan && plan.mode) || null,
    projectionId: result.projectionId || (plan && plan.projectionId) || null,
    sourceHash: sourceHash || result.sourceHash || (plan && plan.sourceHash) || null,
    counts: counts ? { ...counts } : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.slice() : plan && plan.warnings ? plan.warnings.slice() : [],
    projectSnapshot: (plan && plan.provenance && plan.provenance.projectSnapshot) || (result.projectSnapshot) || null,
    skillHash: (plan && plan.provenance && plan.provenance.skillHash) || (result.skillHash) || null,
    diagramType: (plan && plan.provenance && plan.provenance.diagramType) || (result.diagramType) || null,
    appliedAt: result.appliedAt || null,
  };
  return safe;
}
