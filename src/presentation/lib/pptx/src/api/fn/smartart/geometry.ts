// Geometry shared by the layout code (the saved drawing) and the layout
// definitions (what other editors lay out again from). Keeping the numbers
// in one place is what makes the two agree: each function here is written
// in the terms a layout definition can state (fractions of the frame's
// width or height, chosen per item count or position).

/** Most items a definition spells out per count; more fall back. */
export const MAX_COUNTED = 10;

// ---------------------------------------------------------------- Rings

/**
 * Node height of a ring of `n` items, as a fraction of the frame height:
 * neighbors keep a gap of 45% of a node's width between them, and a node
 * is never more than `fill` of the frame.
 */
export const ringNodeFraction = (n: number, ratio = 1, fill = 0.38): number => {
  const s = Math.sin(Math.PI / Math.max(n, 2));
  return Math.min(fill, s / (1.45 * ratio + s));
};

/** Vertical offset of a ring's center below the frame center that centers
 *  the ring's bounding box (nodes start at the top and go clockwise), as a
 *  fraction of the ring radius. */
export const ringCenterShift = (n: number): number => {
  if (n < 2) return 0;
  let max = -1;
  for (let i = 0; i < n; i++)
    max = Math.max(max, Math.sin(-Math.PI / 2 + (2 * Math.PI * i) / n));
  return (1 - max) / 2;
};

/** Angle (radians) of ring position `i` of `n`: clockwise from the top. */
export const ringAngle = (i: number, n: number): number =>
  -Math.PI / 2 + (2 * Math.PI * i) / n;

/** Arrow pads at each end, as a fraction of the gap between two shapes. */
export const CONNECTOR_PAD = 0.1;
/** Arrow thickness, as a fraction of the height of the shapes it joins. */
export const ARROW_THICKNESS = 0.25;

/** Distance from a shape's center to its edge in direction (dx, dy). */
export const edgeDistance = (
  geom: string,
  w: number,
  h: number,
  dx: number,
  dy: number,
): number => {
  const len = Math.hypot(dx, dy) || 1;
  const ux = Math.abs(dx / len),
    uy = Math.abs(dy / len);
  const a = w / 2,
    b = h / 2;
  if (geom === "ellipse")
    return (a * b) / Math.sqrt((b * ux) ** 2 + (a * uy) ** 2) || 0;
  return Math.min(ux ? a / ux : Infinity, uy ? b / uy : Infinity);
};

// ---------------------------------------------------------------- Trees

/** Tree sizes, as fractions of the frame width: node size, the gap between
 *  siblings and the gap between levels. */
export const TREE = {
  w: 0.2,
  h: 0.11,
  round: 0.14,
  sibling: 0.03,
  level: 0.05,
} as const;

// ---------------------------------------------------------------- Venn

/** Venn circles of `n`: circle diameter and ring diameter as fractions of
 *  the frame height. */
export const vennSizes = (n: number): { d: number; diam: number } => {
  if (n <= 1) return { d: 1, diam: 0 };
  const k = 0.31 / Math.sin(Math.PI / n);
  const d = 1 / (1 + 2 * k);
  return { d, diam: 2 * d * k };
};

/** Where a venn circle's text sits, relative to the circle (fractions of
 *  its diameter, from its top left): pushed outward from the middle. */
export const vennTextBox = (i: number, n: number) => {
  const a = ringAngle(i, n);
  const push = n > 1 ? 0.1 : 0;
  const w = 0.5,
    h = 0.44;
  return {
    x: 0.5 + push * Math.cos(a) - w / 2,
    y: 0.5 + push * Math.sin(a) - h / 2,
    w,
    h,
  };
};

/** A ring of labels riding on a track: node size and ratio, ring radius
 *  and track diameter (fractions of the frame height), and where the ring's
 *  center sits once its bounding box is centered. */
export const RING_TRACK = { ratio: 1.6, fill: 0.28, band: 0.45 } as const;
export const ringTrackSizes = (n: number) => {
  const k = ringNodeFraction(n, RING_TRACK.ratio, RING_TRACK.fill);
  const r = n > 1 ? (1 - k) / 2 : 0;
  const track = 2 * r + k * RING_TRACK.band;
  return { k, r, track, cy: 0.5 + r * ringCenterShift(n) };
};

// ---------------------------------------------------------------- Wheel

/** Slice `i` of a wheel of `n`: start and end angles (degrees clockwise
 *  from the right, as preset pie adjustments take them) and the text box
 *  (fractions of the wheel's diameter from its top left), near the middle
 *  of the slice. */
export const wheelSlice = (i: number, n: number) => {
  const start = -90 + (360 * i) / n,
    end = start + 360 / n;
  const mid = (((start + end) / 2) * Math.PI) / 180;
  const r = 0.5;
  const tr = r * (n === 2 ? 0.5 : 0.58);
  const tw = Math.min(
    r * 0.95,
    2 * tr * Math.sin(Math.PI / n) * 0.95 + r * 0.25,
  );
  const th = r * 0.5;
  let cx = 0.5 + tr * Math.cos(mid),
    cy = 0.5 + tr * Math.sin(mid);
  // Labels are shapes of their own, kept inside the wheel's square.
  cx = Math.min(1 - tw / 2, Math.max(tw / 2, cx));
  cy = Math.min(1 - th / 2, Math.max(th / 2, cy));
  const norm = (deg: number) => ((deg % 360) + 360) % 360;
  return {
    start: norm(start),
    end: norm(end),
    text: { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th },
  };
};

// ---------------------------------------------------------------- Nested circles

/** Circle `i` of `n` nested circles (fractions of the frame height; the
 *  circles share their bottom) and its text box (fractions of its own
 *  diameter, from its top left). */
export const nestedCircle = (i: number, n: number) => {
  const step = 1 / n;
  const d = 1 - i * step * 0.85;
  const next = i < n - 1 ? 1 - (i + 1) * step * 0.85 : 0;
  const band = i < n - 1 ? d - next : d;
  const text =
    i < n - 1
      ? { x: 0.5 - 0.32, y: (band * 0.08) / d, w: 0.64, h: (band * 0.84) / d }
      : { x: 0.5 - 0.36, y: 0.2, w: 0.72, h: 0.6 };
  return { d, text };
};

// ---------------------------------------------------------------- Target

/** Target of `n` rings (fractions of the frame height `h`; the target is
 *  `h` across at the left): ring `i` diameter, and where its label and
 *  leader sit. Labels line up with the middle of each ring's top band. */
export const targetRing = (i: number, n: number) => {
  const d = 1 - i / n;
  const inner = 1 - (i + 1) / n;
  // Middle of the band between this ring and the next, above the center.
  const y = 0.5 - (d + inner) / 4;
  // Labels stay inside the frame.
  return { d, y, labelH: Math.min(1 / n, 0.5 / n + 0.12, 2 * y) };
};
export const TARGET_TEXT_X = 1.12;

// ---------------------------------------------------------------- Steps

/** Height of rising step `i` of `n`, as a fraction of the frame height
 *  (also the width of stepped-pyramid block `i`, of the frame width). */
export const stepFraction = (i: number, n: number): number =>
  0.35 + (0.65 * (i + 1)) / n;

// ---------------------------------------------------------------- Hub

/** Satellite diameter of a hub with `n` satellites, as a fraction of the
 *  frame height, and the hub's. */
export const hubSizes = (n: number) => {
  const s = Math.sin(Math.PI / Math.max(n, 2));
  return {
    sat: Math.min(0.3, s / (1.2 + 2 * s)),
    hub: n ? 0.34 : 0.6,
  };
};

// ---------------------------------------------------------------- Centered quadrants

/** Quadrant `i` of `n` around a centered hub (fractions of the frame height
 *  `m`; x from the square's left), and its text box (fractions of itself). */
export const quadrantCell = (i: number, n: number) => {
  const rows = Math.max(1, Math.ceil(n / 2));
  const gap = 0.02;
  const col = i % 2,
    row = Math.floor(i / 2);
  const cellH = 1 / rows;
  const w = (n === 1 ? 1 : 0.5) - gap,
    h = cellH - gap;
  const top = row === 0 && rows > 1;
  return {
    x: col * 0.5 + gap / 2,
    y: row * cellH + gap / 2,
    w,
    h,
    col,
    top,
    text: { x: col ? 0.3 : 0, y: row === 0 ? 0 : 0.3, w: 0.7, h: 0.7 },
  };
};

// ---------------------------------------------------------------- Pyramids

/** A pyramid's base is two thirds of the frame width. */
export const PYRAMID_BASE = 2 / 3;
