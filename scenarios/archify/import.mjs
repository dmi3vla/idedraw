// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// --- Archify Phase 1: import the IR as LIVE canvas elements ------------------
// Reads the spec here in main (the renderer has no fs access), hands it to the
// real bridge command, then proves the result is editable rather than a
// picture: native frame elements present, frame membership wired, a node
// selectable through the bridge, and a node MOVABLE with its arrow re-routing.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runArrowRerouteDrag } from '../_helpers/drag.mjs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { theme = 'dark', archifySpec = 'canvas-v2-architecture.json' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  const specPath = path.isAbsolute(archifySpec) ? archifySpec : path.join(__dirname, archifySpec);
  let ir;
  try {
    ir = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (e) {
    console.error(`FATAL: cannot read archify spec ${specPath}: ${e.message}`);
    app.quit();
    return;
  }

  const report = await win.webContents.executeJavaScript(`(async () => {
    const ir = ${JSON.stringify(ir)};
    const res = window.__bridge__.use_command('canvas.importArchify', { ir, replace: true });
    if (!res.ok) return { fatal: res.error };

    const raw = window.__canvasRaw__;
    const all = raw.elements();
    const frames = all.filter((e) => e.type === 'frame');
    const rects = all.filter((e) => e.type === 'rectangle');
    const arrows = all.filter((e) => e.type === 'arrow');
    // Sublabel is now part of the bound label (single two-line text). Count bound
    // texts that carry a newline (a merged label+sublabel) as 'sublabeled'.
    const texts = all.filter((e) => e.type === 'text');
    const subs = texts.filter((e) => e.customData && e.customData.projectNodeId && (e.text || '').includes(String.fromCharCode(10)));

    // Phase 1 regression (per handoff 1.1/1.4): the earlier problems[] only
    // counted elements and checked rect positions. A label rendered outside its
    // rect (the 'command_engine sag') was invisible to that. The label is now a
    // REAL BOUND text produced by Excalidraw's own converter
    // (convertToExcalidrawElements -> bindTextToContainer -> redrawTextBoundingBox),
    // so it is born centred INSIDE the rect and stays there on every recompute.
    // Verify each imported node's label element is properly bound to its rect and
    // sits inside the rect (and carries the sublabel line when one is expected).
    const labelProbe = ir.components.map((c) => {
      const hasSub = typeof c.sublabel === 'string' && c.sublabel.length > 0;
      const rect = all.find((e) => e.id === 'node-' + c.id);
      const text = all.find((e) => e.id === 'text-' + c.id);
      const issues = [];
      if (!rect) issues.push('no rect');
      if (!text) issues.push('no bound label text');
      if (text && text.containerId !== 'node-' + c.id) issues.push('label not container-bound (containerId ' + (text && text.containerId) + ')');
      if (text && (rect.boundElements || []).filter((b) => b.type === 'text' && b.id === text.id).length !== 1) {
        issues.push('rect does not back-reference its bound text');
      }
      if (text && rect && !(text.y >= rect.y && text.y + text.height <= rect.y + rect.height)) {
        issues.push('label not inside its rect (sag risk)');
      }
      if (hasSub && text && !(text.text || '').includes(c.sublabel)) {
        issues.push('sublabel line missing from bound label');
      }
      if (text && rect && (text.width > rect.width || text.x < rect.x - 0.5 || text.x + text.width > rect.x + rect.width + 0.5)) {
        issues.push('label overflow horizontally (textW ' + Math.round(text.width) + ' > rectW ' + Math.round(rect.width) + ' or x outside rect)');
      }
      return { id: c.id, rectW: rect ? Math.round(rect.width) : null, textW: text ? Math.round(text.width) : null, textX: text ? Math.round(text.x) : null, rectX: rect ? Math.round(rect.x) : null, issues };
    }).filter((p) => p.issues.length);

    // Geometry fidelity (S7-aware). The projection plan replaces with an
    // origin-normalised, S7-widened scene: every node is shifted by ONE uniform
    // (offsetX, offsetY), never shrunk, and keeps its declared centre. The old
    // verbatim pos/size assertion broke on both of those intentional changes, so
    // we now assert the actual contract instead: a single shared translation, no
    // shrinking, preserved height, and preserved centre. We derive offsetX from
    // the first node and require all other nodes to agree (frame-precision eps).
    const expected = new Map(ir.components.map((c) => [c.id, c]));
    const misplaced = [];
    const eps = 1e-6;
    let refOffsetX = null;
    let refOffsetY = null;
    for (const r of rects) {
      const c = expected.get(r.customData && r.customData.projectNodeId);
      if (!c) continue;
      const sw = typeof c.width === 'number' ? c.width : Array.isArray(c.size) ? c.size[0] : null;
      const sh = typeof c.height === 'number' ? c.height : Array.isArray(c.size) ? c.size[1] : null;
      const sx = c.pos ? c.pos[0] : c.x;
      const sy = c.pos ? c.pos[1] : c.y;
      if (sw === null || sh === null) continue;
      const offsetX = r.x + r.width / 2 - (sx + sw / 2);
      const offsetY = r.y - sy;
      if (refOffsetX === null) { refOffsetX = offsetX; refOffsetY = offsetY; }
      const issues = [];
      if (Math.abs(offsetX - refOffsetX) > 0.6) issues.push('centre-x offset ' + offsetX.toFixed(1) + ' != ' + refOffsetX.toFixed(1));
      if (Math.abs(offsetY - refOffsetY) > 0.6) issues.push('y offset ' + offsetY.toFixed(1) + ' != ' + refOffsetY.toFixed(1));
      if (r.width < sw - eps) issues.push('shrunk ' + r.width + ' < ' + sw);
      if (Math.abs(r.height - sh) > 0.6) issues.push('height ' + r.height + ' != ' + sh);
      if (issues.length) misplaced.push({ id: c.id, got: [r.x, r.y, r.width, r.height], want: [sx, sy, sw, sh], issues });
    }

    // Frame membership: every rect that belongs to a boundary must carry a
    // frameId pointing at a real frame element in the scene.
    const frameIds = new Set(frames.map((f) => f.id));
    const wrapped = new Set(ir.boundaries.flatMap((b) => b.wraps));
    const membershipBroken = rects
      .filter((r) => wrapped.has(r.customData && r.customData.projectNodeId))
      .filter((r) => !r.frameId || !frameIds.has(r.frameId))
      .map((r) => r.customData.projectNodeId);

    // S7 live overlap proof: machine-readable same-row pair gaps from the
    // actual rendered rectangles, before the drag probe mutates one node.
    const rowPairs = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (!(a.y < b.y + b.height && b.y < a.y + a.height)) continue;
      const left = a.x <= b.x ? a : b;
      const right = left === a ? b : a;
      rowPairs.push({
        left: left.customData && left.customData.projectNodeId,
        right: right.customData && right.customData.projectNodeId,
        gap: Math.round((right.x - (left.x + left.width)) * 10) / 10,
      });
    }
    const adjacentPairs = rowPairs.filter((pair) => !rowPairs.some((other) => other.left === pair.left && other.gap >= 0 && other.gap < pair.gap));
    const layoutSafety = {
      overlapCount: rowPairs.filter((p) => p.gap < 0).length,
      minimumRowGap: adjacentPairs.length ? Math.min(...adjacentPairs.map((p) => p.gap)) : null,
      rowPairs: adjacentPairs,
    };

    // --- liveness (1.8): not a picture -------------------------------------
    const probeId = 'bridge_layer';
    const sel = window.__bridge__.use_command('canvas.selectElement', { id: probeId });
    const selectedIds = raw.selectedIds();

    const before = raw.elements().find((e) => e.customData && e.customData.projectNodeId === probeId && e.type === 'rectangle');
    const mv = window.__bridge__.use_command('canvas.updateNode', {
      id: 'node-' + probeId,
      patch: { x: before.x, y: before.y + 60 },
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = raw.elements().find((e) => e.id === 'node-' + probeId);

    // put it back so the screenshot matches the archify reference layout
    window.__bridge__.use_command('canvas.updateNode', { id: 'node-' + probeId, patch: { x: before.x, y: before.y } });
    window.__bridge__.use_command('canvas.clearSelection');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Selection reaching the chat context store is what Stream B will hang off.
    window.__bridge__.use_command('canvas.selectElement', { id: probeId });
    await new Promise((r) => setTimeout(r, 250));
    const contextSelection = window.__bridge__.query({ what: 'canvas.selection' });
    window.__bridge__.use_command('canvas.clearSelection');

    return {
      importResult: res.data,
      counts: {
        frames: frames.length,
        nodes: rects.length,
        arrows: arrows.length,
        sublabels: subs.length,
        elements: all.length,
      },
      expected: {
        frames: ir.boundaries.length,
        nodes: ir.components.length,
        arrows: ir.connections.length,
      },
      frameNames: frames.map((f) => f.name),
      nativeFrameType: frames.every((f) => f.type === 'frame'),
      misplaced,
      membershipBroken,
      layoutSafety,
      labelProbe,
      // Per-node text-fit facts (all nodes, not just the failing ones): does the
      // text Excalidraw actually measured fit horizontally inside the rect?
      fitProbe: ir.components.map((c) => {
        const rect = all.find((e) => e.id === 'node-' + c.id);
        const text = all.find((e) => e.id === 'text-' + c.id);
        if (!rect || !text) return { id: c.id, present: false };
        const textLines = String(text.text || '').split('\\n').length;
        const fits =
          text.width <= rect.width &&
          text.x >= rect.x - 0.5 &&
          text.x + text.width <= rect.x + rect.width + 0.5 &&
          text.y >= rect.y - 0.5 &&
          text.y + text.height <= rect.y + rect.height + 0.5;
        return {
          id: c.id,
          rectW: Math.round(rect.width * 10) / 10,
          textW: Math.round(text.width * 10) / 10,
          rectH: Math.round(rect.height * 10) / 10,
          textH: Math.round(text.height * 10) / 10,
          textLines,
          rectX: Math.round(rect.x * 10) / 10,
          textX: Math.round(text.x * 10) / 10,
          overflowRight: Math.round((text.x + text.width - (rect.x + rect.width)) * 10) / 10,
          overflowLeft: Math.round((rect.x - text.x) * 10) / 10,
          overflowBottom: Math.round((text.y + text.height - (rect.y + rect.height)) * 10) / 10,
          fits,
        };
      }),
      liveness: {
        selectOk: sel.ok,
        selectedIds,
        moveOk: mv.ok,
        movedBy: after ? after.y - before.y : null,
        contextSelectionIds: contextSelection.ok ? contextSelection.data.ids : null,
      },
    };
  })()`);

  if (report.fatal) {
    console.error('ARCHIFY-IMPORT FAILED: ' + JSON.stringify(report.fatal));
    app.quit();
    return;
  }

  // Visual-proof capture (Phase 1 acceptance 1.4): grab the CLEAN imported
  // diagram BEFORE any node is dragged, so the screenshot shows every label in
  // place. The arrow-reroute drag below moves command_engine; capture first so
  // the picture is undisturbed by the probe drag.
  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    const outName = `archify-import-${theme}.png`;
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log(`WROTE artifacts/${outName}`);

    // Pixel proof (handoff 1.3/1.4 + review round 2): read the REAL rendered
    // canvas, not stored data. Per-NODE, for every node (not just command_engine):
    //  - sample bg from the empty top strip of the rect (label is vertically
    //    centred, so the top strip is pure background);
    //  - measure ink INSIDE the central band (the bound label lives here);
    //  - measure ink in bands JUST OUTSIDE the LEFT and RIGHT borders
    //    (starting rh*0.1 out to clear border antialiasing) — a label clipped
    //    horizontally lands its glyphs there.
    // Return ok only when each node has text inside AND no ink in left/right bands.
    const pixel = await win.webContents.executeJavaScript(`
      (() => {
        const raw = window.__canvasRaw__;
        const canvas = document.querySelector('.excalidraw__canvas');
        if (!canvas) return { ok: false, reason: 'missing canvas' };
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const dev = (sx, sy) => { const v = raw.sceneToViewport(sx, sy); return [Math.round(v.x * dpr), Math.round(v.y * dpr)]; };
        // Reconstruct Excalidraw's font string exactly (getFontString: "<size>px <family>, <fallbacks>").
        // fontFamily 1 = Virgil, whose stacks are Virgil + Xiaolai + "Segoe UI Emoji". None are loaded
        // (only Assistant has an @font-face), so this resolves to the same system fallback the render uses.
        const fontFor = (textEl) => textEl.fontSize + 'px Virgil, Xiaolai, "Segoe UI Emoji"';
        const measureMaxLineW = (textEl) => {
          if (!textEl || !textEl.text) return null;
          const mctx = document.createElement('canvas').getContext('2d');
          mctx.font = fontFor(textEl);
          let w = 0;
          for (const line of String(textEl.text).split('\\n')) w = Math.max(w, mctx.measureText(line).width);
          return Math.round(w * 10) / 10;
        };
        const fontProbe = {
          virgilLoaded: document.fonts.check('16px Virgil'),
          assistantLoaded: document.fonts.check('16px Assistant'),
          excalifontLoaded: document.fonts.check('16px Excalifont'),
          widths: (() => { const c = document.createElement('canvas').getContext('2d'); const r = {};
            for (const fam of ['Virgil', 'Assistant', 'Excalifont', 'Helvetica']) { c.font = '16px ' + fam; r[fam] = Math.round(c.measureText('Command Engine').width * 10) / 10; }
            return r; })(),
        };
        const inkCount = (px, py, pw, ph, bg) => {
          if (pw <= 0 || ph <= 0) return 0;
          const d = ctx.getImageData(px, py, pw, ph).data; let c = 0;
          for (let i = 0; i < d.length; i += 4) { const a = (d[i] + d[i+1] + d[i+2]) / 3; if (Math.abs(a - bg) > 20) c++; }
          return c;
        };
        const nodes = raw.elements().filter((e) => e.type === 'rectangle' && e.customData && e.customData.projectNodeId);
        const byId = new Map(raw.elements().map((e) => [e.id, e]));
        const per = nodes.map((rect) => {
          const text = byId.get('text-' + rect.customData.projectNodeId);
          const [x0, y0] = dev(rect.x, rect.y);
          const [x1, y1] = dev(rect.x + rect.width, rect.y + rect.height);
          const rw = x1 - x0, rh = y1 - y0;
          const bx = x0 + Math.round(rw * 0.05);
          const byTop = y0 + Math.round(rh * 0.06);
          const bw = Math.round(rw * 0.9), bhTop = Math.max(2, Math.round(rh * 0.08));
          const topData = ctx.getImageData(bx, byTop, bw, bhTop).data;
          let bgSum = 0, bgN = 0;
          for (let i = 0; i < topData.length; i += 4) { bgSum += (topData[i] + topData[i+1] + topData[i+2]) / 3; bgN++; }
          const bg = bgSum / bgN;
          const inkCount = (px, py, pw, ph) => {
            if (pw <= 0 || ph <= 0) return 0;
            const d = ctx.getImageData(px, py, pw, ph).data; let c = 0;
            for (let i = 0; i < d.length; i += 4) { const a = (d[i] + d[i+1] + d[i+2]) / 3; if (Math.abs(a - bg) > 20) c++; }
            return c;
          };
          // Full text block extent: scan columns over the whole text height but
          // EXCLUDE the rows at the exact vertical centre, where arrows enter/leave
          // the rect. This isolates the label glyphs (both lines) from arrow ink.
          const textTop = y0 + Math.round(rh * 0.12);
          const textBot = y0 + Math.round(rh * 0.88);
          const centreY = y0 + Math.round(rh * 0.5);
          const excludeTop = centreY - 4, excludeBot = centreY + 4;
          const inL = x0 + 10, inR = x1 - 10;
          let extentL = null, extentR = null;
          for (let col = inL; col < inR; col++) {
            let hasInk = false;
            for (let row = textTop; row < textBot; row++) {
              if (row >= excludeTop && row <= excludeBot) continue;
              const d = ctx.getImageData(col, row, 1, 1).data;
              const a = (d[0] + d[1] + d[2]) / 3;
              if (Math.abs(a - bg) > 20) { hasInk = true; break; }
            }
            if (hasInk) { if (extentL === null) extentL = col; extentR = col; }
          }
          const midY = y0 + Math.round(rh * 0.5);
          const ch = Math.round(rh * 0.6);
          const bandX = x0 + Math.round(rw * 0.12);
          const bandW = Math.round(rw * 0.76);
          const inkInside = inkCount(bandX, midY - Math.round(ch / 2), bandW, ch, bg);
          return {
            id: rect.customData.projectNodeId,
            rectW: Math.round(rect.width * 10) / 10,
            rectDev: [x0, y0, x1, y1],
            roiL: inL, roiR: inR,
            lPad: extentL === null ? null : extentL - inL,
            rPad: extentR === null ? null : inR - 1 - extentR,
            extentL, extentR,
            inkInside,
          };
        });
        const nullExtent = per.filter((n) => n.lPad === null || n.rPad === null);
        const overflow = per.filter((n) => n.lPad !== null && n.rPad !== null && (n.lPad < 8 || n.rPad < 8));
        return { ok: overflow.length === 0, overflow, nullExtent, per, fontProbe, dpr };
      })()
    `);
    writeFileSync(
      path.join(__dirname, 'artifacts', `archify-import-pixel-${theme}.json`),
      JSON.stringify({ theme, layoutSafety: report.layoutSafety, ...pixel }, null, 2)
    );
    console.log('PIXEL-PROBE ' + JSON.stringify({ theme, ok: pixel.ok, bad: pixel.bad, dpr: pixel.dpr }));
  }

  // Arrow re-routing can ONLY be proven with a real pointer drag: updateScene
  // does not run Excalidraw's binding recalculation, so a programmatic move
  // leaves the arrow untouched no matter how correct the bindings are.
  const drag = await runArrowRerouteDrag({ win, nodeId: 'node-command_engine', arrowId: 'edge-bridge-to-engine', dy: 120 });

  // Sublabels are now merged into each node's bound label (one two-line text).
  // Only components that declare a sublabel are expected to carry one.
  const c = report.counts;
  const e = report.expected;
  const expectedSubs = ir.components.filter((comp) => typeof comp.sublabel === 'string' && comp.sublabel.length > 0).length;
  const problems = [];
  if (c.frames !== e.frames) problems.push(`frames ${c.frames} != ${e.frames}`);
  if (c.nodes !== e.nodes) problems.push(`nodes ${c.nodes} != ${e.nodes}`);
  if (c.arrows !== e.arrows) problems.push(`arrows ${c.arrows} != ${e.arrows}`);
  if (c.sublabels !== expectedSubs) problems.push(`sublabels ${c.sublabels} != ${expectedSubs}`);
  if (!report.nativeFrameType) problems.push('boundaries are not native frame elements');
  if (report.misplaced.length) problems.push(`misplaced: ${JSON.stringify(report.misplaced)}`);
  if (report.membershipBroken.length) problems.push(`frame membership broken: ${report.membershipBroken.join(', ')}`);
  if (report.labelProbe.length) problems.push(`label binding/offset regression: ${report.labelProbe.map((p) => p.id + ' [' + p.issues.join('; ') + ']').join('; ')}`);
  if (report.layoutSafety.overlapCount !== 0) problems.push(`S7 row overlaps: ${report.layoutSafety.overlapCount}`);
  if (report.layoutSafety.minimumRowGap !== null && report.layoutSafety.minimumRowGap < 32) problems.push(`S7 minimum row gap ${report.layoutSafety.minimumRowGap} < 32`);
  if (!report.liveness.selectOk) problems.push('imported node not selectable through the bridge');
  if (report.liveness.movedBy !== 60) problems.push(`imported node not movable (moved by ${report.liveness.movedBy})`);
  if (!report.liveness.contextSelectionIds || report.liveness.contextSelectionIds.length === 0) {
    problems.push('selection of an imported node never reached the chat context store');
  }
  if (drag.fatal) {
    problems.push(`real-drag probe failed: ${drag.fatal}`);
  } else {
    if (drag.selectedOnPointerDown !== `node-command_engine`) {
      // Centre-to-centre arrows used to swallow this click (the arrow is drawn
      // AND hit-tested through the node's interior); border-clipped arrows fix it.
      problems.push(`pointer click on a node hit ${JSON.stringify(drag.selectedOnPointerDown)} instead of the node`);
    }
    if (drag.nodeMovedBy !== 120) problems.push(`real drag did not move the node (moved by ${drag.nodeMovedBy})`);
    if (drag.labelMovedBy !== 120) problems.push(`bound label did not follow the node on drag (moved by ${drag.labelMovedBy})`);
    if (!drag.arrowGeomChanged) problems.push('arrow did not re-route on a real pointer drag (shape boundElements back-reference missing?)');
  }

  console.log('ARCHIFY-IMPORT ' + JSON.stringify({ ...report, realDrag: drag, problems }, null, 2));
  mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
  writeFileSync(
    path.join(__dirname, 'artifacts', 'archify-import.json'),
    JSON.stringify({ spec: path.basename(specPath), ...report, realDrag: drag, problems }, null, 2)
  );
  console.log('WROTE artifacts/archify-import.json');
  console.log(problems.length === 0 ? 'ARCHIFY-IMPORT: ALL CHECKS PASSED' : `ARCHIFY-IMPORT: ${problems.length} PROBLEM(S)`);

  app.quit();
}
