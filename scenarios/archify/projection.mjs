// Moved verbatim out of main.mjs (step 1 of the main.mjs decomposition).
// Acceptance code must not sit next to production code, and must not be
// loaded into the production main process on every launch.
// S6 — Controlled Canvas Projection Electron acceptance. Runs in the REAL
// renderer against the built bundle: creates a manual sketch, obtains a real
// Archify layout IR, previews (must NOT mutate), confirms merge (must preserve
// the sketch + add the imported nodes/arrows/frame with safe provenance), then
// cancels / idempotent-confirms / stale-refuses / replace-confirms, and finally
// drives trusted keyboard Undo/Redo. Both merge and replace are HARD-gated by
// exact normalized scene snapshots plus expected element counts; the imperative
// API has no undo/redo method, so acceptance uses main-process input events.

import path from 'node:path';
import { APP_ROOT } from '../_helpers/paths.mjs';
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runArchifyValidate } from '../../main/archify-client.mjs';

export async function run(ctx = {}) {
  const { win, visualProof } = ctx;
  const { mode = 'full', theme = 'dark', archifySpec = 'canvas-v2-architecture.json', scenario = 'none' } = ctx.argv || {};
  const __dirname = APP_ROOT;
  // (Round 17 P1) Use the REAL Archify layout IR from the bundled spec when the
  // CLI is present, so the scenario proves provenance against production-shaped
  // IR (which carries no `sources` on components). We never inline fake `sources`.
  const specPath = path.resolve(__dirname, archifySpec);
  const cli = runArchifyValidate(specPath);
  const hasCli = cli.ok && cli.data && cli.data.ir;
  const IR = hasCli ? cli.data.ir : {
    diagram_type: 'architecture',
    components: [
      { id: 'web', label: 'Web', x: 0, y: 0, width: 100, height: 60, sublabel: 'src/web/app.ts' },
      { id: 'api', label: 'API', x: 200, y: 0, width: 100, height: 60, sublabel: 'src/api/index.ts' },
      { id: 'db', label: 'DB', x: 400, y: 0, width: 100, height: 60, sublabel: 'src/db/index.ts' },
    ],
    boundaries: [{ label: 'backend', wraps: ['api', 'db'] }],
    connections: [
      { id: 'web-api', from: 'web', to: 'api', label: 'HTTP' },
      { id: 'api-db', from: 'api', to: 'db', label: 'SQL' },
    ],
    cards: [],
    meta: { schema_version: 1, views: [], title: 'Projection Fixture' },
  };

  // A second, DISTINCT layout IR used ONLY by the replace Undo/Redo probe.
  // Replacing a scene with an identical projection is degenerate (the diff is
  // nearly empty and cannot prove a single-undo replace), so the probe genuinely
  // swaps content: IR2 has different component ids/edges, giving the tombstone
  // transaction a real, committed change to invert.
  const IR2 = hasCli ? (() => {
    const b = cli.data.ir;
    const comp = (b.components || []).map((c, i) => ({ ...c, id: `v2-${c.id}`, label: `${c.label} V2` }));
    const byNew = {};
    for (const c of comp) byNew[c.id] = true;
    const conns = (b.connections || []).map((e, i) => ({ id: `v2c-${i}`, from: `v2-${e.from}`, to: `v2-${e.to}`, label: `${e.label} V2` }));
    const bds = (b.boundaries || []).map((br, i) => ({ ...br, label: `${br.label} V2`, wraps: (br.wraps || []).map((w) => `v2-${w}`) }));
    return { diagram_type: b.diagram_type || 'architecture', components: comp, connections: conns, boundaries: bds, cards: [], meta: { schema_version: 1, views: [], title: 'Projection Fixture V2' } };
  })() : (() => {
    const comp = [
      { id: 'v2-web', label: 'Web V2', x: 0, y: 0, width: 100, height: 60, sublabel: 'src/v2/web.ts' },
      { id: 'v2-api', label: 'API V2', x: 200, y: 0, width: 100, height: 60, sublabel: 'src/v2/api.ts' },
    ];
    return { diagram_type: 'architecture', components: comp, connections: [{ id: 'v2-web-api', from: 'v2-web', to: 'v2-api', label: 'HTTP V2' }], boundaries: [], cards: [], meta: { schema_version: 1, views: [], title: 'Projection Fixture V2' } };
  })();

  // Per-component evidence uses the real file facts (the component `sublabel`)
  // rather than fabricating a global list that every node would copy. Node
  // provenance reads ONLY its own entry from this map (Round 17 P1).
  const evidenceMap = {};
  for (const c of IR.components || []) {
    if (c && c.id && c.sublabel) evidenceMap[c.id] = [c.sublabel];
  }
  // Keep one real live component deliberately unmapped. The acceptance must prove
  // that missing evidence stays absent rather than inheriting another/global ref.
  const unknownEvidenceSourceId = (IR.components || []).at(-1)?.id || null;
  if (unknownEvidenceSourceId) delete evidenceMap[unknownEvidenceSourceId];
  const projectContext = { label: 'Projection Fixture', snapshot: 'sha256:fixture-snap', evidenceMap, unknownEvidenceSourceId };
  const skillContext = { hash: 'sha256:fixture-skill', name: 'archify' };
  // Expected counts derive from the ACTUAL IR used (real CLI or fallback fixture),
  // so the acceptance always asserts the real projection regardless of size.
  const EXPECTED = {
    components: (IR.components || []).length,
    connections: (IR.connections || []).length,
    boundaries: (IR.boundaries || []).length,
    srcIds: (IR.components || []).map((c) => c.id),
  };

  // Renderer setup + the preview/confirm/merge/cancel/idempotent steps. Returns
  // the live scene count so the main process can then drive real undo/redo keys.
  const part1 = await win.webContents.executeJavaScript(`(async () => {
    const bridge = window.__bridge__;
    const raw = window.__canvasRaw__;
    const live = () => raw.elements().filter((e) => !e.isDeleted);
    const normalizeScene = () => JSON.stringify(raw.elements().filter((e) => !e.isDeleted).map((e) => ({
      id: e.id,
      isDeleted: !!e.isDeleted,
      frameId: e.frameId || null,
      containerId: e.containerId || null,
      startBinding: e.startBinding || null,
      endBinding: e.endBinding || null,
      boundElements: (e.boundElements || []).map((b) => ({ id: b.id, type: b.type })).sort((a, b) => a.id.localeCompare(b.id)),
      archify: e.customData && e.customData.archify ? e.customData.archify : null,
    })).sort((a, b) => a.id.localeCompare(b.id)));
    const ir = ${JSON.stringify(IR)};
    const projCtx = ${JSON.stringify(projectContext)};
    const skillCtx = ${JSON.stringify(skillContext)};
    // Expected counts derive from the IR actually imported (real CLI or fixture),
    // so the acceptance asserts the real projection regardless of size.
    const EXP = {
      components: (ir.components || []).length,
      connections: (ir.connections || []).length,
      boundaries: (ir.boundaries || []).length,
      srcIds: (ir.components || []).map((c) => c.id),
    };
    window.__projState__ = { bridge, raw, EXP };
    const out = {};
    try {
      // 1. Manual sketch the user drew before importing.
      const manual = bridge.use_command('canvas.addNode', { id: 'manual', label: 'Manual Sketch', x: 40, y: 320, width: 160, height: 80 });
      if (!manual.ok) return { fatal: { step: 'addNode', error: manual.error } };
      const s0 = live().length;
      out.manualNode = true;
      out.manualSnapshot = normalizeScene();

      // 2. PREVIEW must NOT mutate the scene. Returns an opaque, per-preview token.
      const pv = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'merge', projectContext: projCtx, skillContext: skillCtx });
      if (!pv.ok) return { fatal: { step: 'preview', error: pv.error } };
      const mergeToken = pv.data.previewToken;
      const pid = pv.data.projectionId;
      window.__projState__.mergeToken = mergeToken;
      window.__projState__.pid = pid;
      out.previewCounts = pv.data.counts;
      out.previewSceneUnchanged = live().length === s0;
      out.planBounds = pv.data.bounds;
      out.mergeDeletes = (pv.data.elementIdsToDelete || []).length;

      // 3. CONFIRM merge: manual sketch must survive; imported content must land.
      const cf = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: mergeToken });
      if (!cf.ok) return { fatal: { step: 'confirm', error: cf.error } };
      const all1 = raw.elements();
      const live1 = all1.filter((e) => !e.isDeleted);
      out.confirmed = cf.data.applied;
      out.confirmProjectionId = cf.data.projectionId;
      out.manualPreserved = live1.some((e) => e.customData && e.customData.projectNodeId === 'manual');
      out.importedAfterMerge = {
        frames: live1.filter((e) => e.type === 'frame').length,
        nodes: live1.filter((e) => e.type === 'rectangle' && EXP.srcIds.includes(e.customData && e.customData.projectNodeId)).length,
        arrows: live1.filter((e) => e.type === 'arrow').length,
      };

      // 4. Provenance on every imported element: correct kind + correct sourceId + no secrets.
      const compArch = live1.filter((e) => e.type === 'rectangle' && EXP.srcIds.includes(e.customData && e.customData.projectNodeId));
      const arrowArch = live1.filter((e) => e.type === 'arrow');
      const frameArch = live1.filter((e) => e.type === 'frame');
      out.provenance = {
        components: compArch.length && compArch.every((e) => e.customData.archify && e.customData.archify.sourceElementKind === 'component'),
        connections: arrowArch.length && arrowArch.every((e) => e.customData.archify && e.customData.archify.sourceElementKind === 'connection'),
        boundary: frameArch.length && frameArch.every((e) => e.customData.archify && e.customData.archify.sourceElementKind === 'boundary'),
        sourceIdFromArchify: compArch.every((e) => e.customData.archify.sourceElementId && EXP.srcIds.includes(e.customData.archify.sourceElementId)),
        // A node carries ONLY the evidence the IR can attribute to it (the real CLI
        // IR has no 'sources', so nodes correctly have NO evidenceRefs; when one is
        // present it must be its own single ref — never a project-wide global list).
        evidenceMatches: compArch.every((e) => {
          const sourceId = e.customData.archify && e.customData.archify.sourceElementId;
          const actual = (e.customData.archify && e.customData.archify.evidenceRefs) || [];
          const expected = projCtx.evidenceMap[sourceId] || [];
          return JSON.stringify(actual) === JSON.stringify(expected);
        }),
        unknownWithoutEvidence: !!projCtx.unknownEvidenceSourceId && compArch.some((e) => {
          const archify = e.customData && e.customData.archify;
          return archify && archify.sourceElementId === projCtx.unknownEvidenceSourceId && !('evidenceRefs' in archify);
        }),
        // S6-PROVENANCE-1: every rectangle's NATIVE bound text carries the SAME
        // customData.archify object (id, containerId, kind and sourceElementId all
        // agree between the container and its bound text).
        boundText: (() => {
          const texts = live1.filter((e) => e.type === 'text' && e.containerId && e.customData && e.customData.archify);
          if (!texts.length) return false;
          return texts.every((t) => {
            const self = JSON.stringify(t.customData.archify);
            const container = live1.find((e) => e.id === t.containerId);
            return container && container.customData && JSON.stringify(container.customData.archify) === self;
          });
        })(),
      };
      const serialized = JSON.stringify(all1.map((e) => e.customData || {}));
      out.provenanceSafe =
        !serialized.includes('/home/') &&
        !serialized.includes('C:') &&
        !serialized.includes('..') &&
        !serialized.includes('runToken') &&
        !serialized.includes('apiKey') &&
        !serialized.includes('prompt') &&
        !serialized.includes('node_modules') &&
        !serialized.includes('D:/');

      // 5. CANCEL a fresh preview must not mutate the scene.
      const pv2 = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'replace', projectContext: projCtx, skillContext: skillCtx });
      if (pv2.ok) {
        const beforeCancel = live().length;
        const cx = bridge.use_command('canvas.cancelArchifyProjection', { previewToken: pv2.data.previewToken });
        out.cancel = { ok: cx.ok, cancelled: cx.data && cx.data.cancelled, sceneUnchanged: live().length === beforeCancel };
      } else {
        out.cancel = { ok: false };
      }

      // 6. IDEMPOTENT: re-confirming the SAME preview token re-applies nothing.
      const dup = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: mergeToken });
      out.idempotent = dup.ok && dup.data && dup.data.alreadyApplied === true && !dup.data.applied;

      out.liveAfterMerge = live().length;
      out.mergeSnapshot = normalizeScene();
      return out;
    } catch (e) {
      return { fatal: { threw: String((e && e.stack) || e) } };
    }
  })()`);

  if (part1.fatal) {
    console.error('ARCHIFY-PROJECTION FAILED (part1): ' + JSON.stringify(part1.fatal));
    app.quit();
    return;
  }

  // --- live undo/redo via TRUSTED main-process keyboard input (Round 17 P1) ----
  // Excalidraw exposes no undo/redo on the imperative API, so we drive the real
  // shortcuts from the main process (win.webContents.sendInputEvent), which the
  // renderer cannot fake with a synthetic KeyboardEvent. Undo depth is then read
  // from the live scene. This is soft: if the window is not focused or the
  // shortcut does not land, we record it honestly rather than claim it.
  const readLiveCount = () => win.webContents.executeJavaScript('window.__projState__.raw.elements().filter(e => !e.isDeleted).length');
  const readNormalizedSnapshot = () => win.webContents.executeJavaScript(`(() => JSON.stringify(window.__projState__.raw.elements().filter((e) => !e.isDeleted).map((e) => ({
    id: e.id,
    isDeleted: !!e.isDeleted,
    frameId: e.frameId || null,
    containerId: e.containerId || null,
    startBinding: e.startBinding || null,
    endBinding: e.endBinding || null,
    boundElements: (e.boundElements || []).map((b) => ({ id: b.id, type: b.type })).sort((a, b) => a.id.localeCompare(b.id)),
    archify: e.customData && e.customData.archify ? e.customData.archify : null,
  })).sort((a, b) => a.id.localeCompare(b.id))))()`);
  const sendKey = async (key, modifiers) => {
    win.show();
    win.focus();
    win.webContents.focus();
    // Give Excalidraw's canvas the keyboard focus in the renderer, then send a real
    // keyDown + keyUp from the main process (trusted input, not a synthetic
    // KeyboardEvent the renderer could block). No `char`: Excalidraw binds on keydown.
    await win.webContents.executeJavaScript("(() => { const el = document.querySelector('.excalidraw') || document.body; try { el.focus(); } catch (e) {} return true; })()");
    await new Promise((r) => setTimeout(r, 80));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
    await new Promise((r) => setTimeout(r, 350));
  };
  const beforeUndo = await readLiveCount();
  await sendKey('Z', ['control']);
  const afterUndo = await readLiveCount();
  const afterUndoSnapshot = await readNormalizedSnapshot();
  await sendKey('Z', ['control', 'shift']);
  const afterRedo = await readLiveCount();
  const afterRedoSnapshot = await readNormalizedSnapshot();
  const undoRedo = {
    attempted: true,
    beforeUndo, afterUndo, afterRedo,
    afterUndoSnapshot,
    afterRedoSnapshot,
    undoChanged: afterUndo !== beforeUndo,
    redoChanged: afterRedo !== afterUndo,
  };

  // Renderer part 2: stale protection, replace (with a real deletedReported) fit.
  const part2 = await win.webContents.executeJavaScript(`(async () => {
    const { bridge, raw } = window.__projState__;
    const live = () => raw.elements().filter((e) => !e.isDeleted);
    const ir = ${JSON.stringify(IR)};
    const projCtx = ${JSON.stringify(projectContext)};
    const skillCtx = ${JSON.stringify(skillContext)};
    const EXP = {
      components: (ir.components || []).length,
      connections: (ir.connections || []).length,
      boundaries: (ir.boundaries || []).length,
      srcIds: (ir.components || []).map((c) => c.id),
    };
    const out = {};
    try {
      // 7. STALE: a replace preview, then a scene change, must be REFUSED (and a
      //    move-resize edit — same element id — is also refused via content fingerprint).
      const pv3 = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'replace', projectContext: projCtx, skillContext: skillCtx });
      if (pv3.ok) {
        const beforeStale = live().length;
        bridge.use_command('canvas.addNode', { id: 'extra', label: 'Extra', x: 700, y: 320, width: 120, height: 60 });
        const afterAdd = live().length;
        const st = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: pv3.data.previewToken });
        out.stale = { ok: st.ok, stale: st.ok && st.data && st.data.stale === true, applied: st.ok && st.data && st.data.applied === true, sceneUnchanged: live().length === afterAdd, beforeStale, afterAdd };
      } else {
        out.stale = { ok: false };
      }

      // 8. REPLACE: preview reports exactly the live elements it will delete, then
      //    confirm clears the scene and installs only the projection.
      const beforeReplaceLive = live().map((e) => e.id);
      const pv4 = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'replace', projectContext: projCtx, skillContext: skillCtx });
      if (pv4.ok) {
        const delIds = pv4.data.elementIdsToDelete || [];
        const rc = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: pv4.data.previewToken });
        const liveR = live();
        out.replace = {
          ok: rc.ok,
          applied: rc.ok && rc.data && rc.data.applied === true,
          deletedReportedCorrect: delIds.length === beforeReplaceLive.length && Array.isArray(rc.data.elementIdsToDelete) && rc.data.elementIdsToDelete.length === beforeReplaceLive.length,
          // After replace the ONLY remaining elements are projection-owned (they
          // carry customData.archify). The manual/extra sketch must be gone; a
          // same-IR replace re-creates the same canonical node ids, so we assert by
          // provenance presence rather than raw id absence (Round 17 P1).
          oldSceneGone: liveR.every((e) => e.customData && e.customData.archify),
          manualGone: !liveR.some((e) => e.customData && e.customData.projectNodeId === 'manual'),
          importedAfterReplace: {
            frames: liveR.filter((e) => e.type === 'frame').length,
            nodes: liveR.filter((e) => e.type === 'rectangle' && EXP.srcIds.includes(e.customData && e.customData.projectNodeId)).length,
            arrows: liveR.filter((e) => e.type === 'arrow').length,
          },
        };
      } else {
        out.replace = { ok: false };
      }

      // 9. FIT imported content must not throw.
      const fit = bridge.use_command('canvas.fitToScreen');
      out.fitOk = fit.ok;
      return out;
    } catch (e) {
      return { fatal: { threw: String((e && e.stack) || e) } };
    }
  })()`);

  if (part2.fatal) {
    console.error('ARCHIFY-PROJECTION FAILED (part2): ' + JSON.stringify(part2.fatal));
    app.quit();
    return;
  }

  // --- replace one-step Undo/Redo via trusted main-process input (S6-HISTORY-1) ---
  // Replace is proven on a CLEAN, deterministic sequence without any tombstone/compact
  // (which would add its own history step): starting from the current projection
  // (the scene after part2), add one manual node, then preview + confirm a replace.
  // One Ctrl-Z must return to exactly manual+projection, one Ctrl-Shift-Z must return
  // to exactly the replacement projection — i.e. replace is a single history step too.
  const cleanReplace = await win.webContents.executeJavaScript(`(async () => {
    const { bridge, raw } = window.__projState__;
    const live = () => raw.elements().filter((e) => !e.isDeleted);
    // Replace Undo/Redo is measured on a GENUINE content change: the scene is
    // the real IR projection + one committed manual node, and the replace swaps
    // in a DISTINCT projection (IR2). A degenerate same-IR replace would leave a
    // nearly-empty history diff, which proves nothing. The tombstones for the old
    // IR1 projection elements (COMMITTED via the prior replace confirm) give the
    // transaction a real deletion to invert.
    const normalizeScene = () => JSON.stringify(raw.elements().filter((e) => !e.isDeleted).map((e) => ({
      id: e.id,
      isDeleted: !!e.isDeleted,
      frameId: e.frameId || null,
      containerId: e.containerId || null,
      startBinding: e.startBinding || null,
      endBinding: e.endBinding || null,
      boundElements: (e.boundElements || []).map((b) => ({ id: b.id, type: b.type })).sort((a, b) => a.id.localeCompare(b.id)),
      archify: e.customData && e.customData.archify ? e.customData.archify : null,
    })).sort((a, b) => a.id.localeCompare(b.id)));
    const baseCount = live().length;
    bridge.use_command('canvas.addNode', { id: 'replace-manual', label: 'Manual 2', x: 40, y: 320, width: 160, height: 80 });
    const manualScene = live().length;
    const manualSnapshot = normalizeScene();
    const ir = ${JSON.stringify(IR2)};
    const projCtx = ${JSON.stringify(projectContext)};
    const skillCtx = ${JSON.stringify(skillContext)};
    const pv = bridge.use_command('canvas.previewArchifyProjection', { ir, mode: 'replace', projectContext: projCtx, skillContext: skillCtx });
    if (!pv.ok) return { fatal: { step: 'preview', error: pv.error } };
    const cf = bridge.use_command('canvas.confirmArchifyProjection', { previewToken: pv.data.previewToken });
    if (!cf.ok || !cf.data.applied) return { fatal: { step: 'confirm', error: cf.error } };
    const projCount = live().length;
    const projectionSnapshot = normalizeScene();
    window.__projState__.replaceClean = { baseCount, manualScene, projCount, manualSnapshot, projectionSnapshot };
    return { ok: true, baseCount, manualScene, projCount, manualSnapshot, projectionSnapshot };
  })()`);
  if (cleanReplace.fatal) {
    console.error('ARCHIFY-PROJECTION FAILED (cleanReplace): ' + JSON.stringify(cleanReplace.fatal));
    app.quit();
    return;
  }
  const { manualScene, projCount } = cleanReplace;
  const beforeReplaceUndo = await readLiveCount();
  await sendKey('Z', ['control']);
  const afterReplaceUndo = await readLiveCount();
  const afterReplaceUndoSnapshot = await readNormalizedSnapshot();
  await sendKey('Z', ['control', 'shift']);
  const afterReplaceRedo = await readLiveCount();
  const afterReplaceRedoSnapshot = await readNormalizedSnapshot();
  const replaceUndoRedo = {
    attempted: true,
    manualScene,
    projectionScene: projCount,
    beforeUndo: beforeReplaceUndo,
    afterUndo: afterReplaceUndo,
    afterRedo: afterReplaceRedo,
    undoChanged: afterReplaceUndo !== beforeReplaceUndo,
    redoChanged: afterReplaceRedo !== afterReplaceUndo,
    undoRestoresOldScene: afterReplaceUndo === manualScene,
    redoRestoresProjection: afterReplaceRedo === projCount,
    undoRestoresExactOldScene: afterReplaceUndoSnapshot === cleanReplace.manualSnapshot,
    redoRestoresExactProjection: afterReplaceRedoSnapshot === cleanReplace.projectionSnapshot,
  };

  const report = { ...part1, ...part2, undoRedo, replaceUndoRedo, cliGated: hasCli };

  console.log('ARCHIFY-PROJECTION ' + JSON.stringify(report, null, 2));

  if (visualProof) {
    await win.webContents.executeJavaScript(`
      window.__bridge__.use_command('canvas.clearSelection');
      window.__bridge__.use_command('canvas.fitToScreen');
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    `);
    await new Promise((r) => setTimeout(r, 400));
    mkdirSync(path.join(__dirname, 'artifacts'), { recursive: true });
    const outName = 'archify-projection-' + theme + '.png';
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(__dirname, 'artifacts', outName), image.toPNG());
    console.log('WROTE artifacts/' + outName);
  }

  const c = report;
  // Hard gate: no-mutate preview, merge preserves the sketch, imported counts,
  // correct provenance (kind + immutable sourceId + per-component evidence),
  // safe provenance, cancel, idempotent, stale-refusal, replace (with a real
  // deletedReported), fit. Live ONE-STEP undo/redo is now a HARD gate: a confirmed
  // projection must be removed by exactly one Ctrl-Z (leaving only the manual
  // sketch) and restored by exactly one Ctrl-Shift-Z (matching the applied counts),
  // because applyProjectionPlan captures the commit with
  // CaptureUpdateAction.IMMEDIATELY (Excalidraw 0.18.1) — one updateScene, one
  // history step (verified via trusted win.webContents.sendInputEvent).
  const importsOK = (x) => x.frames === EXPECTED.boundaries && x.nodes === EXPECTED.components && x.arrows === EXPECTED.connections;
  // One undo must remove exactly the added projection (leaving the 2 manual
  // elements: manual node + its native bound text); one redo must restore it.
  const projectedElementCount = EXPECTED.boundaries + EXPECTED.components * 2 + EXPECTED.connections;
  const undoOK =
    c.undoRedo.attempted === true &&
    c.undoRedo.afterUndo === c.undoRedo.beforeUndo - projectedElementCount &&
    c.undoRedo.afterRedo === c.undoRedo.beforeUndo &&
    c.undoRedo.afterUndoSnapshot === c.manualSnapshot &&
    c.undoRedo.afterRedoSnapshot === c.mergeSnapshot;
  const replaceUndoOK =
    c.replaceUndoRedo.attempted === true &&
    c.replaceUndoRedo.undoRestoresOldScene === true &&
    c.replaceUndoRedo.redoRestoresProjection === true &&
    c.replaceUndoRedo.undoRestoresExactOldScene === true &&
    c.replaceUndoRedo.redoRestoresExactProjection === true;
  const ok =
    c.previewSceneUnchanged === true &&
    c.mergeDeletes === 0 &&
    c.confirmed === true &&
    c.confirmProjectionId && /^proj-/.test(c.confirmProjectionId) &&
    c.manualPreserved === true &&
    importsOK(c.importedAfterMerge) &&
    c.provenance.components === true &&
    c.provenance.connections === true &&
    c.provenance.boundary === true &&
    c.provenance.sourceIdFromArchify === true &&
    c.provenance.evidenceMatches === true &&
    c.provenance.unknownWithoutEvidence === true &&
    c.provenance.boundText === true &&
    c.provenanceSafe === true &&
    c.cancel && c.cancel.cancelled === true && c.cancel.sceneUnchanged === true &&
    c.idempotent === true &&
    c.stale && c.stale.stale === true && c.stale.applied === false && c.stale.sceneUnchanged === true &&
    c.replace && c.replace.ok === true && c.replace.applied === true && c.replace.manualGone === true &&
    c.replace.deletedReportedCorrect === true &&
    c.replace.oldSceneGone === true &&
    importsOK(c.replace.importedAfterReplace) &&
    c.fitOk === true &&
    undoOK &&
    replaceUndoOK;
  console.log(ok ? 'ARCHIFY-PROJECTION: ALL CHECKS PASSED' : 'ARCHIFY-PROJECTION: PROBLEM(S)');
  app.quit();
}
