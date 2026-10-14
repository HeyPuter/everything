// SmartArt layouts: lists, processes and cycles.
import type { Role } from "./paint.ts";
import type { SmartArtNode } from "./model.ts";
import {
  ARROW_THICKNESS,
  CONNECTOR_PAD,
  edgeDistance,
  hubSizes,
  ringAngle,
  ringNodeFraction,
  ringTrackSizes,
  wheelSlice,
} from "./geometry.ts";
import {
  type ArtShape,
  type LayoutFn,
  type Para,
  type Rect,
  cells,
  childParas,
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
  const headH = withBody ? h * 0.26 : Math.min(h, cell * 0.65);
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
        ah = aw * 1.1;
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
  const ch = Math.min(withBody ? h * 0.3 : h, cw * 0.45);
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
            y: h * 0.33,
            w: cw * (1 - overlap) * 0.95,
            h: h * 0.67,
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
        aw = ah * 1.1;
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
  // Labels span their own slot, alternately above and below the bar.
  const labelH = h / 2 - barH * 1.6 * 0.7;
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
    out.push(
      shape(
        "rect",
        { x: slot * i, y: above ? 0 : h - labelH, w: slot, h: labelH },
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
    right = w * 0.82;
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

/** Where a cycle puts `n` nodes of `nodeW` x `nodeH` on a circle of
 *  diameter `diam` (a cycle algorithm's terms): clockwise from the top, the
 *  whole scaled down if it overflows the frame, its bounding box centered.
 *  `center` is an optional shape of `centerSize` in the middle. */
export const cycleLayout = (
  w: number,
  h: number,
  n: number,
  nodeW: number,
  nodeH: number,
  diam: number,
  centerSize = 0,
) => {
  const r = n > 1 ? diam / 2 : 0;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = ringAngle(i, n);
    return [r * Math.cos(a), r * Math.sin(a)] as const;
  });
  const xs = pts.flatMap(([x]) => [x - nodeW / 2, x + nodeW / 2]);
  const ys = pts.flatMap(([, y]) => [y - nodeH / 2, y + nodeH / 2]);
  if (centerSize) {
    xs.push(-centerSize / 2, centerSize / 2);
    ys.push(-centerSize / 2, centerSize / 2);
  }
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const k = Math.min(1, w / (x1 - x0 || 1), h / (y1 - y0 || 1));
  const cx = w / 2 - ((x0 + x1) / 2) * k,
    cy = h / 2 - ((y0 + y1) / 2) * k;
  return {
    scale: k,
    nodeW: nodeW * k,
    nodeH: nodeH * k,
    center: [cx, cy] as const,
    at: (i: number) => [cx + pts[i]![0] * k, cy + pts[i]![1] * k] as const,
  };
};

/** An arrow from one shape to the next along the line between their
 *  centers, from edge to edge less a pad at each end. */
const connectorArrow = (
  from: ArtShape,
  to: ArtShape,
  thickness: number,
  index: number,
  count: number,
): ArtShape | null => {
  const ax = from.x + from.w / 2,
    ay = from.y + from.h / 2;
  const bx = to.x + to.w / 2,
    by = to.y + to.h / 2;
  const dx = bx - ax,
    dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const e0 = edgeDistance(from.geom, from.w, from.h, dx, dy),
    e1 = edgeDistance(to.geom, to.w, to.h, dx, dy);
  const dist = len - e0 - e1;
  if (dist <= 0) return null;
  const l = dist * (1 - 2 * CONNECTOR_PAD),
    t = thickness;
  const mid = (e0 + (len - e1)) / 2 / len;
  const mx = ax + dx * mid,
    my = ay + dy * mid;
  return shape(
    "rightArrow",
    { x: mx - l / 2, y: my - t / 2, w: l, h: t },
    "trans",
    index,
    count,
    { rot: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360 },
  );
};

const ringOf =
  (
    geom: string,
    role: Role,
    ratio: number,
    fill: number,
    arrows: boolean,
  ): LayoutFn =>
  ({ w, h, nodes }) => {
    const n = nodes.length;
    if (!n) return [];
    const k = ringNodeFraction(n, ratio, fill);
    const c = cycleLayout(w, h, n, k * h * ratio, k * h, (1 - k) * h);
    const shapes = nodes.map((node, i) => {
      const [x, y] = c.at(i);
      return shape(
        geom,
        { x: x - c.nodeW / 2, y: y - c.nodeH / 2, w: c.nodeW, h: c.nodeH },
        role,
        i,
        n,
        textOf(node),
      );
    });
    const links: ArtShape[] = [];
    if (arrows && n > 1)
      for (let i = 0; i < n; i++) {
        const a = connectorArrow(
          shapes[i]!,
          shapes[(i + 1) % n]!,
          c.nodeH * ARROW_THICKNESS,
          i,
          n,
        );
        if (a) links.push(a);
      }
    return [...shapes.flatMap((s, i) => (links[i] ? [s, links[i]!] : [s]))];
  };

const ring = ringOf("ellipse", "node", 1, 0.38, true);
const textRing = ringOf("rect", "text", 1.5, 0.38, true);
const blockRing = ringOf("roundRect", "node", 1.5, 0.3, true);

const wheel: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const d = h;
  const box = { x: (w - d) / 2, y: (h - d) / 2, w: d, h: d };
  if (n === 1) return [shape("ellipse", box, "node", 0, 1, textOf(nodes[0]!))];
  return nodes.map((node, i) => {
    const s = wheelSlice(i, n);
    return shape("pie", box, "node", i, n, {
      ...textOf(node),
      adj: {
        adj1: Math.round(s.start * 60000),
        adj2: Math.round(s.end * 60000),
      },
      textBox: {
        x: box.x + s.text.x * d,
        y: box.y + s.text.y * d,
        w: s.text.w * d,
        h: s.text.h * d,
      },
    });
  });
};

/** The hub in the middle of the items around it. One top-level item is
 *  the hub, its sub-items around it and joined to it; with several, the
 *  first is the hub of the rest (no data joins them, so no spokes). */
const hubAndSpokes: LayoutFn = ({ w, h, nodes }) => {
  if (!nodes.length) return [];
  const single = nodes.length === 1;
  const hub = nodes[0]!;
  const satellites = single ? hub.children : nodes.slice(1);
  const n = satellites.length;
  const sizes = hubSizes(n);
  const hubD = sizes.hub * h,
    satD = sizes.sat * h;
  const c = cycleLayout(w, h, n, satD, satD, n ? h - satD : 0, hubD);
  const [hx, hy] = c.center;
  const hd = hubD * c.scale;
  const hubShape = shape(
    "ellipse",
    { x: hx - hd / 2, y: hy - hd / 2, w: hd, h: hd },
    "hub",
    0,
    1,
    textOf(hub, !single),
  );
  const out: ArtShape[] = [hubShape];
  satellites.forEach((node, i) => {
    const [x, y] = c.at(i);
    const sat = shape(
      "ellipse",
      { x: x - c.nodeW / 2, y: y - c.nodeH / 2, w: c.nodeW, h: c.nodeH },
      "node",
      i,
      n,
      { ...textOf(node), group: "satellite" },
    );
    if (single) {
      const line = spoke(hubShape, sat, i, n);
      if (line) out.push(line);
    }
    out.push(sat);
  });
  return out;
};

/** A straight line between two shapes' edges, along their centers. */
export const spoke = (
  from: ArtShape,
  to: ArtShape,
  index: number,
  count: number,
): ArtShape | null => {
  const ax = from.x + from.w / 2,
    ay = from.y + from.h / 2;
  const bx = to.x + to.w / 2,
    by = to.y + to.h / 2;
  const dx = bx - ax,
    dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const e0 = edgeDistance(from.geom, from.w, from.h, dx, dy) / len,
    e1 = edgeDistance(to.geom, to.w, to.h, dx, dy) / len;
  if (e0 + e1 >= 1) return null;
  return polyline(
    [
      [ax + dx * e0, ay + dy * e0],
      [bx - dx * e1, by - dy * e1],
    ],
    "line",
    index,
    count,
  );
};

const ringTrack: LayoutFn = ({ w, h, nodes }) => {
  const n = nodes.length;
  if (!n) return [];
  const s = ringTrackSizes(n);
  const c = cycleLayout(w, h, n, s.k * h * 1.6, s.k * h, 2 * s.r * h);
  const D = s.track * h * c.scale;
  const [cx, cy] = c.center;
  const track = shape(
    "donut",
    { x: cx - D / 2, y: cy - D / 2, w: D, h: D },
    "bg",
    0,
    1,
    { adj: { adj: Math.round(((c.nodeH * 0.45) / D) * 100000) } },
  );
  const ring = nodes.map((node, i) => {
    const [x, y] = c.at(i);
    return shape(
      "roundRect",
      { x: x - c.nodeW / 2, y: y - c.nodeH / 2, w: c.nodeW, h: c.nodeH },
      "node",
      i,
      n,
      textOf(node),
    );
  });
  // The track and the ring together are centered in the frame.
  const all = [track, ...ring];
  const top = Math.min(...all.map((r) => r.y)),
    bottom = Math.max(...all.map((r) => r.y + r.h));
  const dy = (h - (bottom - top)) / 2 - top;
  return all.map((r) => ({ ...r, y: r.y + dy }));
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
