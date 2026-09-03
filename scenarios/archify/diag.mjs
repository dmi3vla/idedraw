// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// Diagnostic scenario for Phase 1 bug hunt (command_engine label regression).
// Imports the real archify spec into the REAL Excalidraw scene, then dumps the
// live getSceneElements() facts the function-level tests never compared against
// (per the handoff plan 1.1-1.4): per-node bound-text geometry, id collisions,
// and the frame-membership hypothesis (re-import with command_engine un-framed).

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { runArrowRerouteDrag } from '../_helpers/drag.mjs';

export async function run(ctx = {}) {
  const { win } = ctx;
  const { archifySpec = 'canvas-v2-architecture.json' } = ctx.argv || {};
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

  const diag = await win.webContents.executeJavaScript(`(async () => {
    const ir = ${JSON.stringify(ir)};
    function expected(c) {
      const hasSub = typeof c.sublabel === 'string' && c.sublabel.length > 0;
      const dy = hasSub ? c.size[1] / 2 - 20 : c.size[1] / 2 - 10;
      return { x: c.pos[0] + 12, y: c.pos[1] + dy, subY: c.pos[1] + c.size[1] / 2 + 4 };
    }
    function dump() {
      const raw = window.__canvasRaw__.elements();
      const byId = new Map();
      for (const e of raw) byId.set(e.id, e);
      const nodeReport = ir.components.map((c) => {
        const rect = byId.get('node-' + c.id);
        const text = byId.get('text-' + c.id);
        const sub = c.sublabel ? byId.get('subtext-' + c.id) : null;
        const boundTexts = rect ? (rect.boundElements || []).filter((b) => b.type === 'text') : [];
        const exp = expected(c);
        return {
          id: c.id,
          rectPresent: !!rect,
          boundTextCount: boundTexts.length,
          textPresent: !!text,
          textContainerId: text ? text.containerId : null,
          textY: text ? text.y : null,
          subPresent: !!sub,
          subContainerId: sub ? sub.containerId : null,
          expTextY: Math.round(exp.y * 100) / 100,
          textDeltaY: text ? Math.round((text.y - exp.y) * 100) / 100 : null,
          rectY: rect ? rect.y : null,
          expRectY: c.pos[1],
          rectFrameId: rect ? rect.frameId : null,
        };
      });
      const ce = raw
        .filter((e) => (e.customData && e.customData.projectNodeId === 'command_engine') || e.id.includes('command_engine'))
        .map((e) => ({
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
          frameId: e.frameId,
          containerId: e.containerId,
          text: e.text,
          originalText: e.originalText,
          customData: e.customData || null,
          bound: (e.boundElements || []).map((b) => b.type + ':' + b.id),
        }));
      const dupText = raw.filter((e) => e.id === 'text-command_engine').length;
      const dupSub = raw.filter((e) => e.id === 'subtext-command_engine').length;
      return { nodeReport, ce, dupText, dupSub };
    }
    const r1 = window.__bridge__.use_command('canvas.importArchify', { ir, replace: true });
    if (!r1.ok) return { fatal: r1.error };
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const base = dump();
    const ir2 = JSON.parse(JSON.stringify(ir));
    for (const b of ir2.boundaries) b.wraps = b.wraps.filter((w) => w !== 'command_engine');
    const r2 = window.__bridge__.use_command('canvas.importArchify', { ir: ir2, replace: true });
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const noFrame = dump();
    const ceTextY_inFrame = (base.ce.find((e) => e.id === 'text-command_engine') || {}).y;
    const ceTextY_noFrame = (noFrame.ce.find((e) => e.id === 'text-command_engine') || {}).y;
    return {
      r1ok: r1.ok,
      r2ok: r2.ok,
      base,
      noFrame,
      ceTextY_inFrame,
      ceTextY_noFrame,
      dupText: base.dupText,
      dupSub: base.dupSub,
    };
  })()`);

  if (diag.fatal) {
    console.error('ARCHIFY-DIAG FATAL: ' + JSON.stringify(diag.fatal));
    app.quit();
    return;
  }
  // Empirical probe (per handoff 1.1-1.4): confirm the label renders INSIDE the
  // rect at rest, and that a real interaction never drops it BELOW the rect (the
  // 'command_engine sag'). With the label now a FREE overlay, a real drag moves
  // the rect but not the label, so its offset vs. the rect changes — that is
  // expected; what must never happen is the label landing below the box.
  const ceBefore = diag.base.ce.find((e) => e.id === 'node-command_engine') || {};
  const yBefore = (diag.base.ce.find((e) => e.id === 'text-command_engine') || {}).y;
  const rectYBefore = ceBefore.y;
  const rectH = ceBefore.height;
  // Reuse the PROVEN-moving drag (runArrowRerouteDrag moves node-command_engine
  // for real in this headless setup) to trigger any Excalidraw recompute.
  const drag = await runArrowRerouteDrag({ win, nodeId: 'node-command_engine', arrowId: 'edge-bridge-to-engine', dy: 60 });
  const after = await win.webContents.executeJavaScript(
    "(() => { const raw = window.__canvasRaw__; const t = raw.elements().find((e) => e.id === 'text-command_engine'); const r = raw.elements().find((e) => e.id === 'node-command_engine'); return { ty: t ? t.y : null, ry: r ? r.y : null }; })()"
  );
  const labelOffsetBefore = (yBefore != null && rectYBefore != null) ? yBefore - rectYBefore : null;
  const labelOffsetAfter = (after.ty != null && after.ry != null) ? after.ty - after.ry : null;
  const labelBelowAfterDrag = (after.ty != null && after.ry != null && rectH != null) ? after.ty > after.ry + rectH : null;
  const restOffsetInside = (labelOffsetBefore != null && rectH != null) ? (labelOffsetBefore >= 0 && labelOffsetBefore <= rectH - 20) : null;
  console.log('ARCHIFY-DIAG ' + JSON.stringify({
    ...diag,
    desyncProbe: {
      labelOffsetBefore,
      labelOffsetAfter,
      restOffsetInside: restOffsetInside === null ? 'n/a' : restOffsetInside,
      labelBelowAfterDrag: labelBelowAfterDrag === null ? 'n/a' : labelBelowAfterDrag,
      nodeMovedBy: drag.nodeMovedBy,
      selectedOnPointerDown: drag.selectedOnPointerDown,
    },
  }, null, 2));
  app.quit();
}
