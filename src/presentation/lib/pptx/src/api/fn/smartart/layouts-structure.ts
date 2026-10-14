// SmartArt layouts: hierarchies, relationships, matrices, pyramids and
// picture layouts.
import type { SmartArtNode } from "./model.ts";
import { smartArtDepth } from "./model.ts";
import {
  type ArtShape,
  type LayoutFn,
  cells,
  gridFor,
  nodeParas,
} from "./kit.ts";
import { polygon, polyline, shape } from "./layouts-flow.ts";

const textOf = (node: SmartArtNode, withChildren = true) => ({
  paras: nodeParas(node, withChildren),
  item: node.item,
});

// ---------------------------------------------------------------- Trees

interface Placed {
  node: SmartArtNode;
  depth: number;
  /** Center along the breadth axis, in leaf units. */
  at: number;
  /** Leaf span. */
  from: number;
  to: number;
  children: Placed[];
}
const placeForest = (nodes: ReadonlyArray<SmartArtNode>) => {
  let leaf = 0;
  const place = (node: SmartArtNode, depth: number): Placed => {
    if (!node.children.length) {
      const at = leaf + 0.5;
      leaf++;
      return { node, depth, at, from: at - 0.5, to: at + 0.5, children: [] };
    }
    const children = node.children.map((c) => place(c, depth + 1));
    const from = children[0]!.from,
      to = children[children.length - 1]!.to;
    return {
      node,
      depth,
      at: (children[0]!.at + children[children.length - 1]!.at) / 2,
      from,
      to,
      children,
    };
  };
  const roots = nodes.map((n) => place(n, 0));
  return { roots, leaves: leaf, depth: smartArtDepth(nodes) };
};
const walk = (
  list: Placed[],
  fn: (p: Placed, parent: Placed | null) => void,
  parent: Placed | null = null,
) => {
  for (const p of list) {
    fn(p, parent);
    walk(p.children, fn, p);
  }
};

const tree =
  (opts: { horizontal?: boolean; round?: boolean }): LayoutFn =>
  ({ w, h, nodes }) => {
    if (!nodes.length) return [];
    const { roots, leaves, depth } = placeForest(nodes);
    const breadth = opts.horizontal ? h : w,
      length = opts.horizontal ? w : h;
    const unit = breadth / leaves;
    const level = cells(length, depth, opts.horizontal ? 0.35 : 0.5);
    let across = Math.min(
      unit * 0.86,
      opts.round ? level.cell : level.cell * 2.2,
    );
    let along = opts.round ? across : Math.min(level.cell, across * 0.75);
    if (opts.horizontal && !opts.round) {
      along = level.cell;
      across = Math.min(unit * 0.86, along * 0.6);
    }
    const rect = (p: Placed) => {
      const c = p.at * unit;
      const start = level.at(p.depth) + (level.cell - along) / 2;
      return opts.horizontal
        ? { x: start, y: c - across / 2, w: along, h: across }
        : { x: c - across / 2, y: start, w: across, h: along };
    };
    const out: ArtShape[] = [];
    walk(roots, (p, parent) => {
      if (!parent) return;
      const a = rect(parent),
        b = rect(p);
      if (opts.round) {
        out.push(
          polyline(
            [
              [a.x + a.w / 2, a.y + a.h / 2],
              [b.x + b.w / 2, b.y + b.h / 2],
            ],
            "line",
            p.depth,
            depth,
          ),
        );
      } else if (opts.horizontal) {
        const x0 = a.x + a.w,
          x1 = b.x,
          mid = (x0 + x1) / 2;
        out.push(
          polyline(
            [
              [x0, a.y + a.h / 2],
              [mid, a.y + a.h / 2],
              [mid, b.y + b.h / 2],
              [x1, b.y + b.h / 2],
            ],
            "line",
            p.depth,
            depth,
          ),
        );
      } else {
        const y0 = a.y + a.h,
          y1 = b.y,
          mid = (y0 + y1) / 2;
        out.push(
          polyline(
            [
              [a.x + a.w / 2, y0],
              [a.x + a.w / 2, mid],
              [b.x + b.w / 2, mid],
              [b.x + b.w / 2, y1],
            ],
            "line",
            p.depth,
            depth,
          ),
        );
      }
    });
    walk(roots, (p) =>
      out.push(
        shape(
          opts.round ? "ellipse" : "rect",
          rect(p),
          p.depth ? "node" : "hub",
          p.depth,
          depth,
          {
            ...textOf(p.node, false),
            group: "tree",
          },
        ),
      ),
    );
    return out;
  };

const layeredBlocks: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const { roots, leaves, depth } = placeForest(nodes);
  const unit = w / leaves,
    rowH = h / depth;
  const out: ArtShape[] = [];
  walk(roots, (p) => {
    const rows = p.children.length ? 1 : depth - p.depth;
    out.push(
      shape(
        "rect",
        {
          x: p.from * unit,
          y: p.depth * rowH,
          w: (p.to - p.from) * unit,
          h: rows * rowH,
        },
        p.depth ? "node" : "hub",
        p.depth,
        depth,
        { ...textOf(p.node, false), group: "tree" },
      ),
    );
  });
  return out;
};

// ---------------------------------------------------------------- Relationships

const venn: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const m = Math.min(w, h);
  if (n === 1)
    return [
      shape(
        "ellipse",
        { x: (w - m) / 2, y: (h - m) / 2, w: m, h: m },
        "venn",
        0,
        1,
        textOf(nodes[0]!),
      ),
    ];
  const k = 0.31 / Math.sin(Math.PI / n);
  const d = m / (1 + 2 * k);
  const r = d * k;
  return nodes.map((node, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    const cx = w / 2 + r * Math.cos(a),
      cy = h / 2 + r * Math.sin(a);
    const tx = cx + d * 0.17 * Math.cos(a),
      ty = cy + d * 0.17 * Math.sin(a);
    return shape(
      "ellipse",
      { x: cx - d / 2, y: cy - d / 2, w: d, h: d },
      "venn",
      i,
      n,
      {
        ...textOf(node),
        textBox: { x: tx - d * 0.3, y: ty - d * 0.22, w: d * 0.6, h: d * 0.44 },
      },
    );
  });
};

const linkedCircles: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const d = Math.min(h, w / (n - (n - 1) * 0.22));
  const total = d * (n - (n - 1) * 0.22);
  return nodes.map((node, i) =>
    shape(
      "ellipse",
      { x: (w - total) / 2 + i * d * 0.78, y: (h - d) / 2, w: d, h: d },
      "venn",
      i,
      n,
      {
        ...textOf(node),
        textBox: {
          x: (w - total) / 2 + i * d * 0.78 + d * 0.16,
          y: (h - d) / 2 + d * 0.2,
          w: d * 0.68,
          h: d * 0.6,
        },
      },
    ),
  );
};

const nestedCircles: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const m = Math.min(w, h);
  const step = m / n;
  const bottom = (h + m) / 2;
  return nodes.map((node, i) => {
    const d = m - i * step * 0.85;
    const top = bottom - d;
    const nextTop = i < n - 1 ? bottom - (m - (i + 1) * step * 0.85) : bottom;
    const band = i < n - 1 ? nextTop - top : d;
    return shape(
      "ellipse",
      { x: w / 2 - d / 2, y: top, w: d, h: d },
      "venn",
      i,
      n,
      {
        ...textOf(node),
        textBox:
          i < n - 1
            ? {
                x: w / 2 - d * 0.32,
                y: top + band * 0.08,
                w: d * 0.64,
                h: band * 0.84,
              }
            : {
                x: w / 2 - d * 0.36,
                y: top + d * 0.2,
                w: d * 0.72,
                h: d * 0.6,
              },
      },
    );
  });
};

const target: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const D = Math.min(h, w * 0.45);
  const cx = D / 2,
    cy = h / 2;
  const out: ArtShape[] = [];
  nodes.forEach((_, i) => {
    const d = D * (1 - i / n);
    out.push(
      shape(
        "ellipse",
        { x: cx - d / 2, y: cy - d / 2, w: d, h: d },
        "node",
        i,
        n,
      ),
    );
  });
  const textX = D * 1.12;
  const rowH = h / n;
  nodes.forEach((node, i) => {
    const y = i * rowH + rowH / 2;
    const ringY = cy - (D * (1 - i / n)) / 2 + (D / n) * 0.25;
    out.push(
      polyline(
        [
          [cx, Math.min(ringY, cy)],
          [D * 0.9, Math.min(ringY, cy)],
          [D * 1.05, y],
          [textX, y],
        ],
        "line",
        i,
        n,
      ),
    );
    out.push(
      shape(
        "rect",
        { x: textX, y: i * rowH, w: w - textX, h: rowH },
        "text",
        i,
        n,
        {
          ...textOf(node),
          align: "l",
        },
      ),
    );
  });
  return out;
};

const counterArrows: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(h, n, 0.1);
  return nodes.map((node, i) =>
    shape(
      i % 2 ? "leftArrow" : "rightArrow",
      { x: i % 2 ? w * 0.12 : 0, y: at(i), w: w * 0.88, h: cell },
      "node",
      i,
      n,
      {
        ...textOf(node),
        adj: {
          adj1: 70000,
          adj2: Math.min(80000, (50000 * (w * 0.88)) / cell / 3),
        },
      },
    ),
  );
};

const convergingArrows: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const hub = nodes[0]!;
  const rest = nodes.slice(1);
  const d = Math.min(h * 0.7, w * 0.28);
  const out: ArtShape[] = [];
  const left = rest.filter((_, i) => i % 2 === 0),
    right = rest.filter((_, i) => i % 2 === 1);
  const side = (list: SmartArtNode[], onLeft: boolean) => {
    if (!list.length) return;
    const slot = cells(h, list.length, 0.12);
    list.forEach((node, j) => {
      const i = rest.indexOf(node);
      const aw = (w - d) / 2 - w * 0.02;
      out.push(
        shape(
          onLeft ? "rightArrow" : "leftArrow",
          { x: onLeft ? 0 : w - aw, y: slot.at(j), w: aw, h: slot.cell },
          "node",
          i,
          rest.length,
          {
            ...textOf(node),
            adj: { adj1: 70000, adj2: 45000 },
            group: "arrow",
          },
        ),
      );
    });
  };
  side(left, true);
  side(right, false);
  out.push(
    shape(
      "ellipse",
      { x: (w - d) / 2, y: (h - d) / 2, w: d, h: d },
      "hub",
      0,
      1,
      {
        ...textOf(hub),
      },
    ),
  );
  return out;
};

const equation: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const d = Math.min(h, w / (n + (n - 1) * 0.6));
  const op = d * 0.6;
  const total = n * d + (n - 1) * op;
  let x = (w - total) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const last = i === n - 1 && n > 1;
    out.push(
      shape(
        "ellipse",
        { x, y: (h - d) / 2, w: d, h: d },
        last ? "hub" : "node",
        i,
        n,
        {
          ...textOf(node),
          group: "term",
        },
      ),
    );
    x += d;
    if (i < n - 1) {
      const s = op * 0.8;
      out.push(
        shape(
          i === n - 2 ? "mathEqual" : "mathPlus",
          { x: x + op * 0.1, y: h / 2 - s / 2, w: s, h: s },
          "trans",
          i,
          n,
        ),
      );
      x += op;
    }
  });
  return out;
};

// ---------------------------------------------------------------- Matrices

const quadrants: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const cols = n === 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const size = Math.min(w / cols, h / rows) * 0.98;
  const gap = size * 0.04;
  const cw = size - gap,
    left = (w - cols * size) / 2,
    top = (h - rows * size) / 2;
  return nodes.map((node, i) =>
    shape(
      "roundRect",
      {
        x: left + (i % cols) * size,
        y: top + Math.floor(i / cols) * size,
        w: cw,
        h: cw,
      },
      "node",
      i,
      n,
      { ...textOf(node), adj: { adj: 8000 } },
    ),
  );
};

const centeredQuadrants: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const single = nodes.length === 1;
  const hub = nodes[0]!;
  const quads = single ? hub.children : nodes.slice(1);
  const n = quads.length;
  const m = Math.min(w, h);
  const x0 = (w - m) / 2,
    y0 = (h - m) / 2;
  const out: ArtShape[] = [];
  const rows = Math.max(1, Math.ceil(n / 2));
  const cellH = m / rows,
    gap = m * 0.02;
  quads.forEach((node, i) => {
    const col = i % 2,
      row = Math.floor(i / 2);
    const cw = (n === 1 ? m : m / 2) - gap;
    const x = x0 + col * (m / 2) + gap / 2,
      y = y0 + row * cellH + gap / 2;
    const ch = cellH - gap;
    out.push(
      shape("rect", { x, y, w: cw, h: ch }, "node", i, n, {
        ...textOf(node),
        textBox: {
          x: col ? x + cw * 0.3 : x,
          y: row === 0 ? y : y + ch * 0.3,
          w: cw * 0.7,
          h: ch * 0.7,
        },
        align: col ? "r" : "l",
        anchor: row === 0 && rows > 1 ? "t" : "b",
        group: "quad",
      }),
    );
  });
  const hd = m * (n ? 0.4 : 0.8);
  out.push(
    shape(
      "roundRect",
      { x: w / 2 - hd / 2, y: h / 2 - hd * 0.35, w: hd, h: hd * 0.7 },
      "hub",
      0,
      1,
      {
        ...textOf(hub, !single),
        adj: { adj: 20000 },
      },
    ),
  );
  return out;
};

const headerGrid: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.04);
  const maxKids = Math.max(1, ...nodes.map((x) => x.children.length));
  const headH = (h / (maxKids + 1.4)) * 1.2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("rect", { x: at(i), y: 0, w: cell, h: headH }, "hub", i, n, {
        ...textOf(node, false),
        group: "head",
      }),
    );
    const slot = cells(h - headH * 1.08, Math.max(1, maxKids), 0.05);
    node.children.forEach((kid, j) =>
      out.push(
        shape(
          "rect",
          { x: at(i), y: headH * 1.08 + slot.at(j), w: cell, h: slot.cell },
          "child",
          i,
          n,
          {
            ...textOf(kid),
            group: "cell",
          },
        ),
      ),
    );
  });
  return out;
};

const petals: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const cols = n === 1 ? 1 : 2,
    rows = Math.ceil(n / cols);
  const size = Math.min(w / cols, h / rows);
  const gap = size * 0.05;
  const left = (w - cols * size) / 2,
    top = (h - rows * size) / 2;
  return nodes.map((node, i) => {
    const col = i % cols,
      row = Math.floor(i / cols);
    return shape(
      "round2DiagRect",
      {
        x: left + col * size + gap / 2,
        y: top + row * size + gap / 2,
        w: size - gap,
        h: size - gap,
      },
      "node",
      i,
      n,
      {
        ...textOf(node),
        adj: { adj1: 45000, adj2: 0 },
        ...((col + row) % 2 ? { flipH: true } : {}),
      },
    );
  });
};

// ---------------------------------------------------------------- Pyramids

const pyramidBands = (
  w: number,
  h: number,
  n: number,
  inverted: boolean,
  base: number,
  left: number,
) => {
  const gap = h * 0.015;
  const band = (h - gap * (n - 1)) / n;
  const halfAt = (y: number) => {
    const t = inverted ? 1 - y / h : y / h;
    return (base / 2) * t;
  };
  const cx = left + base / 2;
  return Array.from({ length: n }, (_, i) => {
    const y0 = i * (band + gap),
      y1 = y0 + band;
    const a = halfAt(y0),
      b = halfAt(y1);
    const pts: [number, number][] = [
      [cx - a, y0],
      [cx + a, y0],
      [cx + b, y1],
      [cx - b, y1],
    ];
    const narrow = Math.min(a, b),
      wide = Math.max(a, b);
    return {
      pts,
      text: {
        x: cx - ((narrow + wide) / 2) * 0.85,
        y: y0 + (inverted ? 0 : i === 0 ? band * 0.35 : 0),
        w: (narrow + wide) * 0.85,
        h: inverted
          ? i === n - 1
            ? band * 0.65
            : band
          : i === 0
            ? band * 0.65
            : band,
      },
      y0,
      y1,
    };
  });
};

const pyramid =
  (inverted: boolean): LayoutFn =>
  ({ w, h, nodes }) => {
    const n = nodes.length;
    if (!n) return [];
    const base = Math.min(w, h * 1.25);
    return pyramidBands(w, h, n, inverted, base, (w - base) / 2).map((b, i) =>
      polygon(b.pts, "node", i, n, { ...textOf(nodes[i]!), textBox: b.text }),
    );
  };

const pyramidLedger: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const base = Math.min(w * 0.6, h * 1.2);
  const out: ArtShape[] = [
    polygon(
      [
        [base / 2, 0],
        [base, h],
        [0, h],
      ],
      "bg",
      0,
      1,
    ),
  ];
  const { cell, at } = cells(h * 0.9, n, 0.15);
  nodes.forEach((node, i) => {
    const y = h * 0.1 + at(i);
    const x = base * 0.5 + (base / 2) * ((y + cell / 2) / h) * 0.2;
    out.push(
      shape("roundRect", { x, y, w: w - x, h: cell }, "node", i, n, {
        ...textOf(node),
        align: "l",
      }),
    );
  });
  return out;
};

const steppedPyramid: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(h, n, 0.04);
  return nodes.map((node, i) => {
    const bw = w * (0.35 + (0.65 * (i + 1)) / n);
    return shape(
      "rect",
      { x: (w - bw) / 2, y: at(i), w: bw, h: cell },
      "node",
      i,
      n,
      textOf(node),
    );
  });
};

// ---------------------------------------------------------------- Pictures

const captionedPictures: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.1);
  const picH = Math.min(h * 0.68, cell * 0.9);
  const top = (h - picH / 0.68) / 2 > 0 ? (h - picH / 0.68) / 2 : 0;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("rect", { x: at(i), y: top, w: cell, h: picH }, "pic", i, n, {
        item: node.item,
      }),
    );
    out.push(
      shape(
        "rect",
        { x: at(i), y: top + picH, w: cell, h: h - top - picH },
        "text",
        i,
        n,
        {
          ...textOf(node),
          anchor: "t",
        },
      ),
    );
  });
  return out;
};

const pictureTiles: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const grid = gridFor(n, w, h, 1.3);
  const cw = grid.size,
    ch = cw / 1.3,
    gap = cw * 0.1;
  const totalW = grid.cols * cw + (grid.cols - 1) * gap,
    totalH = grid.rows * ch + (grid.rows - 1) * gap;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const x = (w - totalW) / 2 + (i % grid.cols) * (cw + gap),
      y = (h - totalH) / 2 + Math.floor(i / grid.cols) * (ch + gap);
    out.push(
      shape("rect", { x, y, w: cw, h: ch }, "pic", i, n, { item: node.item }),
    );
    out.push(
      shape(
        "rect",
        { x, y: y + ch * 0.7, w: cw, h: ch * 0.3 },
        "node",
        i,
        n,
        textOf(node),
      ),
    );
  });
  return out;
};

const pictureBullets: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(h, n, 0.15);
  const d = Math.min(cell, w * 0.25);
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const y = at(i) + (cell - d) / 2;
    out.push(
      shape(
        "roundRect",
        { x: d * 0.5, y: at(i) + cell * 0.12, w: w - d * 0.5, h: cell * 0.76 },
        "node",
        i,
        n,
        {
          ...textOf(node),
          align: "l",
          textBox: {
            x: d * 1.15,
            y: at(i) + cell * 0.12,
            w: w - d * 1.15,
            h: cell * 0.76,
          },
        },
      ),
    );
    out.push(
      shape("ellipse", { x: 0, y, w: d, h: d }, "pic", i, n, {
        item: node.item,
      }),
    );
  });
  return out;
};

const portraitCircles: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.15);
  const d = Math.min(cell, h * 0.62);
  const top = (h - d / 0.62) / 2 > 0 ? (h - d / 0.62) / 2 : 0;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape(
        "ellipse",
        { x: at(i) + (cell - d) / 2, y: top, w: d, h: d },
        "pic",
        i,
        n,
        { item: node.item },
      ),
    );
    out.push(
      shape(
        "rect",
        {
          x: at(i) - cell * 0.07,
          y: top + d * 1.04,
          w: cell * 1.14,
          h: h - top - d * 1.04,
        },
        "text",
        i,
        n,
        {
          ...textOf(node),
          anchor: "t",
        },
      ),
    );
  });
  return out;
};

export const STRUCTURE_LAYOUTS: Record<string, LayoutFn> = {
  "org-chart": tree({}),
  "sideways-tree": tree({ horizontal: true }),
  "bubble-tree": tree({ round: true }),
  "layered-blocks": layeredBlocks,
  venn,
  "linked-circles": linkedCircles,
  "nested-circles": nestedCircles,
  target,
  "counter-arrows": counterArrows,
  "converging-arrows": convergingArrows,
  equation,
  quadrants,
  "centered-quadrants": centeredQuadrants,
  "header-grid": headerGrid,
  petals,
  pyramid: pyramid(false),
  "inverted-pyramid": pyramid(true),
  "pyramid-ledger": pyramidLedger,
  "stepped-pyramid": steppedPyramid,
  "captioned-pictures": captionedPictures,
  "picture-tiles": pictureTiles,
  "picture-bullets": pictureBullets,
  "portrait-circles": portraitCircles,
};
