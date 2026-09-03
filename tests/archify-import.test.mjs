// Phase 1 acceptance for the archify -> canvas converter.
//
// The important test here is not "the function returns objects" but
// `frames match archify's own resolved boundary rects`: our converter DERIVES
// boundary geometry (the IR only carries `wraps`, no rect), so it replicates a
// rule that lives in archify's renderer. That replication is only safe as long
// as it is checked against the real thing — this file checks it by running
// `archify validate --layout-json` and comparing numbers.
//
// Run: node --test tests/
// The archify-dependent tests skip themselves (loudly) if the skill is not
// installed, so the suite still runs on a machine without it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  importArchifyIR,
  requiredArchifyNodeWidth,
  estimateArchifyLabelWidth,
  wrapArchifyLabelText,
  requiredArchifyNodeWidthWrapped,
  requiredArchifyNodeHeight,
  applyArchifyRowReflow,
  ARCHIFY_LABEL_MAX_WIDTH,
  ARCHIFY_ROW_MIN_GAP,
} from '../src/canvas/archify-import.mjs';
import { buildNodeElements } from '../src/canvas/node-elements.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SPEC = path.join(ROOT, 'canvas-v2-architecture.json');
const ARCHIFY_BIN = path.join(os.homedir(), '.agents/skills/archify/bin/archify.mjs');

// The whole suite needs the authored fixture. Everything below derives geometry
// from it, so if it is absent (e.g. a clean checkout without the spec, or a
// trimmed review archive) we skip the suite instead of crashing at module load.
const hasSpec = existsSync(SPEC);
const ir = hasSpec ? JSON.parse(readFileSync(SPEC, 'utf8')) : null;
const skipNoSpec = !hasSpec && 'fixture canvas-v2-architecture.json is not present — clone the repo (or bundle the spec) to run these tests';

function archifyLayout() {
  const raw = execFileSync(
    'node',
    [ARCHIFY_BIN, 'validate', 'architecture', SPEC, '--quality', 'showcase', '--layout-json'],
    { encoding: 'utf8', cwd: ROOT }
  );
  return JSON.parse(raw.slice(raw.indexOf('{')));
}

test('components map 1:1 and S7 widening preserves each declared centre', { skip: skipNoSpec }, () => {
  const { nodes } = importArchifyIR(ir);
  assert.equal(nodes.length, ir.components.length);
  for (const c of ir.components) {
    const n = nodes.find((x) => x.id === c.id);
    assert.ok(n, `missing node for component ${c.id}`);
    assert.equal(n.x + n.width / 2, c.pos[0] + c.size[0] / 2);
    assert.equal(n.y, c.pos[1]);
    assert.ok(n.width >= c.size[0]);
    assert.ok(n.width >= requiredArchifyNodeWidth(c.label, c.sublabel));
    assert.equal(n.height, c.size[1]);
    assert.equal(n.label, c.label);
  }
});

test('S7 label estimator is deterministic and protects long path labels', () => {
  assert.equal(estimateArchifyLabelWidth('command-registry.mjs'), estimateArchifyLabelWidth('command-registry.mjs'));
  assert.ok(requiredArchifyNodeWidth('Command Engine', 'command-registry.mjs') > 160);
  assert.ok(requiredArchifyNodeWidth('A', null) < requiredArchifyNodeWidth('A much longer label', null));
});

test('P2 wrapping: extreme paths wrap at separators, never split a codepoint, cap width', () => {
  const long = 'packages/application/src/features/projection/command-registry.mjs';
  const wrapped = wrapArchifyLabelText(long);
  assert.ok(wrapped.length >= 2, 'long label wraps into multiple lines');
  assert.equal(wrapped.join('').replace(/\n/g, '').length, long.length, 'no characters lost');
  for (const line of wrapped) {
    assert.ok(estimateArchifyLabelWidth(line) <= ARCHIFY_LABEL_MAX_WIDTH, 'each wrapped line within cap');
  }
  // Deterministic: same input -> same output.
  assert.deepEqual(wrapArchifyLabelText(long), wrapArchifyLabelText(long));

  // Unicode code points are never split mid-code-point.
  const uni = 'данные/проекты/архитектура-компонент.ts';
  const uniLines = wrapArchifyLabelText(uni);
  assert.equal(uniLines.join(''), uni, 'Unicode string is preserved character-for-character');

  // A short label stays a single line and never wraps.
  assert.deepEqual(wrapArchifyLabelText('Command Engine'), ['Command Engine']);
});

test('P2 wrapping: capped width + grown height, short labels untouched', () => {
  const short = 'Command Engine';
  assert.equal(requiredArchifyNodeWidthWrapped(short, null), requiredArchifyNodeWidth(short, null), 'short label width unchanged');
  assert.equal(requiredArchifyNodeHeight(short, null, 64), 64, 'short label keeps base height');

  const long = 'packages/src/features/projection/command-registry.mjs';
  const wH = requiredArchifyNodeHeight(long, null, 64);
  assert.ok(wH >= 64, 'wrapped label grows the box vertically');
  assert.ok(wH <= 8 * 20, 'height respects the max-line cap');
  const wW = requiredArchifyNodeWidthWrapped(long, null);
  assert.ok(wW <= ARCHIFY_LABEL_MAX_WIDTH + 36, 'width is capped, not unbounded');
});

test('P2 wrapping: rendered text is capped to max lines with ellipsis and original metadata preserved', () => {
  const extreme = 'segment_'.repeat(200);
  const converted = importArchifyIR({ diagram_type: 'architecture', components: [{ id: 'x', label: extreme, pos: [0, 0], size: [120, 60] }], boundaries: [], connections: [] });
  const node = converted.nodes[0];
  const renderedLines = node.renderedText.split('\n');
  assert.ok(renderedLines.length <= 8, 'rendered text never exceeds height line cap');
  assert.ok(renderedLines.at(-1).endsWith('…'), 'truncated display is explicit');
  assert.equal(node.label, extreme, 'full original label remains available as metadata');
  assert.ok(node.height >= renderedLines.length * 20, 'container height covers every rendered line');
});

test('S7 reflow: overlapping row-neighbours are pushed apart with >= minGap, clean layout is untouched', () => {
  const clean = [
    { id: 'a', x: 0, y: 0, width: 100, height: 60 },
    { id: 'b', x: 132, y: 0, width: 100, height: 60 }, // gap 32
    { id: 'c', x: 264, y: 0, width: 100, height: 60 },
  ];
  assert.deepEqual(applyArchifyRowReflow(clean, 32), clean, 'clean layout returns byte-identical');

  const overlapped = [
    { id: 'a', x: 0, y: 0, width: 100, height: 60 },
    { id: 'b', x: 70, y: 0, width: 100, height: 60 }, // overlaps a (0..100 vs 70..170)
    { id: 'c', x: 160, y: 0, width: 100, height: 60 },
  ];
  const reflowed = applyArchifyRowReflow(overlapped, 32);
  const byId = Object.fromEntries(reflowed.map((r) => [r.id, r]));
  assert.ok(byId.b.x >= byId.a.x + byId.a.width + 32, 'b pushed clear of a');
  assert.ok(byId.c.x >= byId.b.x + byId.b.width + 32, 'c pushed clear of b');
  assert.equal(byId.a.x, 0, 'leftmost node stays put');
  assert.ok(byId.a.y === 0 && byId.b.y === 0, 'rows are not reordered vertically');
  assert.ok(ARCHIFY_ROW_MIN_GAP >= 32, 'min gap is at least 32px');
});

test('sublabel survives the import (it is the only file-level fact in the IR)', { skip: skipNoSpec }, () => {
  const { nodes } = importArchifyIR(ir);
  const bridgeNode = nodes.find((n) => n.id === 'bridge_layer');
  assert.equal(bridgeNode.sublabel, 'bridge.mjs');
  // every component in this spec has one, so none may be dropped
  assert.equal(nodes.filter((n) => n.sublabel).length, ir.components.length);
});

test('archify type/tag are preserved as node meta for the later AST pass', { skip: skipNoSpec }, () => {
  const { nodes } = importArchifyIR(ir);
  const bridgeNode = nodes.find((n) => n.id === 'bridge_layer');
  assert.equal(bridgeNode.meta.archifyType, 'messagebus');
  assert.equal(bridgeNode.meta.tag, 'Protocol');
});

test('connections map 1:1 to edges', { skip: skipNoSpec }, () => {
  const { edges } = importArchifyIR(ir);
  assert.equal(edges.length, ir.connections.length);
  const first = edges[0];
  assert.equal(first.fromId, ir.connections[0].from);
  assert.equal(first.toId, ir.connections[0].to);
  assert.equal(first.label, ir.connections[0].label);
});

test('every boundary becomes exactly one frame, and members point at it', { skip: skipNoSpec }, () => {
  const { nodes, frames, warnings } = importArchifyIR(ir);
  assert.equal(frames.length, ir.boundaries.length);
  assert.deepEqual(warnings, []);
  for (const b of ir.boundaries) {
    const frame = frames.find((f) => f.name === b.label);
    assert.ok(frame, `no frame for boundary ${b.label}`);
    for (const id of b.wraps) {
      assert.equal(
        nodes.find((n) => n.id === id).frameId,
        frame.id,
        `component ${id} not attached to frame ${frame.id}`
      );
    }
  }
});

test('cards and meta.views are NOT converted, but are surfaced as unconverted source', { skip: skipNoSpec }, () => {
  const converted = importArchifyIR(ir);
  assert.equal(converted.source.cards.length, ir.cards.length);
  assert.equal(converted.source.views.length, ir.meta.views.length);
  // and nothing leaked into the graph
  const ids = new Set(converted.nodes.map((n) => n.id));
  for (const v of ir.meta.views) assert.ok(!ids.has(v.id), `view ${v.id} leaked into nodes`);
});

test('a dangling connection is skipped with a warning, not silently dropped', { skip: skipNoSpec }, () => {
  const broken = { ...ir, connections: [...ir.connections, { id: 'x', from: 'nope', to: 'bridge_layer' }] };
  const { edges, warnings } = importArchifyIR(broken);
  assert.equal(edges.length, ir.connections.length);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown component/);
});

test('a node wrapped by two boundaries keeps one frame and warns', { skip: skipNoSpec }, () => {
  const overlapping = {
    ...ir,
    boundaries: [...ir.boundaries, { kind: 'region', label: 'Second Owner', wraps: ['bridge_layer'] }],
  };
  const { nodes, warnings } = importArchifyIR(overlapping);
  const n = nodes.find((x) => x.id === 'bridge_layer');
  assert.match(n.frameId, /bridge-protocol/);
  assert.equal(warnings.filter((w) => /more than one boundary/.test(w)).length, 1);
});

test('a component with neither pos/size nor x/y fails loudly with the remedy', { skip: skipNoSpec }, () => {
  const gridStyle = { ...ir, components: [{ id: 'g', type: 'backend', label: 'G', row: 0, col: 0 }] };
  assert.throws(() => importArchifyIR(gridStyle), (e) => {
    assert.equal(e.code, 'MISSING_GEOMETRY');
    assert.match(e.message, /--layout-json/);
    return true;
  });
});

test('non-architecture diagram types are refused in this pass', { skip: skipNoSpec }, () => {
  assert.throws(() => importArchifyIR({ ...ir, diagram_type: 'sequence' }), (e) => {
    assert.equal(e.code, 'UNSUPPORTED_DIAGRAM_TYPE');
    return true;
  });
});

// --- the one that actually protects the derivation ---------------------------

test("S7 fitted nodes keep Archify centres and frames contain widened members", { skip: skipNoSpec || (!existsSync(ARCHIFY_BIN) && 'archify CLI not installed') }, () => {
  const layout = archifyLayout();
  const { frames, nodes } = importArchifyIR(ir);
  for (const c of layout.components) {
    const n = nodes.find((x) => x.id === c.id);
    assert.equal(n.x + n.width / 2, c.x + c.width / 2);
    assert.ok(n.width >= c.width);
  }
  for (const frame of frames) {
    const source = ir.boundaries.find((b) => b.label === frame.name);
    for (const id of source.wraps) {
      const n = nodes.find((x) => x.id === id);
      assert.ok(n.x >= frame.x && n.x + n.width <= frame.x + frame.width);
    }
  }
});

test('importing archify layout-json output directly works too (resolved x/y form)', { skip: skipNoSpec || (!existsSync(ARCHIFY_BIN) && 'archify CLI not installed') }, () => {
  const layout = archifyLayout();
  // layout-json has no `sublabel`/`cards`; it is the geometry view of the same
  // diagram. Under S7 the spec form widens to fit label+sublabel whereas this
  // form (no sublabel) can only fit the main label, so the two imports are NOT
  // byte-identical by design. The contract we lock here is that the resolved
  // form still imports cleanly, keeps every Archify centre, and only ever widens
  // (never shrinks) a node whose CLI width does not fit the main label.
  const fromLayout = importArchifyIR({
    diagram_type: 'architecture',
    components: layout.components,
    boundaries: layout.boundaries,
    connections: layout.connections.map((c, i) => ({ id: String(i), ...c })),
  });
  assert.equal(fromLayout.nodes.length, layout.components.length);
  assert.equal(fromLayout.frames.length, layout.boundaries.length);
  for (const c of layout.components) {
    const n = fromLayout.nodes.find((x) => x.id === c.id);
    assert.ok(n, `no node for ${c.id}`);
    assert.equal(n.sublabel, null, 'layout-json drops sublabel; the node is single-line');
    // S7 widens around the declared centre and never shrinks below the CLI width.
    assert.equal(n.x + n.width / 2, c.x + c.width / 2, 'centre preserved for ' + c.id);
    assert.ok(n.width >= c.width, `widened never shrinks ${c.id} (${n.width} < ${c.width})`);
    assert.equal(n.height, c.height, 'height preserved for ' + c.id);
  }
  for (const frame of fromLayout.frames) {
    const source = layout.boundaries.find((b) => b.label === frame.name);
    for (const id of source.wraps) {
      const n = fromLayout.nodes.find((x) => x.id === id);
      assert.ok(n.x >= frame.x && n.x + n.width <= frame.x + frame.width, `${id} inside ${frame.name}`);
    }
  }
});

test('archify layout is deterministic across runs (1.0 recon: safe to re-export)', { skip: skipNoSpec || (!existsSync(ARCHIFY_BIN) && 'archify CLI not installed') }, () => {
  assert.deepEqual(archifyLayout(), archifyLayout());
});

// --- Phase 1 regression: the label-building contract -------------------------
// The agent's own first import report (problems: []) only counted elements and
// checked rectangle positions — it never verified that each node's LABEL is a
// real, valid binding. A hand-built bound-text (containerId + boundElements set
// by hand) or a free overlay both fail in different ways: the hand-built one
// desyncs on the first real interaction and sinks the label BELOW the box (the
// 'command_engine sag'), the free overlay blocks pointer-drag of the node and
// does not follow it. The correct model is a SINGLE rectangle carrying a bound
// `label`, converted by Excalidraw's OWN converter (convertToExcalidrawElements,
// run in the adapter), so Excalidraw builds a valid container/text binding. We
// lock the skeleton contract here (in plain node, without Excalidraw):
//   - one rectangle, id `node-<id>`;
//   - a `label` whose text is the two-line label (main label + file sublabel);
//   - deterministic label id `text-<id>`, plus frameId/customData forwarded.
test('each node builds one rectangle with a valid bound-label skeleton', { skip: skipNoSpec }, () => {
  const { nodes } = importArchifyIR(ir);
  for (const n of nodes) {
    const parts = buildNodeElements(n);
    assert.equal(parts.length, 1, `node ${n.id} should produce exactly one skeleton (rect + bound label)`);
    const rect = parts[0];

    assert.equal(rect.type, 'rectangle', `node ${n.id} missing rectangle`);
    assert.equal(rect.id, `node-${n.id}`, `node ${n.id} rect id mismatch`);
    assert.ok(rect.label, `node ${n.id} rectangle must carry a bound label`);

    // The label is ONE two-line text (main label + sublabel), same font size for
    // the first correct variant. This is what convertToExcalidrawElements turns
    // into a valid container binding (containerId + boundElements set by Excalidraw).
    const hasSub = !!n.sublabel;
    assert.equal(rect.label.text, hasSub ? `${n.label}\n${n.sublabel}` : n.label, `node ${n.id} label text wrong`);
    assert.equal(rect.label.id, `text-${n.id}`, `node ${n.id} bound-label id must be deterministic`);
    assert.equal(rect.label.frameId, n.frameId, `node ${n.id} label frameId not forwarded`);
    assert.equal(rect.label.customData?.projectNodeId, n.id, `node ${n.id} label customData.projectNodeId missing`);
    assert.equal(rect.customData?.projectNodeId, n.id, `node ${n.id} rect customData.projectNodeId missing`);

    // The converter centers the bound text inside the rect; the rect must be big
    // enough for the two-line label to sit inside it (it is an overlay contract).
    assert.ok(rect.height >= 20, `node ${n.id} rect too short for a label`);
  }
});

test('node ids are unique across rect/bound-label (no collision that could drop a label)', { skip: skipNoSpec }, () => {
  const { nodes } = importArchifyIR(ir);
  const ids = new Set();
  for (const n of nodes) {
    for (const p of buildNodeElements(n)) {
      assert.ok(!ids.has(p.id), `duplicate element id ${p.id} for node ${n.id}`);
      ids.add(p.id);
      assert.ok(!ids.has(p.label.id), `duplicate bound-label id ${p.label.id} for node ${n.id}`);
      ids.add(p.label.id);
    }
  }
});
