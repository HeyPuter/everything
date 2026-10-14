// SmartArt layouts: lists, processes and cycles.
import type { Role } from "./paint.ts";
import type { SmartArtNode } from "./model.ts";
import {
  type ArtShape,
  type LayoutFn,
  type Para,
  type Rect,
  cells,
  childParas,
  clamp,
  gridFor,
  nodeParas,
} from "./kit.ts";

export const shape = (
  geom: string,
  r: Rect,
  role: Role,
  index: number,
  count: number,
  extra: Partial<ArtShape> = {},
): ArtShape => ({
  geom,
  x: r.x,
  y: r.y,
  w: Math.max(0, r.w),
  h: Math.max(0, r.h),
  role,
  index,
  count,
  ...extra,
});
const textOf = (
  node: SmartArtNode,
  withChildren = true,
): { paras: Para[]; item: number } => ({
  paras: nodeParas(node, withChildren),
  item: node.item,
});
const lineCount = (node: SmartArtNode): number => {
  let n = 0;
  const walk = (x: SmartArtNode) => {
    for (const c of x.children) {
      n++;
      walk(c);
    }
  };
  walk(node);
  return n;
};
const hasChildren = (nodes: ReadonlyArray<SmartArtNode>) =>
  nodes.some((n) => n.children.length > 0);
/** A straight or bent stroke through frame-local points. */
export const polyline = (
  points: ReadonlyArray<readonly [number, number]>,
  role: Role,
  index: number,
  count: number,
): ArtShape => {
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  const w = Math.max(1, Math.max(...xs) - x),
    h = Math.max(1, Math.max(...ys) - y);
  return shape("custom", { x, y, w, h }, role, index, count, {
    path: [points.map(([px, py]) => [px - x, py - y] as const)],
  });
};
/** A filled polygon through frame-local points. */
export const polygon = (
  points: ReadonlyArray<readonly [number, number]>,
  role: Role,
  index: number,
  count: number,
  extra: Partial<ArtShape> = {},
): ArtShape => ({
  ...polyline(points, role, index, count),
  closed: true,
  ...extra,
});

// ---------------------------------------------------------------- Lists

const tiles: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const grid = gridFor(n, w, h, 1.6);
  const cw = grid.size,
    ch = grid.size / 1.6,
    gap = cw * 0.1;
  const totalH = grid.rows * ch + (grid.rows - 1) * gap;
  const top = (h - totalH) / 2;
  return nodes.map((node, i) => {
    const row = Math.floor(i / grid.cols);
    const inRow = Math.min(grid.cols, n - row * grid.cols);
    const rowW = inRow * cw + (inRow - 1) * gap;
    const col = i - row * grid.cols;
    return shape(
      "rect",
      {
        x: (w - rowW) / 2 + col * (cw + gap),
        y: top + row * (ch + gap),
        w: cw,
        h: ch,
      },
      "node",
      i,
      n,
      textOf(node),
    );
  });
};

const bannerList: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const units = nodes.map((node) => 1 + lineCount(node) * 0.55);
  const gap = 0.18;
  const total = units.reduce((a, b) => a + b, 0) + gap * (n - 1);
  const unit = Math.min(h / total, w * 0.16);
  let y = (h - unit * total) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("roundRect", { x: 0, y, w, h: unit }, "node", i, n, {
        ...textOf(node, false),
        align: "l",
        group: "head",
      }),
    );
    y += unit;
    const lines = lineCount(node);
    if (lines) {
      out.push(
        shape(
          "rect",
          { x: w * 0.04, y, w: w * 0.96, h: lines * 0.55 * unit },
          "text",
          i,
          n,
          {
            paras: childParas(node),
            align: "l",
            anchor: "t",
            group: "body",
            maxPt: 20,
          },
        ),
      );
      y += lines * 0.55 * unit;
    }
    y += gap * unit;
  });
  return out;
};

const headingColumns: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.08);
  const withBody = hasChildren(nodes);
  const headH = withBody
    ? Math.min(h * 0.26, cell * 0.5)
    : Math.min(h, cell * 0.65);
  const top = withBody ? 0 : (h - headH) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("rect", { x: at(i), y: top, w: cell, h: headH }, "node", i, n, {
        ...textOf(node, false),
        group: "head",
      }),
    );
    if (withBody)
      out.push(
        shape(
          "rect",
          { x: at(i), y: headH, w: cell, h: h - headH },
          "child",
          i,
          n,
          {
            paras: childParas(node),
            align: "l",
            anchor: "t",
            maxPt: 20,
          },
        ),
      );
  });
  return out;
};

const stackedCards: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(h, n, 0.12);
  const rowH = Math.min(cell, w * 0.3);
  const top = (h - (n * rowH + (n - 1) * rowH * 0.12)) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const y = top + (at(i) * rowH) / cell;
    const tabW = node.children.length ? w * 0.3 : w;
    if (node.children.length)
      out.push(
        shape(
          "rect",
          { x: w * 0.27, y: y + rowH * 0.08, w: w * 0.73, h: rowH * 0.84 },
          "child",
          i,
          n,
          {
            paras: childParas(node),
            align: "l",
            textBox: {
              x: w * 0.31,
              y: y + rowH * 0.08,
              w: w * 0.69,
              h: rowH * 0.84,
            },
            maxPt: 20,
          },
        ),
      );
    out.push(
      shape("roundRect", { x: 0, y, w: tabW, h: rowH }, "node", i, n, {
        ...textOf(node, false),
        group: "head",
      }),
    );
  });
  return out;
};

const ruledList: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const rowH = h / n;
  const out: ArtShape[] = [];
  const split = hasChildren(nodes) ? 0.32 : 1;
  nodes.forEach((node, i) => {
    const y = i * rowH;
    out.push(
      polyline(
        [
          [0, y],
          [w, y],
        ],
        "line",
        i,
        n,
      ),
    );
    out.push(
      shape(
        "rect",
        { x: 0, y: y + rowH * 0.06, w: w * split, h: rowH * 0.88 },
        "text",
        i,
        n,
        {
          ...textOf(node, false),
          align: "l",
          anchor: "t",
          group: "head",
        },
      ),
    );
    if (split < 1)
      out.push(
        shape(
          "rect",
          {
            x: w * split,
            y: y + rowH * 0.06,
            w: w * (1 - split),
            h: rowH * 0.88,
          },
          "text",
          i,
          n,
          {
            paras: childParas(node),
            align: "l",
            anchor: "t",
            group: "body",
            maxPt: 18,
          },
        ),
      );
  });
  return out;
};

const groupedBoxes: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.08);
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const kids = node.children;
    out.push(
      shape("roundRect", { x: at(i), y: 0, w: cell, h }, "bg", i, n, {
        ...textOf(node, false),
        anchor: kids.length ? "t" : "ctr",
        adj: { adj: 6000 },
        group: "head",
        ...(kids.length
          ? { textBox: { x: at(i), y: 0, w: cell, h: h * 0.22 } }
          : {}),
      }),
    );
    const k = kids.length;
    if (!k) return;
    const top = h * 0.24,
      bottom = h * 0.97;
    const slot = cells(bottom - top, k, 0.1);
    kids.forEach((kid, j) =>
      out.push(
        shape(
          "roundRect",
          {
            x: at(i) + cell * 0.08,
            y: top + slot.at(j),
            w: cell * 0.84,
            h: slot.cell,
          },
          "node",
          i,
          n,
          { ...textOf(kid), group: "kid", maxPt: 20 },
        ),
      ),
    );
  });
  return out;
};

// ---------------------------------------------------------------- Processes

const arrowSteps: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, gap, at } = cells(w, n, 0.32);
  const boxH = hasChildren(nodes) ? h * 0.9 : Math.min(h, cell * 0.7);
  const y = (h - boxH) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("roundRect", { x: at(i), y, w: cell, h: boxH }, "node", i, n, {
        ...textOf(node),
        adj: { adj: 10000 },
      }),
    );
    if (i < n - 1) {
      const aw = gap * 0.7,
        ah = Math.min(aw * 1.1, boxH * 0.5);
      out.push(
        shape(
          "rightArrow",
          { x: at(i) + cell + gap * 0.15, y: h / 2 - ah / 2, w: aw, h: ah },
          "trans",
          i,
          n,
          { adj: { adj1: 60000, adj2: 50000 } },
        ),
      );
    }
  });
  return out;
};

const chevrons: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const overlap = 0.12;
  const cw = w / (1 + (n - 1) * (1 - overlap));
  const withBody = hasChildren(nodes);
  const ch = withBody ? Math.min(h * 0.3, cw * 0.45) : Math.min(h, cw * 0.45);
  const y = withBody ? 0 : (h - ch) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    const x = i * cw * (1 - overlap);
    out.push(
      shape(
        i === 0 ? "homePlate" : "chevron",
        { x, y, w: cw, h: ch },
        "node",
        i,
        n,
        {
          ...textOf(node, false),
          group: "head",
          adj: { adj: 40000 },
        },
      ),
    );
    if (withBody && node.children.length)
      out.push(
        shape(
          "rect",
          {
            x: x + cw * 0.05,
            y: ch * 1.1,
            w: cw * (1 - overlap) * 0.95,
            h: h - ch * 1.1,
          },
          "text",
          i,
          n,
          {
            paras: childParas(node),
            align: "l",
            anchor: "t",
            group: "body",
            maxPt: 18,
          },
        ),
      );
  });
  return out;
};

const downwardFlow: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, gap, at } = cells(h, n, 0.35);
  const boxW = Math.min(w, hasChildren(nodes) ? w : cell * 4);
  const x = (w - boxW) / 2;
  const out: ArtShape[] = [];
  nodes.forEach((node, i) => {
    out.push(
      shape("roundRect", { x, y: at(i), w: boxW, h: cell }, "node", i, n, {
        ...textOf(node),
        adj: { adj: 10000 },
      }),
    );
    if (i < n - 1) {
      const ah = gap * 0.75,
        aw = Math.min(ah * 1.1, boxW * 0.3);
      out.push(
        shape(
          "downArrow",
          { x: w / 2 - aw / 2, y: at(i) + cell + gap * 0.125, w: aw, h: ah },
          "trans",
          i,
          n,
          { adj: { adj1: 60000, adj2: 50000 } },
        ),
      );
    }
  });
  return out;
};

const risingSteps: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const { cell, at } = cells(w, n, 0.05);
  return nodes.map((node, i) => {
    const bh = h * (0.35 + (0.65 * (i + 1)) / n);
    return shape(
      "rect",
      { x: at(i), y: h - bh, w: cell, h: bh },
      "node",
      i,
      n,
      {
        ...textOf(node),
        anchor: "t",
      },
    );
  });
};

const timeline: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const barH = h * 0.07;
  const out: ArtShape[] = [
    shape("rightArrow", { x: 0, y: h / 2 - barH, w, h: barH * 2 }, "bg", 0, 1, {
      adj: { adj1: 50000, adj2: 60000 },
    }),
  ];
  const slot = (w * 0.94) / n;
  const d = Math.min(barH * 1.6, slot * 0.4);
  nodes.forEach((node, i) => {
    const cx = slot * (i + 0.5);
    out.push(
      shape(
        "ellipse",
        { x: cx - d / 2, y: h / 2 - d / 2, w: d, h: d },
        "node",
        i,
        n,
      ),
    );
    const above = i % 2 === 0;
    const tw = Math.min(slot * 1.8, w - Math.max(0, cx - slot * 0.9));
    out.push(
      shape(
        "rect",
        {
          x: clamp(cx - tw / 2, 0, w - tw),
          y: above ? 0 : h / 2 + d * 0.7,
          w: tw,
          h: h / 2 - d * 0.7,
        },
        "text",
        i,
        n,
        { ...textOf(node), anchor: above ? "b" : "t" },
      ),
    );
  });
  return out;
};

const blocksOnArrow: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const out: ArtShape[] = [
    shape("rightArrow", { x: 0, y: 0, w, h }, "bg", 0, 1, {
      adj: { adj1: 70000, adj2: 50000 },
    }),
  ];
  const left = w * 0.03,
    right = w - Math.min(h * 0.55, w * 0.18);
  const { cell, at } = cells(right - left, n, 0.06);
  const bh = h * 0.5;
  nodes.forEach((node, i) =>
    out.push(
      shape(
        "roundRect",
        { x: left + at(i), y: (h - bh) / 2, w: cell, h: bh },
        "node",
        i,
        n,
        {
          ...textOf(node),
        },
      ),
    ),
  );
  return out;
};

// ---------------------------------------------------------------- Cycles

const ringPositions = (
  w: number,
  h: number,
  n: number,
  ratio = 1,
  fill = 0.38,
) => {
  const m = Math.min(w, h);
  const s = Math.sin(Math.PI / Math.max(n, 2));
  // Node size: neighbors keep a gap of 45% of a node between them.
  const d = Math.min(m * fill, (m * s) / (1.45 * ratio + s));
  const nodeW = d * ratio,
    nodeH = d;
  const rx = (w - nodeW) / 2,
    ry = (h - nodeH) / 2;
  const r = Math.min(rx, ry, (m - d) / 2);
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  return {
    d,
    nodeW,
    nodeH,
    r,
    angle,
    center: (i: number) =>
      [w / 2 + r * Math.cos(angle(i)), h / 2 + r * Math.sin(angle(i))] as const,
  };
};
const ringArrows = (
  w: number,
  h: number,
  n: number,
  ring: ReturnType<typeof ringPositions>,
  textOnly = false,
): ArtShape[] => {
  if (n < 2) return [];
  const out: ArtShape[] = [];
  const chord = 2 * ring.r * Math.sin(Math.PI / n);
  // Arrows sit in the gap between neighbors; text-only rings leave more room.
  const clearance = textOnly ? ring.nodeW * 0.55 : ring.nodeW * 0.95;
  const len = Math.max(0, Math.min(chord - clearance, ring.d * 0.45));
  if (len <= 0) return out;
  const ah = len * 0.62;
  for (let i = 0; i < n; i++) {
    const a = ring.angle(i + 0.5);
    const cx = w / 2 + ring.r * Math.cos(a),
      cy = h / 2 + ring.r * Math.sin(a);
    out.push(
      shape(
        "rightArrow",
        { x: cx - len / 2, y: cy - ah / 2, w: len, h: ah },
        "trans",
        i,
        n,
        {
          rot: ((a * 180) / Math.PI + 90 + 360) % 360,
          adj: { adj1: 60000, adj2: 50000 },
        },
      ),
    );
  }
  return out;
};

const ring: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const rp = ringPositions(w, h, n);
  return [
    ...ringArrows(w, h, n, rp),
    ...nodes.map((node, i) => {
      const [cx, cy] = rp.center(i);
      return shape(
        "ellipse",
        { x: cx - rp.d / 2, y: cy - rp.d / 2, w: rp.d, h: rp.d },
        "node",
        i,
        n,
        {
          ...textOf(node),
        },
      );
    }),
  ];
};

const textRing: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const rp = ringPositions(w, h, n, 1.5);
  return [
    ...ringArrows(w, h, n, rp, true),
    ...nodes.map((node, i) => {
      const [cx, cy] = rp.center(i);
      return shape(
        "rect",
        {
          x: cx - rp.nodeW / 2,
          y: cy - rp.nodeH / 2,
          w: rp.nodeW,
          h: rp.nodeH,
        },
        "text",
        i,
        n,
        textOf(node),
      );
    }),
  ];
};

const blockRing: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const rp = ringPositions(w, h, n, 1.5, 0.3);
  return [
    ...ringArrows(w, h, n, rp),
    ...nodes.map((node, i) => {
      const [cx, cy] = rp.center(i);
      return shape(
        "roundRect",
        {
          x: cx - rp.nodeW / 2,
          y: cy - rp.nodeH / 2,
          w: rp.nodeW,
          h: rp.nodeH,
        },
        "node",
        i,
        n,
        textOf(node),
      );
    }),
  ];
};

const wheel: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const d = Math.min(w, h);
  const box = { x: (w - d) / 2, y: (h - d) / 2, w: d, h: d };
  const r = d / 2;
  if (n === 1) return [shape("ellipse", box, "node", 0, 1, textOf(nodes[0]!))];
  return nodes.map((node, i) => {
    const start = -90 + (360 * i) / n,
      end = start + 360 / n;
    const mid = (((start + end) / 2) * Math.PI) / 180;
    const tr = r * (n === 2 ? 0.5 : 0.58);
    const tw = Math.min(
        r * 0.95,
        2 * tr * Math.sin(Math.PI / n) * 0.95 + r * 0.25,
      ),
      th = r * 0.5;
    const cx = w / 2 + tr * Math.cos(mid),
      cy = h / 2 + tr * Math.sin(mid);
    const norm = (deg: number) =>
      Math.round((((deg % 360) + 360) % 360) * 60000);
    return shape("pie", box, "node", i, n, {
      ...textOf(node),
      adj: { adj1: norm(start), adj2: norm(end) },
      textBox: { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th },
    });
  });
};

const hubAndSpokes: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const single = nodes.length === 1;
  const hub = nodes[0]!;
  const satellites = single ? hub.children : nodes.slice(1);
  const n = satellites.length;
  const m = Math.min(w, h);
  const hubD = n ? m * 0.34 : m * 0.6;
  const out: ArtShape[] = [];
  if (n) {
    const s = Math.sin(Math.PI / Math.max(n, 2));
    const d = Math.min(m * 0.3, ((m / 2) * 2 * s) / (1.2 + 2 * s));
    const r = Math.min(w, h) / 2 - d / 2;
    const center = (i: number) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      return [w / 2 + r * Math.cos(a), h / 2 + r * Math.sin(a)] as const;
    };
    satellites.forEach((_, i) => {
      const [cx, cy] = center(i);
      out.push(
        polyline(
          [
            [w / 2, h / 2],
            [cx, cy],
          ],
          "line",
          i,
          n,
        ),
      );
    });
    satellites.forEach((node, i) => {
      const [cx, cy] = center(i);
      out.push(
        shape(
          "ellipse",
          { x: cx - d / 2, y: cy - d / 2, w: d, h: d },
          "node",
          i,
          n,
          {
            ...textOf(node),
            group: "satellite",
          },
        ),
      );
    });
  }
  out.push(
    shape(
      "ellipse",
      { x: w / 2 - hubD / 2, y: h / 2 - hubD / 2, w: hubD, h: hubD },
      "hub",
      0,
      1,
      {
        ...textOf(hub, !single),
      },
    ),
  );
  return out;
};

const ringTrack: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const rp = ringPositions(w, h, n, 1.6, 0.28);
  const D = 2 * rp.r + rp.nodeH * 0.45;
  return [
    shape(
      "donut",
      { x: w / 2 - D / 2, y: h / 2 - D / 2, w: D, h: D },
      "bg",
      0,
      1,
      {
        adj: { adj: Math.round(((rp.nodeH * 0.45) / D) * 100000) },
      },
    ),
    ...nodes.map((node, i) => {
      const [cx, cy] = rp.center(i);
      return shape(
        "roundRect",
        {
          x: cx - rp.nodeW / 2,
          y: cy - rp.nodeH / 2,
          w: rp.nodeW,
          h: rp.nodeH,
        },
        "node",
        i,
        n,
        textOf(node),
      );
    }),
  ];
};

export const FLOW_LAYOUTS: Record<string, LayoutFn> = {
  tiles,
  "banner-list": bannerList,
  "heading-columns": headingColumns,
  "stacked-cards": stackedCards,
  "ruled-list": ruledList,
  "grouped-boxes": groupedBoxes,
  "arrow-steps": arrowSteps,
  chevrons,
  "downward-flow": downwardFlow,
  "rising-steps": risingSteps,
  timeline,
  "blocks-on-arrow": blocksOnArrow,
  ring,
  "text-ring": textRing,
  "block-ring": blockRing,
  wheel,
  "hub-spokes": hubAndSpokes,
  "ring-track": ringTrack,
};
