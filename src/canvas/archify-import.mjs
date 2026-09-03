// Archify IR -> canvas primitives. PURE data transformation: no bridge calls,
// no Excalidraw, no side effects, nothing imported from adapter.mjs. That is
// deliberate — the whole point of Phase 1 is that the mapping can be tested
// in plain Node (see tests/archify-import.test.mjs) before anything touches a
// live scene.
//
// WHY A CONVERTER AND NOT AN EMBEDDED ARCHIFY VIEW:
// archify nodes are static (fixed pos/size, authored once by the skill), our
// canvas is live (Excalidraw CRUD through the bridge). Importing the IR as
// ordinary Excalidraw elements means the result is editable, selectable and
// pin-able like any other node, instead of being a prettier picture in a
// separate pane.
//
// PROVENANCE OF THE GEOMETRY CONSTANTS BELOW:
// read off archify's own architecture renderer
// (~/.agents/skills/archify/renderers/architecture/render-architecture.mjs,
// `layout` object + boundaryRect()), not guessed. Two independent facts make
// replicating them safe:
//   * archify keeps pos/size in the IR itself, so node coordinates are copied,
//     never recomputed;
//   * boundary rects are NOT in the IR (only `wraps`), so they are derived —
//     and tests/archify-import.test.mjs asserts our derived rects are
//     byte-equal to the rects archify reports in `archify validate
//     --layout-json`. If archify ever changes the rule, that test fails.

// archify: layout.boundaryPad
const ARCHIFY_BOUNDARY_PAD = 30;
// archify: layout.boundaryExtraBottom
const ARCHIFY_BOUNDARY_EXTRA_BOTTOM = 20;
// archify: max(boundaryPad, boundaryLabelBaseline 18 + boundaryLabelClearance 4)
const ARCHIFY_BOUNDARY_TOP_PAD = 30;
// archify: layout.defaultW / layout.defaultH, used when `size` is omitted
const ARCHIFY_DEFAULT_W = 120;
const ARCHIFY_DEFAULT_H = 60;
// S7: bound labels use 16px Virgil/fallback text, while Excalidraw's stored
// text.width can under-report painted glyph extents. Keep sizing deterministic
// (preview and confirm must hash the same plan) by using a conservative glyph
// metric instead of browser-only measureText. The extra 36px covers Excalidraw's
// bound-text padding plus an >=8px visible margin on both sides.
const ARCHIFY_LABEL_FONT_SIZE = 16;
const ARCHIFY_LABEL_HORIZONTAL_GUARD = 36;

export function estimateArchifyLabelWidth(text, fontSize = ARCHIFY_LABEL_FONT_SIZE) {
  const scale = fontSize / 16;
  let width = 0;
  for (const ch of Array.from(String(text ?? ''))) {
    if (/\s/.test(ch)) width += 4.8;
    else if (/[MW@#%&]/.test(ch)) width += 12.5;
    else if (/[A-Z]/.test(ch)) width += 10.2;
    else if (/[ilI1|.,'`:;]/.test(ch)) width += 5.2;
    else if (/[-_\/\\]/.test(ch)) width += 7.2;
    else width += 8.8;
  }
  return width * scale;
}

export function requiredArchifyNodeWidth(label, sublabel = null) {
  const lines = [label, sublabel].filter((x) => typeof x === 'string' && x.length > 0);
  const painted = Math.max(0, ...lines.map((line) => estimateArchifyLabelWidth(line)));
  return Math.ceil(painted + ARCHIFY_LABEL_HORIZONTAL_GUARD);
}

// S7 / P2: bound labels are a single 16px text. An extremely long path or URL
// must never grow the box without bound. `ARCHIFY_LABEL_MAX_WIDTH` caps the
// painted width of the widest line; lines that exceed it are wrapped
// deterministically at `/ . - _` (and whitespace) boundaries so we never split a
// codepoint or a directory/segment mid-identifier. `ARCHIFY_LABEL_LINE_HEIGHT`
// is the painted leading for a 16px line, so the box can grow VERTICALLY instead.
export const ARCHIFY_LABEL_MAX_WIDTH = 320;
const ARCHIFY_LABEL_LINE_HEIGHT = 20;
const ARCHIFY_LABEL_MAX_LINES = 8;

// Break a single token (no break char) that is itself wider than maxWidth by
// slicing it on grapheme boundaries. Never splits a Unicode code point.
function sliceLongToken(token, maxWidth) {
  const chars = Array.from(String(token ?? ''));
  const out = [];
  let cur = '';
  for (const ch of chars) {
    if (cur && estimateArchifyLabelWidth(cur + ch) > maxWidth) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Deterministically wrap `text` so every returned line's painted width <= maxWidth.
// Breaks preferentially at `/ . - _ \\` and whitespace; falls back to grapheme
// slicing when a single token is itself wider than maxWidth. Pure and replayable.
export function wrapArchifyLabelText(text, maxWidth = ARCHIFY_LABEL_MAX_WIDTH) {
  const full = String(text ?? '');
  if (!full) return [''];
  if (estimateArchifyLabelWidth(full) <= maxWidth) return [full];

  // Tokenise so each piece ends at a break char; `/x/y` becomes `x/` `y`.
  const tokens = [];
  let buf = '';
  for (const ch of full) {
    buf += ch;
    if (/[/.\-_\\\s]/.test(ch)) { tokens.push(buf); buf = ''; }
  }
  if (buf) tokens.push(buf);

  const lines = [];
  let cur = '';
  const pushToken = (tok) => {
    if (estimateArchifyLabelWidth(tok) > maxWidth) {
      for (const piece of sliceLongToken(tok, maxWidth)) pushToken(piece);
      return;
    }
    if (cur && estimateArchifyLabelWidth(cur + tok) > maxWidth) {
      lines.push(cur);
      cur = tok;
    } else {
      cur += tok;
    }
  };
  for (const t of tokens) pushToken(t);
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push(full);
  return lines;
}

// The two-line node label rendered by buildNodeElements is `label` + newline +
// `sublabel`. Wrap EACH line independently and return the flattened lines plus
// the painted width the widest wrapped line needs (before the horizontal guard).
function ellipsizeArchifyLine(text, maxWidth = ARCHIFY_LABEL_MAX_WIDTH) {
  const ellipsis = '…';
  const chars = Array.from(String(text ?? ''));
  while (chars.length && estimateArchifyLabelWidth(chars.join('') + ellipsis) > maxWidth) chars.pop();
  return chars.join('') + ellipsis;
}

function wrapArchifyNodeLines(label, sublabel = null, maxWidth = ARCHIFY_LABEL_MAX_WIDTH) {
  const raw = [label, sublabel].filter((x) => typeof x === 'string' && x.length > 0);
  const allLines = raw.flatMap((line) => wrapArchifyLabelText(line, maxWidth));
  const truncated = allLines.length > ARCHIFY_LABEL_MAX_LINES;
  const lines = truncated
    ? [...allLines.slice(0, ARCHIFY_LABEL_MAX_LINES - 1), ellipsizeArchifyLine(allLines.slice(ARCHIFY_LABEL_MAX_LINES - 1).join(''), maxWidth)]
    : allLines;
  const painted = Math.max(0, ...lines.map((l) => estimateArchifyLabelWidth(l)));
  return { lines, paintedLines: lines.length, paintedWidth: painted, truncated, totalPaintedLines: allLines.length };
}

// Width that fits the widest wrapped line, capped so a pathological label never
// grows the box past the cap (height absorbs the rest via the line count).
export function requiredArchifyNodeWidthWrapped(label, sublabel = null, maxWidth = ARCHIFY_LABEL_MAX_WIDTH) {
  const { paintedWidth } = wrapArchifyNodeLines(label, sublabel, maxWidth);
  return Math.ceil(Math.min(paintedWidth, maxWidth) + ARCHIFY_LABEL_HORIZONTAL_GUARD);
}

// Height that fits the wrapped line count PLUS the declared base height, so a
// label that wraps vertically grows the box instead of clipping horizontally.
export function requiredArchifyNodeHeight(label, sublabel = null, baseHeight = ARCHIFY_DEFAULT_H, maxWidth = ARCHIFY_LABEL_MAX_WIDTH) {
  const { paintedLines } = wrapArchifyNodeLines(label, sublabel, maxWidth);
  const wrappedH = Math.min(Math.max(1, paintedLines), ARCHIFY_LABEL_MAX_LINES) * ARCHIFY_LABEL_LINE_HEIGHT;
  return Math.max(baseHeight, wrappedH);
}

// S7 collision safeguard. Widening preserves each node centre, which can push a
// widened neighbour into its row-neighbour. `applyArchifyRowReflow` detects
// same-row horizontal intersections and shifts the RIGHT node deterministically
// right so the clean gap between every inline pair is at least `minGap`px, in
// stable left-to-right order. When no overlap exists it returns the input
// unchanged (a true no-op), so it never perturbs a clean layout.
export const ARCHIFY_ROW_MIN_GAP = 32;
export function applyArchifyRowReflow(rects, minGap = ARCHIFY_ROW_MIN_GAP) {
  // Group nodes by row: two nodes share a row when their y-ranges overlap.
  const rows = [];
  for (const r of rects) {
    const row = rows.find((grp) => grp[0] && r.y < grp[0].y + grp[0].height && grp[0].y < r.y + r.height);
    if (row) row.push(r);
    else rows.push([r]);
  }
  const shifted = rects.map((r) => ({ ...r }));
  const byId = new Map(shifted.map((r) => [r.id, r]));
  for (const row of rows) {
    if (row.length < 2) continue;
    // Capture the original x order so reflow keeps authored order, never reorders.
    const ordered = row.map((r) => ({ ...r })).sort((a, b) => a.x - b.x);
    let right = ordered[0].x + ordered[0].width;
    for (let i = 1; i < ordered.length; i++) {
      const cur = ordered[i];
      const desiredX = right + minGap;
      if (desiredX - cur.x > 1e-6) {
        const delta = desiredX - cur.x;
        const node = byId.get(cur.id);
        node.x += delta;
        right = node.x + node.width;
      } else {
        right = Math.max(right, cur.x + cur.width);
      }
    }
  }
  return shifted;
}

function bad(code, message) {
  return Object.assign(new Error(message), { code });
}

function slug(text, fallback) {
  const s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

// Accepts a component either in authored form (`pos`/`size`) or in the
// already-resolved form emitted by `archify validate --layout-json`
// (`x`/`y`/`width`/`height`). Both are real archify outputs; supporting both
// means the converter works on a committed spec file AND on a fresh CLI run
// without a second code path.
function componentRect(c) {
  const hasResolved = typeof c.x === 'number' && typeof c.y === 'number';
  const hasAuthored = Array.isArray(c.pos) && c.pos.length === 2;
  if (!hasResolved && !hasAuthored) {
    // archify's other layout mode places components from `row`/`col` on a grid
    // and only the renderer knows the resulting pixels. Refusing loudly with
    // the exact remedy beats importing a pile of overlapping nodes at 0,0.
    throw bad(
      'MISSING_GEOMETRY',
      `Component "${c.id}" has neither pos/size nor resolved x/y. ` +
        'It is probably using row/col grid layout — re-export the spec with ' +
        '`archify validate architecture <spec> --layout-json` and import that instead.'
    );
  }
  const x = hasResolved ? c.x : c.pos[0];
  const y = hasResolved ? c.y : c.pos[1];
  const width = typeof c.width === 'number'
    ? c.width
    : Array.isArray(c.size) ? c.size[0] : ARCHIFY_DEFAULT_W;
  const height = typeof c.height === 'number'
    ? c.height
    : Array.isArray(c.size) ? c.size[1] : ARCHIFY_DEFAULT_H;
  return { x, y, width, height };
}

// Mirrors archify boundaryRect(): the box hugs its members and is padded by
// the 30 / 30 / 30 / 50 rule (extra 20 at the bottom).
function deriveBoundaryRect(members, pad) {
  const p = typeof pad === 'number' ? pad : ARCHIFY_BOUNDARY_PAD;
  const topPad = Math.max(p, ARCHIFY_BOUNDARY_TOP_PAD);
  const minX = Math.min(...members.map((m) => m.x));
  const minY = Math.min(...members.map((m) => m.y));
  const maxX = Math.max(...members.map((m) => m.x + m.width));
  const maxY = Math.max(...members.map((m) => m.y + m.height));
  return {
    x: minX - p,
    y: minY - topPad,
    width: maxX - minX + p * 2,
    height: maxY - minY + topPad + ARCHIFY_BOUNDARY_EXTRA_BOTTOM,
  };
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * importArchifyIR(ir) -> { nodes, edges, frames, warnings, source }
 *
 * `nodes`  feed canvas.addNodes / addGraphRaw (id, label, sublabel, x, y, width, height, frameId, meta)
 * `edges`  feed canvas.addEdges (fromId, toId, label)
 * `frames` feed canvas.addFrames (id, name, x, y, width, height)
 *
 * NOT converted, on purpose (see ACCEPTANCE.md "Phase 1 scope"):
 *   ir.cards       — prose bullets, not graph facts; no natural place as a
 *                    canvas element.
 *   ir.meta.views  — `focus: [ids]` overlaps conceptually with pinnedContext
 *                    from Stream B; wiring it needs a product decision, so it
 *                    is surfaced in `source.views` and left alone.
 */
export function importArchifyIR(ir) {
  if (!ir || typeof ir !== 'object') {
    throw bad('BAD_INPUT', 'importArchifyIR: expected an archify IR object');
  }
  if (ir.diagram_type && ir.diagram_type !== 'architecture') {
    throw bad(
      'UNSUPPORTED_DIAGRAM_TYPE',
      `Only diagram_type "architecture" is supported in this pass, got "${ir.diagram_type}"`
    );
  }
  const components = Array.isArray(ir.components) ? ir.components : [];
  if (components.length === 0) {
    throw bad('BAD_INPUT', 'importArchifyIR: ir.components is empty');
  }

  const warnings = [];
  const rects = new Map();
  const nodes = [];
  for (const c of components) {
    if (!c || typeof c.id !== 'string') {
      throw bad('BAD_INPUT', 'importArchifyIR: every component needs a string id');
    }
    if (rects.has(c.id)) {
      throw bad('BAD_INPUT', `importArchifyIR: duplicate component id "${c.id}"`);
    }
    const rect = componentRect(c);
    const label = c.label ?? c.id;
    const sublabel = c.sublabel ?? null;
    // S7: fit width to the widest wrapped line (capped), and grow height to the
    // wrapped line count so an extreme label wraps vertically instead of clipping.
    const wrapped = wrapArchifyNodeLines(label, sublabel);
    const fittedWidth = requiredArchifyNodeWidthWrapped(label, sublabel);
    if (fittedWidth > rect.width) {
      // Preserve the layout centre so widening does not bias arrows or rows.
      rect.x -= (fittedWidth - rect.width) / 2;
      rect.width = fittedWidth;
    }
    rect.height = requiredArchifyNodeHeight(label, sublabel, rect.height);
    rects.set(c.id, rect);
    nodes.push({
      id: c.id,
      // The immutable Archify component id. The projection plan may remap the
      // canvas `id` on a merge collision (e.g. `web` -> `web-2`), but provenance
      // must always report this original, so it survives the remap unchanged.
      sourceId: c.id,
      label,
      sublabel,
      renderedText: wrapped.lines.join('\n'), // pre-wrapped so an extreme label renders multi-line
      ...rect,
      frameId: null, // filled in by the boundary pass below
      // Kept as customData so a later AST/Semantic-Passport pass has the
      // archify-side classification to hang off, instead of re-deriving it.
      meta: {
        archifyType: c.type ?? null,
        tag: c.tag ?? null,
        brand: typeof c.brand === 'string' ? c.brand : c.brand ? 'custom' : null,
        sources: Array.isArray(c.sources) ? c.sources : null,
      },
    });
  }

  // S7 collision safeguard: if widening made two row-neighbours intersect, push
  // them apart deterministically (min 32px gap, stable authored order). A clean
  // layout is returned byte-identical. Runs BEFORE boundary derivation so every
  // frame is re-derived around the FINAL member rects and the whole thing is
  // part of the projection identity.
  const reflowed = applyArchifyRowReflow([...rects.values()]);
  for (const r of reflowed) rects.set(r.id, r);
  for (const n of nodes) { const r = rects.get(n.id); n.x = r.x; n.y = r.y; n.width = r.width; n.height = r.height; }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // --- boundaries -> frames -------------------------------------------------
  const frames = [];
  const boundaries = Array.isArray(ir.boundaries) ? ir.boundaries : [];
  boundaries.forEach((b, index) => {
    const wraps = Array.isArray(b.wraps) ? b.wraps : [];
    const known = wraps.filter((id) => rects.has(id));
    for (const id of wraps) {
      if (!rects.has(id)) {
        warnings.push(`boundary "${b.label}" wraps unknown component "${id}" — ignored`);
      }
    }
    if (known.length === 0) {
      warnings.push(`boundary "${b.label}" has no resolvable members — skipped`);
      return;
    }
    // Prefer archify's own resolved rect when we were handed layout JSON;
    // derive it only when the input is an authored spec.
    const fittedMembersRect = deriveBoundaryRect(known.map((id) => rects.get(id)), b.pad);
    const resolved = typeof b.x === 'number' && typeof b.width === 'number'
      ? { x: b.x, y: b.y, width: b.width, height: b.height }
      : fittedMembersRect;
    // A resolved boundary was computed from the pre-S7 node widths. Expand it
    // when necessary so a widened node never protrudes beyond its frame.
    const frameRect = unionRect(resolved, fittedMembersRect);
    const frameId = `frame-${index}-${slug(b.label, String(index))}`;
    // The boundary's label is its stable Archify identity; the canvas frame id is
    // positional and can be remapped on a merge collision, so keep both.
    frames.push({ id: frameId, sourceId: b.id ?? b.label ?? frameId, name: b.label ?? null, kind: b.kind ?? 'region', ...frameRect });
    for (const id of known) {
      const n = nodeById.get(id);
      if (n.frameId) {
        // Excalidraw frame membership is single-valued (frameId is a string,
        // not a list), so overlapping boundaries cannot both own a node.
        warnings.push(
          `component "${id}" is wrapped by more than one boundary; kept "${n.frameId}", dropped "${frameId}"`
        );
        continue;
      }
      n.frameId = frameId;
    }
  });

  // --- connections -> edges -------------------------------------------------
  const edges = [];
  for (const conn of Array.isArray(ir.connections) ? ir.connections : []) {
    if (!rects.has(conn.from) || !rects.has(conn.to)) {
      warnings.push(
        `connection "${conn.id ?? `${conn.from}->${conn.to}`}" references unknown component — skipped`
      );
      continue;
    }
    // Preserve the connection's own id as the immutable provenance sourceId; the
    // plan derives a collision-safe canvas edge id independently.
    edges.push({ sourceId: conn.id ?? null, fromId: conn.from, toId: conn.to, label: conn.label ?? null });
  }

  return {
    nodes,
    edges,
    frames,
    warnings,
    // Everything intentionally left unconverted, passed through so the caller
    // can see it exists rather than silently losing it.
    source: {
      title: ir.meta?.title ?? null,
      viewBox: ir.meta?.viewBox ?? null,
      views: Array.isArray(ir.meta?.views) ? ir.meta.views : [],
      cards: Array.isArray(ir.cards) ? ir.cards : [],
    },
  };
}
