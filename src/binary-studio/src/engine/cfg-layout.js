/**
 * Layered layout for a function's basic-block CFG.
 * Pure geometry — no DOM. Callers render SVG / canvas from the result.
 */

/**
 * @param {{ id: string, start: number, end: number, successors?: number[], instructions?: object[] }[]} blocks
 * @returns {{ nodes: object[], edges: object[], width: number, height: number }}
 */
export function layoutCfg(blocks, options = {}) {
  const nodeW = options.nodeWidth ?? 168;
  const nodeH = options.nodeHeight ?? 52;
  const gapX = options.gapX ?? 36;
  const gapY = options.gapY ?? 56;

  if (!blocks?.length) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const byStart = new Map(blocks.map((b) => [b.start, b]));

  const succ = new Map(blocks.map((b) => [b.id, []]));
  for (const b of blocks) {
    for (const s of b.successors || []) {
      const target = byStart.get(s);
      if (!target || target.id === b.id) continue;
      succ.get(b.id).push(target.id);
    }
  }

  const layerOf = new Map();
  const queue = [];
  const entry = blocks[0].id;
  layerOf.set(entry, 0);
  queue.push(entry);
  const seen = new Set([entry]);
  while (queue.length) {
    const id = queue.shift();
    const L = layerOf.get(id);
    for (const n of succ.get(id) || []) {
      if (!seen.has(n)) {
        seen.add(n);
        layerOf.set(n, L + 1);
        queue.push(n);
      } else if ((layerOf.get(n) ?? 0) < L + 1 && !isAncestor(n, id, succ)) {
        layerOf.set(n, L + 1);
        queue.push(n);
      }
    }
  }
  for (const b of blocks) {
    if (!layerOf.has(b.id)) layerOf.set(b.id, 0);
  }

  const layers = new Map();
  for (const b of blocks) {
    const L = layerOf.get(b.id);
    if (!layers.has(L)) layers.set(L, []);
    layers.get(L).push(b);
  }

  const nodes = [];
  let maxCols = 1;
  for (const [, row] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    maxCols = Math.max(maxCols, row.length);
    row.sort((a, b) => a.start - b.start);
    row.forEach((b, col) => {
      const x = 24 + col * (nodeW + gapX);
      const y = 24 + layerOf.get(b.id) * (nodeH + gapY);
      const last = b.instructions?.[b.instructions.length - 1];
      nodes.push({
        id: b.id,
        start: b.start,
        end: b.end,
        x,
        y,
        width: nodeW,
        height: nodeH,
        label: `bb_${b.start.toString(16)}`,
        insnCount: b.instructions?.length ?? 0,
        exitKind: exitKind(last),
      });
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const b of blocks) {
    const from = nodeById.get(b.id);
    if (!from) continue;
    for (const s of b.successors || []) {
      const target = byStart.get(s);
      const to = target && nodeById.get(target.id);
      if (!to) continue;
      edges.push({
        from: from.id,
        to: to.id,
        x1: from.x + from.width / 2,
        y1: from.y + from.height,
        x2: to.x + to.width / 2,
        y2: to.y,
      });
    }
  }

  const width = Math.max(200, 24 + maxCols * (nodeW + gapX));
  const maxLayer = Math.max(...layerOf.values(), 0);
  const height = 24 + (maxLayer + 1) * (nodeH + gapY);

  return { nodes, edges, width, height };
}

/**
 * Render an SVG string for a laid-out CFG.
 */
export function cfgToSvg(layout, { selectedStart = null } = {}) {
  const { nodes, edges, width, height } = layout;
  if (!nodes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="48" role="img" aria-label="Empty CFG"></svg>`;
  }
  const edgePaths = edges
    .map((e) => {
      const midY = (e.y1 + e.y2) / 2;
      return `<path d="M${e.x1} ${e.y1} C${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}" fill="none" stroke="#5a6554" stroke-width="1.5" marker-end="url(#cfg-arrow)" />`;
    })
    .join('');
  const nodeRects = nodes
    .map((n) => {
      const sel = selectedStart != null && n.start === selectedStart;
      const fill = sel ? '#d6e8c8' : '#ffffff';
      const stroke = sel ? '#2f5d3a' : '#cfc8b6';
      return `<g class="cfg-node" data-start="${n.start}" style="cursor:pointer">
        <rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />
        <text x="${n.x + 10}" y="${n.y + 20}" font-family="IBM Plex Mono, Consolas, monospace" font-size="11" fill="#1a2218">${escapeXml(n.label)}</text>
        <text x="${n.x + 10}" y="${n.y + 38}" font-family="Source Sans 3, Segoe UI, sans-serif" font-size="10" fill="#5a6554">${n.insnCount} insn · ${escapeXml(n.exitKind)}</text>
      </g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Control-flow graph">
    <defs>
      <marker id="cfg-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#5a6554" />
      </marker>
    </defs>
    ${edgePaths}
    ${nodeRects}
  </svg>`;
}

function exitKind(last) {
  if (!last) return 'empty';
  if (last.isRet) return 'ret';
  if (last.isJump && last.isConditional) return 'jcc';
  if (last.isJump) return 'jmp';
  if (last.isCall) return 'call+fall';
  return 'fall';
}

function isAncestor(maybeAncestor, node, succ) {
  const stack = [...(succ.get(maybeAncestor) || [])];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (n === node) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(succ.get(n) || []));
  }
  return false;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
