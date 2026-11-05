/**
 * Hatch pattern library.
 *
 * A pattern is { name, description, families }. Each family is one infinite
 * set of parallel lines, using the same fields as a DXF hatch pattern line:
 *
 *   angle   line direction in degrees, counter-clockwise from +X
 *   x, y    origin: line 0 passes through it and its dash pattern starts there
 *   dx, dy  offset from line k to line k + 1, in the line's own frame:
 *           dx along the line direction, dy perpendicular to it (dy > 0)
 *   dashes  positive = dash, negative = gap, 0 = dot; [] = continuous
 *
 * Line k passes through (x, y) + k * (dx * u + dy * v), where u is the line
 * direction and v is u rotated 90 degrees counter-clockwise; its dash pattern
 * starts at that point. Values are in drawing units at pattern scale 1 and
 * are sized for drawings in millimetres. 'SOLID' has no families and means a
 * solid fill.
 */

const D2R = Math.PI / 180;
const S3 = Math.sqrt(3);

/** Family with the offset given in the line's own frame. */
function line(angle, x, y, dx, dy, dashes = []) {
  return { angle, x, y, dx, dy, dashes };
}

/** Rotate families (directions and origins) by `deg` about (0, 0). */
function rotate(fams, deg) {
  const c = Math.cos(deg * D2R),
    s = Math.sin(deg * D2R);
  return fams.map((f) => ({ ...f, angle: f.angle + deg, x: f.x * c - f.y * s, y: f.x * s + f.y * c }));
}

/** Scale every length of the families by k. */
function scaled(fams, k) {
  return fams.map((f) => ({ ...f, x: f.x * k, y: f.y * k, dx: f.dx * k, dy: f.dy * k, dashes: f.dashes.map((d) => d * k) }));
}

/** Integers [g, x, y] with a * x + b * y = g = gcd(a, b) >= 0. */
function egcd(a, b) {
  if (b === 0) return a < 0 ? [-a, -1, 0] : [a, 1, 0];
  const [g, x, y] = egcd(b, a % b);
  return [g, y, x - Math.trunc(a / b) * y];
}

/**
 * Families that repeat a small motif on the lattice spanned by A and B
 * (det(A, B) > 0). Items:
 *   ['seg', x, y, m, n, f]  segment from (x, y) along f * (m * A + n * B),
 *                           with m, n coprime integers and 0 < f < 1
 *   ['dot', x, y]           dot at (x, y)
 * Each item becomes one family whose period is the lattice vector along it.
 */
function lattice(A, B, items) {
  const out = [];
  for (const it of items) {
    const [kind, x, y] = it;
    const m = kind === 'dot' ? 1 : it[3];
    const n = kind === 'dot' ? 0 : it[4];
    const [g, gx, gy] = egcd(m, n);
    if (g !== 1) throw new Error('lattice direction must be primitive');
    const px = m * A[0] + n * B[0],
      py = m * A[1] + n * B[1];
    const qx = -gy * A[0] + gx * B[0],
      qy = -gy * A[1] + gx * B[1];
    const len = Math.hypot(px, py);
    const ux = px / len,
      uy = py / len;
    const dashes = kind === 'dot' ? [0, -len] : [it[5] * len, -(1 - it[5]) * len];
    out.push(line(Math.atan2(py, px) / D2R, x, y, qx * ux + qy * uy, qy * ux - qx * uy, dashes));
  }
  return out;
}

/** Round to 1e-9, normalize the angle into [0, 360) and clear negative zeros. */
function clean(fams) {
  const r = (v) => Math.round(v * 1e9) / 1e9 + 0;
  const deg = (a) => {
    const v = r(((a % 360) + 360) % 360);
    return v >= 360 ? 0 : v;
  };
  return fams.map((f) => ({
    angle: deg(f.angle),
    x: r(f.x),
    y: r(f.y),
    dx: r(f.dx),
    dy: r(f.dy),
    dashes: f.dashes.map(r),
  }));
}

/** Triangle motif: corners s, s + f*A, s + f*B (sign 1) or the point reflection (sign -1). */
function triangle(A, B, x, y, f, sign = 1) {
  const ax = sign * f * A[0],
    ay = sign * f * A[1];
  const bx = sign * f * B[0],
    by = sign * f * B[1];
  return [
    ['seg', x, y, sign, 0, f],
    ['seg', x + ax, y + ay, -sign, sign, f],
    ['seg', x + bx, y + by, 0, -sign, f],
  ];
}

/**
 * Pebble motif: an irregular quadrilateral with sides along A, A + B, B - A
 * and -B (sign -1 reflects it). The side fractions close the outline.
 */
function pebble(A, B, x, y, a, b, sign = 1) {
  const c = a + b,
    d = a + 2 * b;
  const steps = [
    [1, 0, a],
    [1, 1, b],
    [-1, 1, c],
    [0, -1, d],
  ];
  const items = [];
  let cx = x,
    cy = y;
  for (const [m, n, f] of steps) {
    const mm = m * sign,
      nn = n * sign;
    items.push(['seg', cx, cy, mm, nn, f]);
    cx += f * (mm * A[0] + nn * B[0]);
    cy += f * (mm * A[1] + nn * B[1]);
  }
  return items;
}

const HEX_ROW = [line(0, -0.5, S3 / 2, 1.5, S3 / 2, [1, -2])];

const CONCRETE_A = [9, 0],
  CONCRETE_B = [3.5, 8];
const GRAVEL_A = [8, 0],
  GRAVEL_B = [3, 7];

const DEFS = [
  {
    name: 'SOLID',
    description: 'Solid fill',
    families: [],
  },
  {
    name: 'LINES',
    description: 'Single diagonal lines at 45 degrees, 3 apart',
    families: [line(45, 0, 0, 0, 3)],
  },
  {
    name: 'CROSS',
    description: 'Diagonal crosshatch, 3 apart',
    families: [line(45, 0, 0, 0, 3), line(135, 0, 0, 0, 3)],
  },
  {
    name: 'DIAMOND',
    description: 'Flat diamonds from lines at 30 and 150 degrees',
    families: [line(30, 0, 0, 0, 3), line(150, 0, 0, 0, 3)],
  },
  {
    name: 'GRID',
    description: 'Square grid, 5 x 5',
    families: [line(0, 0, 0, 0, 5), line(90, 0, 0, 0, 5)],
  },
  {
    name: 'DOTS',
    description: 'Staggered dots, 3 apart',
    families: [line(0, 0, 0, 1.5, 3, [0, -3])],
  },
  {
    name: 'DASH',
    description: 'Staggered horizontal dashes',
    families: [line(0, 0, 0, 2.5, 2.5, [2.5, -2.5])],
  },
  {
    name: 'BRICK',
    description: 'Running bond brickwork, 8 x 4 units',
    families: [line(0, 0, 0, 0, 4), line(90, 0, 0, 4, 4, [4, -4])],
  },
  {
    name: 'BLOCK',
    description: 'Stacked blocks with aligned joints, 10 x 5 units',
    families: [line(0, 0, 0, 0, 5), line(90, 0, 0, 0, 10)],
  },
  {
    name: 'PLANKS',
    description: 'Boards 18 long and 4 wide with joints shifted by a third',
    families: [line(0, 0, 0, 0, 4), ...lattice([18, 0], [6, 4], [['seg', 0, 0, -1, 3, 1 / 3]])],
  },
  {
    name: 'HERRINGBONE',
    description: 'Herringbone paving, 5 x 2.5 units at 45 degrees',
    families: scaled(rotate([line(0, -1, 0, 1, 1, [3, -1]), line(90, 0, 0, -1, 1, [3, -1])], 45), 2.5),
  },
  {
    name: 'BASKET',
    description: 'Basket weave: 3 x 3 squares with alternating pairs of lines',
    families: [
      line(0, 0, 0, 0, 3),
      line(90, 0, 0, 0, 3),
      line(0, 0, 1, 3, 3, [3, -3]),
      line(0, 0, 2, 3, 3, [3, -3]),
      line(90, 1, 3, 3, 3, [3, -3]),
      line(90, 2, 3, 3, 3, [3, -3]),
    ],
  },
  {
    name: 'HONEYCOMB',
    description: 'Regular hexagons with sides of 3',
    families: scaled([...HEX_ROW, ...rotate(HEX_ROW, 60), ...rotate(HEX_ROW, 120)], 3),
  },
  {
    name: 'TRIANGLES',
    description: 'Equilateral triangles with sides of 4',
    families: [line(0, 0, 0, 0, 2 * S3), line(60, 0, 0, 0, 2 * S3), line(120, 0, 0, 0, 2 * S3)],
  },
  {
    name: 'RIPPLE',
    description: 'Rows of shallow zigzags made of straight dashes',
    families: lattice([4, 0], [0, 3], [
      ['seg', 0, 0, 1, 1, 0.5],
      ['seg', 0, 0, -1, 1, 0.5],
    ]),
  },
  {
    name: 'BATTING',
    description: 'Soft insulation: tall zigzags between band lines 6 apart',
    families: [
      line(0, 0, 0, 0, 6),
      ...lattice([3, 0], [0, 6], [
        ['seg', 0, 0, 1, 2, 0.5],
        ['seg', 0, 0, -1, 2, 0.5],
      ]),
    ],
  },
  {
    name: 'STEEL',
    description: 'Pairs of diagonal lines 0.8 apart, pairs 4 apart',
    families: [line(45, 0, 0, 0, 4), line(45, -0.8 * Math.SQRT1_2, 0.8 * Math.SQRT1_2, 0, 4)],
  },
  {
    name: 'AGGREGATE',
    description: 'Concrete-like mix of small triangles, dots and short dashes',
    families: lattice(CONCRETE_A, CONCRETE_B, [
      ...triangle(CONCRETE_A, CONCRETE_B, 0.8, 1.2, 0.15, 1),
      ...triangle(CONCRETE_A, CONCRETE_B, 7.5, 6.2, 0.11, -1),
      ['dot', 5, 2.5],
      ['dot', 2.6, 5.4],
      ['dot', 9.1, 3.9],
      ['seg', 6, 0.9, 1, 1, 0.06],
      ['seg', 4.2, 3.2, 0, 1, 0.1],
      ['seg', 10.6, 5.6, -1, 1, 0.1],
    ]),
  },
  {
    name: 'SOIL',
    description: 'Earth-like bundles of three short lines, alternating horizontal and vertical',
    families: [
      line(0, 0.75, 1.5, 6, 6, [4.5, -7.5]),
      line(0, 0.75, 3, 6, 6, [4.5, -7.5]),
      line(0, 0.75, 4.5, 6, 6, [4.5, -7.5]),
      line(90, 1.5, 6.75, 6, 6, [4.5, -7.5]),
      line(90, 3, 6.75, 6, 6, [4.5, -7.5]),
      line(90, 4.5, 6.75, 6, 6, [4.5, -7.5]),
    ],
  },
  {
    name: 'PEBBLES',
    description: 'Gravel-like scattered irregular stones',
    families: lattice(GRAVEL_A, GRAVEL_B, [
      ...pebble(GRAVEL_A, GRAVEL_B, 0.5, 0.6, 0.12, 0.08, 1),
      ...pebble(GRAVEL_A, GRAVEL_B, 9.2, 5.6, 0.09, 0.05, -1),
      ['dot', 6.2, 1.4],
      ['dot', 4.3, 5.2],
    ]),
  },
  {
    name: 'SAND',
    description: 'Dense irregular dots',
    families: lattice([2.6, 0], [0.9, 2.3], [
      ['dot', 0, 0],
      ['dot', 1.45, 0.85],
      ['dot', 0.55, 1.55],
    ]),
  },
];

/** All patterns, in menu order. */
export const PATTERNS = DEFS.map((p) => Object.freeze({ ...p, families: Object.freeze(clean(p.families)) }));

const BY_NAME = new Map(PATTERNS.map((p) => [p.name.toUpperCase(), p]));

/** Pattern by name (case-insensitive), or null. */
export function getPattern(name) {
  return BY_NAME.get(String(name ?? '').toUpperCase()) ?? null;
}

/** Pattern names, in menu order. */
export function patternNames() {
  return PATTERNS.map((p) => p.name);
}

/** Total length of one repetition of a dash list. */
export function dashPeriod(dashes) {
  let s = 0;
  for (const d of dashes) s += Math.abs(d);
  return s;
}

/**
 * Families reflected across the pattern's X axis (directions negated). The
 * offset keeps dy > 0: line k of the result is line -k of the reflection.
 */
export function mirrorFamilies(fams) {
  return fams.map((f) => ({
    ...f,
    angle: (360 - (f.angle % 360)) % 360,
    y: -f.y || 0,
    dx: f.dy > 0 ? -f.dx || 0 : f.dx,
    dy: Math.abs(f.dy),
  }));
}

const MIRRORED = new WeakMap();

/**
 * Pattern a hatch entity draws: the library pattern of its name, else the
 * imported definition it carries (families), reflected when ent.mirror is set
 * (the hatch was mirrored). null for solid fills and unknown patterns.
 */
export function hatchPattern(ent) {
  if (!ent.pattern || String(ent.pattern).toUpperCase() === 'SOLID') return null;
  const pat = getPattern(ent.pattern) ?? (ent.families?.length ? { families: ent.families } : null);
  if (!pat || !ent.mirror) return pat;
  let m = MIRRORED.get(pat.families);
  if (!m) MIRRORED.set(pat.families, (m = { families: mirrorFamilies(pat.families) }));
  return m;
}
