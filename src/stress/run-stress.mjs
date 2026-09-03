// Renderer-side stress runner (plan stream D2/D3/D5).
//
// IMPORTANT: this module is bundled into renderer.bundle.js and invoked via
// window.__runStress__ / window.__runStressCycle__ (exposed by
// renderer-entry.jsx only when scenario=stress-test). It must live in the
// bundle — NOT be dynamically imported from source at runtime — so that it
// uses the SAME bridge/adapter module instances as the chat and the canvas
// (a fresh import would create a second, disconnected store instance, the
// same class of bug the theme refactor fixed).

import { bridge } from '../bridge/bridge.mjs';
import * as adapter from '../canvas/adapter.mjs';
import { generateGridGraph } from './generate-graph.mjs';

// Real agents would also batch node creation rather than issuing one command
// per node — this mirrors that (plan D1).
const BATCH = 20;
const FPS_WINDOW_MS = 3000;
const PAN_SPEED = 14; // px per frame

function nextFrames(n) {
  return new Promise((resolve) => {
    let left = n;
    const tick = () => (left-- <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Fill the scene with `count` nodes (+edges), then measure:
 *  - addNodesMs:  wall time of the bridge command calls themselves (D3),
 *                 measured separately from any rendering
 *  - avgFps:      frames per second during 3s of continuous programmatic
 *                 pan over the filled scene (D2)
 * @param {{count: number, mode: 'bridge'|'baseline'}} opts
 */
export async function runStress({ count, mode }) {
  const graph = generateGridGraph({ count });
  let nodesMs = 0;
  let edgesMs = 0;

  const t0 = performance.now();
  if (mode === 'baseline') {
    // D4 baseline: same graph shape, ONE direct updateScene, no bridge.
    adapter.addGraphRaw(graph);
  } else {
    for (let i = 0; i < graph.nodes.length; i += BATCH) {
      const batch = graph.nodes.slice(i, i + BATCH);
      const t = performance.now();
      const res = bridge.use_command('canvas.addNodes', { nodes: batch });
      nodesMs += performance.now() - t;
      if (!res.ok) throw new Error(`addNodes failed: ${res.error.code} ${res.error.message}`);
    }
    const te = performance.now();
    const res = bridge.use_command('canvas.addEdges', { edges: graph.edges });
    edgesMs += performance.now() - te;
    if (!res.ok) throw new Error(`addEdges failed: ${res.error.code} ${res.error.message}`);
  }
  const fillMs = performance.now() - t0;

  // Make sure Excalidraw has actually painted the new scene before we start
  // measuring frames — otherwise the first frames measure scene swap, not pan.
  adapter.fitToScreen();
  await nextFrames(10);

  const fps = await measureFpsWhilePanning();

  // Restore a "everything visible" view for the screenshot artifact.
  adapter.fitToScreen();
  await nextFrames(10);

  const elements = adapter.getScene().length;
  return {
    mode,
    count,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    addNodesMs: round1(nodesMs),
    addEdgesMs: round1(edgesMs),
    fillMs: round1(fillMs),
    elementsInScene: elements,
    ...fps,
  };
}

// D2: count requestAnimationFrame ticks over a fixed window while panning
// continuously (rotating direction every 750ms so the viewport stays inside
// the grid). FPS here is the real perceived smoothness of pan/zoom at scale.
function measureFpsWhilePanning() {
  return new Promise((resolve) => {
    let frames = 0;
    const start = performance.now();
    function tick(now) {
      frames++;
      const elapsed = now - start;
      if (elapsed >= FPS_WINDOW_MS) {
        resolve({
          avgFps: round1((frames / elapsed) * 1000),
          frames,
          fpsWindowMs: round1(elapsed),
        });
        return;
      }
      const phase = Math.floor(elapsed / 750) % 4;
      if (phase === 0) adapter.panBy(PAN_SPEED, 0);
      else if (phase === 1) adapter.panBy(0, PAN_SPEED);
      else if (phase === 2) adapter.panBy(-PAN_SPEED, 0);
      else adapter.panBy(0, -PAN_SPEED);
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

/**
 * D5 leak-cycle unit: add `count` nodes through the bridge, remove them all
 * through the bridge, report timings. RSS between cycles is sampled by the
 * main process (it owns app.getAppMetrics()), NOT here.
 * With compact=true an explicit canvas.compact runs after the removal
 * (note: removeNode(s) also auto-compact once tombstones exceed 30% of the
 * scene — with a full-cycle remove that always fires, making the explicit
 * call effectively a verified no-op on top of the automatic one).
 */
export async function runStressCycle({ count, cycle, batchSize = 50, compact = false }) {
  const graph = generateGridGraph({ count, idPrefix: `c${cycle}-`, withEdges: false });

  const t0 = performance.now();
  for (let i = 0; i < graph.nodes.length; i += batchSize) {
    const res = bridge.use_command('canvas.addNodes', { nodes: graph.nodes.slice(i, i + batchSize) });
    if (!res.ok) throw new Error(`addNodes failed: ${res.error.code} ${res.error.message}`);
  }
  const addMs = performance.now() - t0;

  const ids = graph.nodes.map((n) => n.id);
  const t1 = performance.now();
  const res = bridge.use_command('canvas.removeNodes', { ids });
  const removeMs = performance.now() - t1;
  if (!res.ok) throw new Error(`removeNodes failed: ${res.error.code} ${res.error.message}`);

  let compactMs = null;
  if (compact) {
    const t2 = performance.now();
    const cres = bridge.use_command('canvas.compact', {});
    compactMs = performance.now() - t2;
    if (!cres.ok) throw new Error(`compact failed: ${cres.error.code} ${cres.error.message}`);
  }

  await nextFrames(10);
  return { cycle, addMs: round1(addMs), removeMs: round1(removeMs), compactMs: compactMs === null ? null : round1(compactMs) };
}
