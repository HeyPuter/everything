/**
 * Minimal SOP-style DAG evaluator (original).
 * Houdini-inspired node graph — not SideFX Houdini.
 */

/** @typedef {{ x:number,y:number,z:number }} Point */
/** @typedef {{ id:string, type:string, params: Record<string, number>, inputs: string[] }} Node */
/** @typedef {{ nodes: Node[], outputId: string }} Graph */

/** @returns {Point[]} */
export function opGrid(params) {
  const n = Math.max(1, Math.floor(params.n || 4));
  const size = params.size || 1;
  /** @type {Point[]} */
  const pts = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      pts.push({
        x: (x / (n - 1 || 1) - 0.5) * size,
        y: 0,
        z: (y / (n - 1 || 1) - 0.5) * size,
      });
    }
  }
  return pts;
}

/** @param {Point[]} pts */
export function opNoise(pts, params) {
  const amp = params.amp ?? 0.2;
  const freq = params.freq ?? 3;
  return pts.map((p) => ({
    x: p.x,
    y: p.y + Math.sin(p.x * freq + p.z * freq) * amp,
    z: p.z,
  }));
}

/** @param {Point[]} pts */
export function opTransform(pts, params) {
  const tx = params.tx || 0;
  const ty = params.ty || 0;
  const tz = params.tz || 0;
  const s = params.s ?? 1;
  return pts.map((p) => ({ x: p.x * s + tx, y: p.y * s + ty, z: p.z * s + tz }));
}

/**
 * @param {Graph} graph
 * @returns {Point[]}
 */
export function evaluate(graph) {
  /** @type {Map<string, Point[]>} */
  const cache = new Map();

  /** @param {string} id */
  function evalNode(id) {
    if (cache.has(id)) return cache.get(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`Unknown node ${id}`);
    let pts = [];
    if (node.type === 'grid') pts = opGrid(node.params);
    else if (node.type === 'noise') {
      const input = node.inputs[0] ? evalNode(node.inputs[0]) : [];
      pts = opNoise(input, node.params);
    } else if (node.type === 'transform') {
      const input = node.inputs[0] ? evalNode(node.inputs[0]) : [];
      pts = opTransform(input, node.params);
    } else if (node.type === 'output') {
      pts = node.inputs[0] ? evalNode(node.inputs[0]) : [];
    } else {
      throw new Error(`Unknown type ${node.type}`);
    }
    cache.set(id, pts);
    return pts;
  }

  return evalNode(graph.outputId);
}

/** @returns {Graph} */
export function defaultGraph() {
  return {
    nodes: [
      { id: 'grid1', type: 'grid', params: { n: 8, size: 2 }, inputs: [] },
      { id: 'noise1', type: 'noise', params: { amp: 0.25, freq: 4 }, inputs: ['grid1'] },
      { id: 'xform1', type: 'transform', params: { ty: 0.1, s: 1 }, inputs: ['noise1'] },
      { id: 'out', type: 'output', params: {}, inputs: ['xform1'] },
    ],
    outputId: 'out',
  };
}
