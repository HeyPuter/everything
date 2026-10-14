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
import { polygon, polyline, shape, spoke } from "./layouts-flow.ts";
import {
  PYRAMID_BASE,
  TARGET_TEXT_X,
  TREE,
  nestedCircle,
  quadrantCell,
  ringAngle,
  ringCenterShift,
  stepFraction,
  targetRing,
  vennSizes,
  vennTextBox,
} from "./geometry.ts";

const textOf = (node: SmartArtNode, withChildren = true) => ({
  paras: nodeParas(node, withChildren),
  item: node.item,
});

// ---------------------------------------------------------------- Trees

/**
 * A tree laid out as the hierarchy algorithms do: nodes of a fixed size
 * (fractions of the frame width), children side by side with a gap and
 * packed level by level against their elder siblings' subtrees, each parent
 * centered over its children, the whole scaled down if it overflows and
 * centered. `horizontal` grows the tree to the right.
 */
interface Laid {
  node: SmartArtNode;
  depth: number;
  /** Offset along the breadth axis, relative to the subtree's origin. */
  at: number;
  children: Laid[];
  /** Per depth below this node (0 = itself): [min, max] along the breadth. */
  contour: Array<[number, number]>;
}
const layTree = (
  node: SmartArtNode,
  depth: number,
  size: number,
  gap: number,
): Laid => {
  const children = node.children.map((c) => layTree(c, depth + 1, size, gap));
  // Place each child subtree as far left as its contour allows.
  const offsets: number[] = [];
  const merged: Array<[number, number]> = [];
  children.forEach((child, i) => {
    let off = 0;
    if (i) {
      off = -Infinity;
      child.contour.forEach(([lo], d) => {
        const right = merged[d]?.[1];
        if (right !== undefined) off = Math.max(off, right + gap - lo);
      });
      if (!Number.isFinite(off)) off = 0;
    }
    offsets.push(off);
    child.contour.forEach(([lo, hi], d) => {
      const cur = merged[d];
      merged[d] = cur
        ? [Math.min(cur[0], lo + off), Math.max(cur[1], hi + off)]
        : [lo + off, hi + off];
    });
  });
  // The parent sits centered over its children's row.
  let at = 0;
  if (children.length) {
    const first = offsets[0]! + children[0]!.at,
      last = offsets[children.length - 1]! + children[children.length - 1]!.at;
    at = (first + last) / 2;
  }
  children.forEach((c, i) => shift(c, offsets[i]!));
  return {
    node,
    depth,
    at,
    children,
    contour: [[at - size / 2, at + size / 2], ...merged],
  };
};
const shift = (t: Laid, by: number) => {
  t.at += by;
  t.contour = t.contour.map(([a, b]) => [a + by, b + by]);
  t.children.forEach((c) => shift(c, by));
};
const walkLaid = (
  list: Laid[],
  fn: (p: Laid, parent: Laid | null) => void,
  parent: Laid | null = null,
) => {
  for (const p of list) {
    fn(p, parent);
    walkLaid(p.children, fn, p);
  }
};

const tree =
  (opts: { horizontal?: boolean; round?: boolean }): LayoutFn =>
  ({ w, h, nodes }) => {
    if (!nodes.length) return [];
    const nodeW = (opts.round ? TREE.round : TREE.w) * w,
      nodeH = (opts.round ? TREE.round : TREE.h) * w;
    const sibling = TREE.sibling * w,
      level = TREE.level * w;
    const horizontal = !!opts.horizontal;
    // Breadth runs across the levels: x down a vertical tree.
    const across = horizontal ? nodeH : nodeW,
      along = horizontal ? nodeW : nodeH;
    const roots = layTree(
      { text: "", item: -1, children: [...nodes] },
      -1,
      across,
      sibling,
    ).children;
    const all: Laid[] = [];
    walkLaid(roots, (p) => all.push(p));
    const depth = smartArtDepth(nodes);
    const minB = Math.min(...all.map((p) => p.at - across / 2)),
      maxB = Math.max(...all.map((p) => p.at + across / 2));
    const spanB = maxB - minB,
      spanL = depth * along + (depth - 1) * level;
    const spanX = horizontal ? spanL : spanB,
      spanY = horizontal ? spanB : spanL;
    const k = Math.min(1, w / spanX, h / spanY);
    const ox = (w - spanX * k) / 2,
      oy = (h - spanY * k) / 2;
    const rect = (p: Laid) => {
      const b = (p.at - across / 2 - minB) * k,
        l = p.depth * (along + level) * k;
      return horizontal
        ? { x: ox + l, y: oy + b, w: along * k, h: across * k }
        : { x: ox + b, y: oy + l, w: across * k, h: along * k };
    };
    const out: ArtShape[] = [];
    walkLaid(roots, (p, parent) => {
      if (!parent) return;
      const a = rect(parent),
        b = rect(p);
      if (opts.round) {
        const line = spoke(
          { ...a, geom: "ellipse" } as ArtShape,
          { ...b, geom: "ellipse" } as ArtShape,
          p.depth,
          depth,
        );
        if (line) out.push(line);
      } else if (horizontal) {
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
    walkLaid(roots, (p) =>
      out.push(
        shape(
          opts.round ? "ellipse" : "rect",
          rect(p),
          p.depth ? "node" : "hub",
          p.depth,
          depth,
          { ...textOf(p.node, false), group: "tree" },
        ),
      ),
    );
    return out;
  };

/** Blocks in rows: each item spans its sub-items, which share its width
 *  equally; leaves reach the bottom row. */
const layeredBlocks: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const depth = smartArtDepth(nodes);
  const rowH = h / depth;
  const out: ArtShape[] = [];
  const place = (
    list: ReadonlyArray<SmartArtNode>,
    x: number,
    width: number,
    level: number,
  ) => {
    const cell = width / list.length;
    list.forEach((node, i) => {
      const left = x + i * cell;
      out.push(
        shape(
          "rect",
          {
            x: left,
            y: level * rowH,
            w: cell,
            h: node.children.length ? rowH : h - level * rowH,
          },
          level ? "node" : "hub",
          level,
          depth,
          { ...textOf(node, false), group: "tree" },
        ),
      );
      if (node.children.length) place(node.children, left, cell, level + 1);
    });
  };
  place(nodes, 0, w, 0);
  return out;
};

// ---------------------------------------------------------------- Relationships

const venn: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { d: df, diam } = vennSizes(n);
  const d = df * h,
    r = (diam / 2) * h;
  const cy = h / 2 + r * ringCenterShift(n);
  return nodes.map((node, i) => {
    const a = ringAngle(i, n);
    const cx = w / 2 + r * Math.cos(a),
      ccy = cy + r * Math.sin(a);
    const x = cx - d / 2,
      y = ccy - d / 2;
    const t = vennTextBox(i, n);
    return shape("ellipse", { x, y, w: d, h: d }, "venn", i, n, {
      ...textOf(node),
      textBox: { x: x + t.x * d, y: y + t.y * d, w: t.w * d, h: t.h * d },
    });
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
  return nodes.map((node, i) => {
    const c = nestedCircle(i, n);
    const d = c.d * h;
    const x = w / 2 - d / 2,
      y = h - d;
    return shape("ellipse", { x, y, w: d, h: d }, "venn", i, n, {
      ...textOf(node),
      textBox: {
        x: x + c.text.x * d,
        y: y + c.text.y * d,
        w: c.text.w * d,
        h: c.text.h * d,
      },
    });
  });
};

/** Concentric rings at the left; each ring's label on the right, level
 *  with the middle of the ring's top band and joined to it by a leader. */
const target: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const D = h,
    cx = D / 2,
    cy = h / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const t = targetRing(i, n);
    const d = t.d * D;
    out.push(
      shape(
        "ellipse",
        { x: cx - d / 2, y: cy - d / 2, w: d, h: d },
        "node",
        i,
        n,
      ),
    );
    const y = t.y * h,
      textX = TARGET_TEXT_X * h;
    out.push(
      polyline(
        [
          [cx, y],
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
        {
          x: textX,
          y: y - (t.labelH * h) / 2,
          w: Math.max(0, w - textX),
          h: t.labelH * h,
        },
        "text",
        i,
        n,
        { ...textOf(node), align: "l" },
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
        adj: { adj1: 70000, adj2: 60000 },
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
    // Equal slots down each side, each arrow centered in its slot.
    const slot = h / list.length,
      ah = slot / 1.12;
    list.forEach((node, j) => {
      const i = rest.indexOf(node);
      const aw = w * 0.34;
      out.push(
        shape(
          onLeft ? "rightArrow" : "leftArrow",
          {
            x: onLeft ? 0 : w - aw,
            y: slot * j + (slot - ah) / 2,
            w: aw,
            h: ah,
          },
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
  const m = h;
  const x0 = (w - m) / 2;
  const out: ArtShape[] = [];
  quads.forEach((node, i) => {
    const q = quadrantCell(i, n);
    const x = x0 + q.x * m,
      y = q.y * m,
      cw = q.w * m,
      ch = q.h * m;
    out.push(
      shape("rect", { x, y, w: cw, h: ch }, "node", i, n, {
        ...textOf(node),
        textBox: {
          x: x + q.text.x * cw,
          y: y + q.text.y * ch,
          w: q.text.w * cw,
          h: q.text.h * ch,
        },
        align: q.col ? "r" : "l",
        anchor: q.top ? "t" : "b",
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
  const headH = h * 0.3;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("rect", { x: at(i), y: 0, w: cell, h: headH }, "hub", i, n, {
        ...textOf(node, false),
        group: "head",
      }),
    );
    // Each column's cells share the space under its heading.
    const k = node.children.length;
    if (!k) return;
    const slot = cells(h - headH * 1.08, k, 0.05);
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
        // Alternate quarters face the other way: the rounded corners swap.
        adj:
          (col + row) % 2 ? { adj1: 0, adj2: 45000 } : { adj1: 45000, adj2: 0 },
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
  const gap = 0;
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
    const base = w * PYRAMID_BASE;
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
    const x = h * 0.66;
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
    const bw = w * stepFraction(i, n);
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
  // Each item is a picture over its caption, the picture 68% of it.
  const itemH = Math.min(h, (cell * 0.9) / 0.68);
  const top = (h - itemH) / 2,
    picH = itemH * 0.68;
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
        { x: at(i), y: top + picH, w: cell, h: itemH - picH },
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
  // Each item is a portrait over its name, the portrait 62% of it.
  const itemH = Math.min(h, cell / 0.62);
  const d = Math.min(cell, itemH * 0.62);
  const top = (h - itemH) / 2;
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
    const capY = top + itemH * 0.62 * 1.04;
    out.push(
      shape(
        "rect",
        { x: at(i), y: capY, w: cell, h: top + itemH - capY },
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
