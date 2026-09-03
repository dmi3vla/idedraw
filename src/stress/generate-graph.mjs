// Deterministic synthetic load generator for stress testing (plan stream D1).
//
// Builds N nodes on a non-overlapping grid plus M edges between grid
// neighbors (right/down, seeded random), so the graph is neither degenerate
// nor random-strewn: every run with the same seed produces the SAME graph,
// which is what makes bridge-vs-baseline comparisons meaningful.
//
// Pure data, no imports — usable from any layer.

function lcg(seed) {
  // 32-bit LCG; deterministic across runs, good enough for edge sampling.
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const NODE_W = 180;
const NODE_H = 90;
const GAP_X = 60;
const GAP_Y = 60;

/**
 * @param {object} opts
 * @param {number} opts.count        number of nodes
 * @param {number} [opts.seed=42]    PRNG seed — same seed => same graph
 * @param {string} [opts.idPrefix='']  prefix for node ids (used by leak-cycle
 *        runs so re-added nodes don't collide with deleted ones)
 * @param {boolean} [opts.withEdges=true]  skip edges for add/remove cycles
 */
export function generateGridGraph({ count, seed = 42, idPrefix = '', withEdges = true }) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`count must be a positive integer, got: ${count}`);
  }

  // Wide-ish grid (~16:9) so fit-to-screen shows realistic density.
  const cols = Math.ceil(Math.sqrt(count * 1.8));
  const rows = Math.ceil(count / cols);

  const nodes = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodes.push({
      id: `${idPrefix}n${i}`,
      label: `${idPrefix}n${i}`,
      x: 60 + col * (NODE_W + GAP_X),
      y: 60 + row * (NODE_H + GAP_Y),
    });
  }

  const edges = [];
  if (withEdges) {
    const rnd = lcg(seed);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= count) continue;
        // connect to right and down neighbor with ~0.4 probability each
        if (c + 1 < cols && i + 1 < count && rnd() < 0.4) {
          edges.push({ fromId: nodes[i].id, toId: nodes[i + 1].id });
        }
        const down = i + cols;
        if (r + 1 < rows && down < count && rnd() < 0.4) {
          edges.push({ fromId: nodes[i].id, toId: nodes[down].id });
        }
      }
    }
  }

  return { nodes, edges };
}
