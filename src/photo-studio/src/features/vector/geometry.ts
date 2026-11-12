import type { VectorMask } from '../../model/vector';
import type { LiveShape } from '../../model/live-shape';

// Pure path geometry for the pen, shape and path selection tools. Paths use the
// PSD knot layout shared by shape layers: points = [inX, inY, x, y, outX, outY]
// where "in" is the control before the anchor and "out" the control after it.
export type Knot = VectorMask['paths'][number]['knots'][number];
export type SubPath = VectorMask['paths'][number];
export type Pt = [number, number];
export type PathOp = 'combine' | 'subtract' | 'intersect' | 'exclude';
export type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Q', number, number, number, number] | ['Z'];

// Cubic handle length for a quarter circle (4/3 * tan(pi/8)).
export const KAPPA = 0.5522847498307936;

export const emptyMask = (): VectorMask => ({ paths: [] });
export function corner(x: number, y: number): Knot {
  return { linked: false, points: [x, y, x, y, x, y] };
}
export function knot(x: number, y: number, inX: number, inY: number, outX: number, outY: number, linked?: boolean): Knot {
  const k = { linked: false, points: [inX, inY, x, y, outX, outY] };
  k.linked = linked ?? smoothKnot(k);
  return k;
}
export const anchor = (k: Knot): Pt => [k.points[2], k.points[3]];
export const inHandle = (k: Knot): Pt => [k.points[0], k.points[1]];
export const outHandle = (k: Knot): Pt => [k.points[4], k.points[5]];
export const hasIn = (k: Knot) => k.points[0] !== k.points[2] || k.points[1] !== k.points[3];
export const hasOut = (k: Knot) => k.points[4] !== k.points[2] || k.points[5] !== k.points[3];
/** Both handles present and collinear on opposite sides of the anchor. */
export function smoothKnot(k: Knot) {
  if (!hasIn(k) || !hasOut(k)) return false;
  const [ax, ay] = anchor(k);
  const ix = k.points[0] - ax, iy = k.points[1] - ay, ox = k.points[4] - ax, oy = k.points[5] - ay;
  const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
  return Math.abs(ix * oy - iy * ox) / (li * lo) < 1e-3 && ix * ox + iy * oy < 0;
}
export function closedPath(knots: Knot[], operation: PathOp | undefined = 'combine', fillRule: SubPath['fillRule'] = 'non-zero'): SubPath {
  return { open: false, fillRule, ...(operation ? { operation } : {}), knots };
}
export function cloneMask(m: VectorMask): VectorMask {
  return structuredClone(m);
}
export function translateMask(m: VectorMask, dx: number, dy: number, only?: Set<number>) {
  m.paths.forEach((p, i) => {
    if (only && !only.has(i)) return;
    for (const k of p.knots) for (let j = 0; j < 6; j += 2) (k.points[j] += dx), (k.points[j + 1] += dy);
  });
}
export function transformMask(m: VectorMask, a: number, b: number, c: number, d: number, e: number, f: number) {
  for (const p of m.paths)
    for (const k of p.knots)
      for (let j = 0; j < 6; j += 2) {
        const x = k.points[j], y = k.points[j + 1];
        k.points[j] = a * x + c * y + e;
        k.points[j + 1] = b * x + d * y + f;
      }
}
/** Retain finite, non-empty subpaths only (closed paths need two anchors). */
export function cleanMask(m: VectorMask) {
  m.paths = m.paths.filter((p) => p.knots.length > (p.open ? 0 : 1));
  // A leading continuation contour would silently join the previous component.
  if (m.paths.length && !m.paths[0].operation) m.paths[0].operation = 'combine';
  return m;
}

// ----- Segments -----
export type Cubic = [Pt, Pt, Pt, Pt];
export const segmentCount = (p: SubPath) => (p.knots.length < 2 ? 0 : p.open ? p.knots.length - 1 : p.knots.length);
export function segment(p: SubPath, i: number): Cubic {
  const a = p.knots[i], b = p.knots[(i + 1) % p.knots.length];
  return [anchor(a), outHandle(a), inHandle(b), anchor(b)];
}
export const isLine = (c: Cubic) =>
  c[1][0] === c[0][0] && c[1][1] === c[0][1] && c[2][0] === c[3][0] && c[2][1] === c[3][1];
export function cubicAt(c: Cubic, t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}
const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** de Casteljau split of a cubic at t. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const ab = lerp(c[0], c[1], t), bc = lerp(c[1], c[2], t), cd = lerp(c[2], c[3], t);
  const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t), m = lerp(abc, bcd, t);
  return [[c[0], ab, abc, m], [m, bcd, cd, c[3]]];
}
/** Insert an anchor on segment `i` at parameter `t`, keeping the curve shape. */
export function insertKnot(p: SubPath, i: number, t: number): number {
  const c = segment(p, i);
  const a = p.knots[i], b = p.knots[(i + 1) % p.knots.length];
  if (isLine(c)) {
    const m = cubicAt(c, t);
    p.knots.splice(i + 1, 0, corner(m[0], m[1]));
    return i + 1;
  }
  const [l, r] = splitCubic(c, t);
  a.points[4] = l[1][0];
  a.points[5] = l[1][1];
  b.points[0] = r[2][0];
  b.points[1] = r[2][1];
  p.knots.splice(i + 1, 0, knot(l[3][0], l[3][1], l[2][0], l[2][1], r[1][0], r[1][1], true));
  return i + 1;
}
/** Flatten a subpath into a polyline with roughly `tol` px chords. */
export function flatten(p: SubPath, tol = 0.5): Pt[] {
  const out: Pt[] = [];
  if (!p.knots.length) return out;
  out.push(anchor(p.knots[0]));
  for (let i = 0; i < segmentCount(p); i++) {
    const c = segment(p, i);
    if (isLine(c)) {
      out.push(c[3]);
      continue;
    }
    const len = dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]);
    const n = Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / tol) * 2)));
    for (let s = 1; s <= n; s++) out.push(cubicAt(c, s / n));
  }
  if (!p.open && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) out.pop();
  }
  return out;
}
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ----- Hit testing -----
export type KnotRef = { path: number; knot: number };
export function hitAnchor(m: VectorMask, x: number, y: number, tol: number, paths?: Set<number>): KnotRef | undefined {
  let best: KnotRef | undefined, bestD = tol;
  m.paths.forEach((p, pi) => {
    if (paths && !paths.has(pi)) return;
    p.knots.forEach((k, ki) => {
      const d = Math.hypot(k.points[2] - x, k.points[3] - y);
      if (d <= bestD) (bestD = d), (best = { path: pi, knot: ki });
    });
  });
  return best;
}
export type HandleRef = KnotRef & { side: 'in' | 'out' };
export function hitHandle(m: VectorMask, x: number, y: number, tol: number, knots: KnotRef[]): HandleRef | undefined {
  let best: HandleRef | undefined, bestD = tol;
  for (const r of knots) {
    const k = m.paths[r.path]?.knots[r.knot];
    if (!k) continue;
    for (const side of ['in', 'out'] as const) {
      if (side === 'in' ? !hasIn(k) : !hasOut(k)) continue;
      const o = side === 'in' ? 0 : 4;
      const d = Math.hypot(k.points[o] - x, k.points[o + 1] - y);
      if (d <= bestD) (bestD = d), (best = { ...r, side });
    }
  }
  return best;
}
export type SegmentHit = { path: number; segment: number; t: number; point: Pt; distance: number };
/** Closest point on any segment (sampled, then refined by bisection). */
export function nearestSegment(m: VectorMask, x: number, y: number, paths?: Set<number>): SegmentHit | undefined {
  let best: SegmentHit | undefined;
  let bestD = Infinity;
  // Scalar cubic evaluation keeps hover hit testing allocation-free.
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0;
  const distAt = (t: number) => {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return Math.hypot(a * x0 + b * x1 + c * x2 + d * x3 - x, a * y0 + b * y1 + c * y2 + d * y3 - y);
  };
  for (let pi = 0; pi < m.paths.length; pi++) {
    if (paths && !paths.has(pi)) continue;
    const p = m.paths[pi], n = p.knots.length, count = segmentCount(p);
    for (let i = 0; i < count; i++) {
      const ka = p.knots[i].points, kb = p.knots[(i + 1) % n].points;
      x0 = ka[2]; y0 = ka[3]; x1 = ka[4]; y1 = ka[5]; x2 = kb[0]; y2 = kb[1]; x3 = kb[2]; y3 = kb[3];
      // The curve lies inside its control polygon's box: skip boxes farther than the best hit.
      const bx = Math.max(Math.min(x0, x1, x2, x3) - x, 0, x - Math.max(x0, x1, x2, x3));
      const by = Math.max(Math.min(y0, y1, y2, y3) - y, 0, y - Math.max(y0, y1, y2, y3));
      if (Math.hypot(bx, by) >= bestD) continue;
      let bt = 0, bd = Infinity;
      const line = x1 === x0 && y1 === y0 && x2 === x3 && y2 === y3;
      if (line) {
        // Project onto the chord. A straight cubic is not evenly parameterized
        // (its position follows 3t² - 2t³), so convert the chord fraction back
        // to the curve parameter that reaches the same point.
        const dx = x3 - x0, dy = y3 - y0, l2 = dx * dx + dy * dy;
        const f = l2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
        bt = 0.5 - Math.sin(Math.asin(1 - 2 * f) / 3);
        bd = Math.hypot(x0 + dx * f - x, y0 + dy * f - y);
      } else {
        const steps = 24;
        for (let k = 0; k <= steps; k++) {
          const d = distAt(k / steps);
          if (d < bd) (bd = d), (bt = k / steps);
        }
        if (bd - Math.hypot(x3 - x0, y3 - y0) / steps >= bestD) continue;
        let lo = Math.max(0, bt - 1 / steps), hi = Math.min(1, bt + 1 / steps);
        for (let k = 0; k < 20; k++) {
          const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
          if (distAt(a) < distAt(b)) hi = b;
          else lo = a;
        }
        bt = (lo + hi) / 2;
        bd = distAt(bt);
      }
      if (bd < bestD) {
        bestD = bd;
        best = { path: pi, segment: i, t: bt, point: cubicAt(segment(p, i), bt), distance: bd };
      }
    }
  }
  return best;
}
/** Subpath indices grouped by boolean component (continuation contours join their component). */
export function componentGroups(m: VectorMask): number[][] {
  const groups: number[][] = [];
  m.paths.forEach((p, i) => {
    if (p.operation === undefined && groups.length) groups[groups.length - 1].push(i);
    else groups.push([i]);
  });
  return groups;
}
export function componentOf(m: VectorMask, path: number): number[] {
  return componentGroups(m).find((g) => g.includes(path)) ?? [path];
}
function windingContains(poly: Pt[], x: number, y: number, rule: SubPath['fillRule']) {
  let wind = 0, crossings = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yj <= y !== yi <= y) {
      const xc = xj + ((y - yj) / (yi - yj)) * (xi - xj);
      if (xc > x) {
        crossings++;
        wind += yi > yj ? 1 : -1;
      }
    }
  }
  return rule === 'even-odd' ? crossings % 2 === 1 : wind !== 0;
}
/** Index of the topmost subpath whose component's filled area contains (x, y). */
export function componentAt(m: VectorMask, x: number, y: number): number | undefined {
  const groups = componentGroups(m);
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g];
    const rule = m.paths[group[0]].fillRule;
    const box = vectorBoundsOfControls(group.map((i) => m.paths[i]));
    if (!box || x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    // A component fills as one compound contour under its own fill rule.
    let wind = 0, crossings = 0;
    for (const i of group) {
      const poly = flatten(m.paths[i], 1);
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
        const [xi, yi] = poly[a], [xj, yj] = poly[b];
        if (yj <= y !== yi <= y && xj + ((y - yj) / (yi - yj)) * (xi - xj) > x) {
          crossings++;
          wind += yi > yj ? 1 : -1;
        }
      }
    }
    if (rule === 'even-odd' ? crossings % 2 === 1 : wind !== 0) return group[0];
  }
  return undefined;
}
export { windingContains };
function vectorBoundsOfControls(paths: SubPath[]): [number, number, number, number] | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths)
    for (const k of p.knots)
      for (let i = 0; i < 6; i += 2) {
        const x = k.points[i], y = k.points[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x0 <= x1 ? [x0, y0, x1, y1] : undefined;
}

// ----- Path data conversion -----
/** Subpaths from absolute move/line/cubic/quadratic/close commands. */
export function commandsToPaths(cmds: Cmd[], fillRule: SubPath['fillRule'] = 'non-zero', operation: PathOp = 'combine', compound = true): SubPath[] {
  const paths: SubPath[] = [];
  let knots: Knot[] = [];
  let start: Pt = [0, 0];
  const flush = (closed: boolean) => {
    if (closed && knots.length > 1) {
      const first = knots[0], last = knots[knots.length - 1];
      if (Math.abs(first.points[2] - last.points[2]) < 1e-9 && Math.abs(first.points[3] - last.points[3]) < 1e-9) {
        first.points[0] = last.points[0];
        first.points[1] = last.points[1];
        knots.pop();
      }
    }
    if (knots.length > (closed ? 1 : 1)) {
      for (const k of knots) k.linked = smoothKnot(k);
      paths.push({ open: !closed, fillRule, ...(paths.length && compound ? {} : { operation }), knots });
    }
    knots = [];
  };
  const last = () => knots[knots.length - 1];
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        flush(false);
        start = [c[1], c[2]];
        knots.push(corner(c[1], c[2]));
        break;
      case 'L':
        if (!knots.length) knots.push(corner(...start));
        knots.push(corner(c[1], c[2]));
        break;
      case 'C': {
        if (!knots.length) knots.push(corner(...start));
        const l = last();
        l.points[4] = c[1];
        l.points[5] = c[2];
        knots.push({ linked: false, points: [c[3], c[4], c[5], c[6], c[5], c[6]] });
        break;
      }
      case 'Q': {
        if (!knots.length) knots.push(corner(...start));
        const l = last(), p0 = anchor(l);
        l.points[4] = p0[0] + ((c[1] - p0[0]) * 2) / 3;
        l.points[5] = p0[1] + ((c[2] - p0[1]) * 2) / 3;
        knots.push({ linked: false, points: [c[3] + ((c[1] - c[3]) * 2) / 3, c[4] + ((c[2] - c[4]) * 2) / 3, c[3], c[4], c[3], c[4]] });
        break;
      }
      case 'Z': {
        const first = knots[0];
        flush(true);
        if (first) start = anchor(first);
        break;
      }
    }
  }
  flush(false);
  return paths;
}
/** Parse absolute (and relative) SVG path data: M L H V C S Q T Z. Arcs are not supported. */
export function parseSvgPath(d: string): Cmd[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Cmd[] = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  let lastCtrl: Pt | undefined, lastQ: Pt | undefined;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num(); y = oy + num(); sx = x; sy = y;
        out.push(['M', x, y]);
        cmd = rel ? 'l' : 'L';
        lastCtrl = lastQ = undefined;
        break;
      case 'L':
        x = ox + num(); y = oy + num();
        out.push(['L', x, y]);
        lastCtrl = lastQ = undefined;
        break;
      case 'H':
        x = ox + num();
        out.push(['L', x, y]);
        lastCtrl = lastQ = undefined;
        break;
      case 'V':
        y = oy + num();
        out.push(['L', x, y]);
        lastCtrl = lastQ = undefined;
        break;
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        out.push(['C', x1, y1, x2, y2, x, y]);
        lastCtrl = [x2, y2];
        lastQ = undefined;
        break;
      }
      case 'S': {
        const x1 = lastCtrl ? 2 * x - lastCtrl[0] : x, y1 = lastCtrl ? 2 * y - lastCtrl[1] : y;
        const x2 = ox + num(), y2 = oy + num();
        x = ox + num(); y = oy + num();
        out.push(['C', x1, y1, x2, y2, x, y]);
        lastCtrl = [x2, y2];
        lastQ = undefined;
        break;
      }
      case 'Q': {
        const x1 = ox + num(), y1 = oy + num();
        x = ox + num(); y = oy + num();
        out.push(['Q', x1, y1, x, y]);
        lastQ = [x1, y1];
        lastCtrl = undefined;
        break;
      }
      case 'T': {
        const q: Pt = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        x = ox + num(); y = oy + num();
        out.push(['Q', q[0], q[1], x, y]);
        lastQ = q;
        lastCtrl = undefined;
        break;
      }
      case 'Z':
        out.push(['Z']);
        x = sx; y = sy;
        lastCtrl = lastQ = undefined;
        break;
      default:
        i++;
    }
  }
  return out.filter((c) => c.every((v) => typeof v === 'string' || Number.isFinite(v)));
}
/** SVG path data for display (document units). */
export function maskToSvg(m: VectorMask, only?: Set<number>): string {
  let d = '';
  m.paths.forEach((p, pi) => {
    if (only && !only.has(pi)) return;
    if (!p.knots.length) return;
    const a0 = anchor(p.knots[0]);
    d += `M${r(a0[0])} ${r(a0[1])}`;
    for (let i = 0; i < segmentCount(p); i++) {
      const c = segment(p, i);
      d += isLine(c) ? `L${r(c[3][0])} ${r(c[3][1])}` : `C${r(c[1][0])} ${r(c[1][1])} ${r(c[2][0])} ${r(c[2][1])} ${r(c[3][0])} ${r(c[3][1])}`;
    }
    if (!p.open) d += 'Z';
  });
  return d;
}
const r = (n: number) => Math.round(n * 1000) / 1000;

// ----- Shape builders -----
/** Closed polygon with optional rounded vertices (circular arcs as cubics). */
export function roundedPolygon(vertices: Pt[], radii: number[] | number, clamp = true): Knot[] {
  const n = vertices.length;
  const out: Knot[] = [];
  for (let i = 0; i < n; i++) {
    const v = vertices[i], prev = vertices[(i + n - 1) % n], next = vertices[(i + 1) % n];
    const want = Array.isArray(radii) ? radii[i] : radii;
    const l1 = dist(prev, v), l2 = dist(next, v);
    if (!(want > 0) || l1 === 0 || l2 === 0) {
      out.push(corner(v[0], v[1]));
      continue;
    }
    const u1: Pt = [(prev[0] - v[0]) / l1, (prev[1] - v[1]) / l1], u2: Pt = [(next[0] - v[0]) / l2, (next[1] - v[1]) / l2];
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1]));
    const theta = Math.acos(cos);
    if (theta < 1e-6 || Math.PI - theta < 1e-6) {
      out.push(corner(v[0], v[1]));
      continue;
    }
    let d = want / Math.tan(theta / 2);
    if (clamp) d = Math.min(d, l1 / 2, l2 / 2);
    else d = Math.min(d, l1, l2);
    const radius = d * Math.tan(theta / 2);
    const h = (4 / 3) * Math.tan((Math.PI - theta) / 4) * radius;
    const a: Pt = [v[0] + u1[0] * d, v[1] + u1[1] * d], b: Pt = [v[0] + u2[0] * d, v[1] + u2[1] * d];
    out.push({ linked: true, points: [a[0], a[1], a[0], a[1], a[0] - u1[0] * h, a[1] - u1[1] * h] });
    out.push({ linked: true, points: [b[0] - u2[0] * h, b[1] - u2[1] * h, b[0], b[1], b[0], b[1]] });
  }
  // Coincident tangent points (full-side radii) merge into one smooth knot.
  for (let i = 0; i < out.length && out.length > 2; i++) {
    const a = out[i], b = out[(i + 1) % out.length];
    if (Math.abs(a.points[2] - b.points[2]) < 1e-9 && Math.abs(a.points[3] - b.points[3]) < 1e-9 && !hasOut(a) && !hasIn(b)) {
      a.points[4] = b.points[4];
      a.points[5] = b.points[5];
      a.linked = smoothKnot(a) || (hasIn(a) && hasOut(a));
      out.splice((i + 1) % out.length, 1);
      i--;
    }
  }
  return out;
}
/** CSS-style radius scaling so adjacent corner radii never overlap. */
export function fitRadii(w: number, h: number, radii: [number, number, number, number]): [number, number, number, number] {
  const [tl, tr, br, bl] = radii.map((v) => Math.max(0, v || 0));
  const q = (side: number, sum: number) => (sum > 0 ? side / sum : Infinity);
  const f = Math.min(1, q(w, tl + tr), q(w, bl + br), q(h, tl + bl), q(h, tr + br));
  return [tl * f, tr * f, br * f, bl * f];
}
export function rectKnots(x: number, y: number, w: number, h: number, radii: [number, number, number, number] = [0, 0, 0, 0]): Knot[] {
  const rr = fitRadii(w, h, radii);
  return roundedPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], rr, false);
}
export function ellipseKnots(x: number, y: number, w: number, h: number): Knot[] {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    knot(cx, y, cx - kx, y, cx + kx, y, true),
    knot(x + w, cy, x + w, cy - ky, x + w, cy + ky, true),
    knot(cx, y + h, cx + kx, y + h, cx - kx, y + h, true),
    knot(x, cy, x, cy + ky, x, cy - ky, true),
  ];
}
export function triangleKnots(x: number, y: number, w: number, h: number, radius = 0): Knot[] {
  return roundedPolygon([[x + w / 2, y], [x + w, y + h], [x, y + h]], radius);
}
/** Regular polygon or star fitted to a box. `star` is the inset (0 = polygon). */
export function polygonKnots(x: number, y: number, w: number, h: number, sides: number, star = 0, radius = 0, smoothIndents = false): Knot[] {
  const n = Math.max(3, Math.min(100, Math.round(sides)));
  const pts: Pt[] = [];
  const count = star > 0 ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    const rr = star > 0 && i % 2 ? 1 - star : 1;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const fitted = pts.map(([px, py]) => [x + ((px - minX) / (maxX - minX)) * w, y + ((py - minY) / (maxY - minY)) * h] as Pt);
  const radii = fitted.map((_, i) => (star > 0 && i % 2 && !smoothIndents ? 0 : radius));
  return roundedPolygon(fitted, radii);
}
/** Filled outline of a straight line of `weight` px with optional arrowheads.
 * Arrow width/length are multiples of the weight; concavity in [-0.5, 0.5]. */
export function lineKnots(x1: number, y1: number, x2: number, y2: number, weight: number, opts: { start?: boolean; end?: boolean; width?: number; length?: number; concavity?: number } = {}): Knot[] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const w = Math.max(0.01, weight) / 2;
  const u: Pt = len ? [(x2 - x1) / len, (y2 - y1) / len] : [1, 0], nrm: Pt = [-u[1], u[0]];
  const aw = Math.max(w, (Math.max(1, opts.width ?? 5) * weight) / 2);
  let al = Math.max(0.01, (opts.length ?? 10) * weight);
  const conc = Math.max(-0.5, Math.min(0.5, opts.concavity ?? 0));
  const both = (opts.start ? 1 : 0) + (opts.end ? 1 : 0);
  if (both) al = Math.min(al, len / both);
  const at = (t: number, side: number): Pt => [x1 + u[0] * t + nrm[0] * side, y1 + u[1] * t + nrm[1] * side];
  const pts: Pt[] = [];
  // Left side from start to end, then right side back.
  if (opts.start) pts.push(at(0, 0), at(al, aw), at(al * (1 - conc), w));
  else pts.push(at(0, w));
  if (opts.end) pts.push(at(len - al * (1 - conc), w), at(len - al, aw), at(len, 0), at(len - al, -aw), at(len - al * (1 - conc), -w));
  else pts.push(at(len, w), at(len, -w));
  if (opts.start) pts.push(at(al * (1 - conc), -w), at(al, -aw));
  else pts.push(at(0, -w));
  return dedupe(pts).map(([px, py]) => corner(px, py));
}
function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return i === 0 ? dist(p, pts[pts.length - 1]) > 1e-9 : dist(p, q) > 1e-9;
  });
}
/** Knots for a live shape. */
export function liveKnots(s: LiveShape): Knot[] {
  switch (s.kind) {
    case 'rect': return rectKnots(s.x, s.y, s.width, s.height, s.radii);
    case 'ellipse': return ellipseKnots(s.x, s.y, s.width, s.height);
    case 'triangle': return triangleKnots(s.x, s.y, s.width, s.height, s.radius);
    case 'polygon': return polygonKnots(s.x, s.y, s.width, s.height, s.sides, s.star, s.radius, s.smoothIndents);
    case 'line': return lineKnots(s.x1, s.y1, s.x2, s.y2, s.weight, { start: s.arrowStart, end: s.arrowEnd, width: s.arrowWidth, length: s.arrowLength, concavity: s.concavity });
  }
}
/** Map a live shape through x' = a*x + e, y' = d*y + f (axis-aligned scale and move). */
export function scaleLive(s: LiveShape, a: number, d: number, e: number, f: number): LiveShape {
  if (s.kind === 'line') return { ...s, x1: a * s.x1 + e, y1: d * s.y1 + f, x2: a * s.x2 + e, y2: d * s.y2 + f };
  const x0 = a * s.x + e, x1 = a * (s.x + s.width) + e, y0 = d * s.y + f, y1 = d * (s.y + s.height) + f;
  return { ...s, x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

// ----- Curve fitting (Schneider, "An Algorithm for Automatically Fitting
// Digitized Curves", Graphics Gems, 1990), with corner splitting. -----
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Pt): Pt => {
  const l = Math.hypot(a[0], a[1]);
  return l ? [a[0] / l, a[1] / l] : [0, 0];
};
function chordParams(pts: Pt[], first: number, last: number) {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}
function generateBezier(pts: Pt[], first: number, last: number, u: number[], t1: Pt, t2: Pt): Cubic {
  const p0x = pts[first][0], p0y = pts[first][1], p3x = pts[last][0], p3y = pts[last][1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const b1 = 3 * s * s * t, b2 = 3 * s * t * t, b0 = s * s * s + b1, b3 = b2 + t * t * t;
    const a1x = t1[0] * b1, a1y = t1[1] * b1, a2x = t2[0] * b2, a2y = t2[1] * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const q = pts[first + i];
    const tx = q[0] - (p0x * b0 + p3x * b3), ty = q[1] - (p0y * b0 + p3y * b3);
    x0 += a1x * tx + a1y * ty;
    x1 += a2x * tx + a2y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det ? (x0 * c11 - x1 * c01) / det : 0, alpha2 = det ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = Math.hypot(p3x - p0x, p3y - p0y), eps = 1e-6 * segLen;
  if (alpha1 < eps || alpha2 < eps) alpha1 = alpha2 = segLen / 3;
  return [[p0x, p0y], [p0x + t1[0] * alpha1, p0y + t1[1] * alpha1], [p3x + t2[0] * alpha2, p3y + t2[1] * alpha2], [p3x, p3y]];
}
function maxError(pts: Pt[], first: number, last: number, c: Cubic, u: number[]) {
  let max = 0, split = Math.floor((first + last) / 2);
  const [[ax, ay], [bx, by], [cx, cy], [dx, dy]] = c;
  for (let i = first + 1; i < last; i++) {
    const t = u[i - first], s = 1 - t, w0 = s * s * s, w1 = 3 * s * s * t, w2 = 3 * s * t * t, w3 = t * t * t;
    const ex = w0 * ax + w1 * bx + w2 * cx + w3 * dx - pts[i][0], ey = w0 * ay + w1 * by + w2 * cy + w3 * dy - pts[i][1];
    const d = ex * ex + ey * ey;
    if (d >= max) (max = d), (split = i);
  }
  return { max, split };
}
function newtonRoot(c: Cubic, p: Pt, t: number) {
  const [[ax, ay], [bx, by], [cx, cy], [dx, dy]] = c;
  const s = 1 - t;
  const qx = s * s * s * ax + 3 * s * s * t * bx + 3 * s * t * t * cx + t * t * t * dx - p[0];
  const qy = s * s * s * ay + 3 * s * s * t * by + 3 * s * t * t * cy + t * t * t * dy - p[1];
  const d0x = 3 * (bx - ax), d0y = 3 * (by - ay), d1x = 3 * (cx - bx), d1y = 3 * (cy - by), d2x = 3 * (dx - cx), d2y = 3 * (dy - cy);
  const q1x = d0x * s * s + 2 * d1x * s * t + d2x * t * t, q1y = d0y * s * s + 2 * d1y * s * t + d2y * t * t;
  const q2x = 2 * (d1x - d0x) * s + 2 * (d2x - d1x) * t, q2y = 2 * (d1y - d0y) * s + 2 * (d2y - d1y) * t;
  const num = qx * q1x + qy * q1y, den = q1x * q1x + q1y * q1y + qx * q2x + qy * q2y;
  return den ? t - num / den : t;
}
function fitCubic(pts: Pt[], first: number, last: number, t1: Pt, t2: Pt, err2: number, out: Cubic[], depth = 0) {
  if (last - first === 1) {
    const d = dist(pts[first], pts[last]) / 3;
    out.push([pts[first], add(pts[first], mul(t1, d)), add(pts[last], mul(t2, d)), pts[last]]);
    return;
  }
  let u = chordParams(pts, first, last);
  let c = generateBezier(pts, first, last, u, t1, t2);
  let { max, split } = maxError(pts, first, last, c, u);
  if (max < err2) {
    out.push(c);
    return;
  }
  if (max < err2 * 4) {
    for (let it = 0; it < 6; it++) {
      u = u.map((t, i) => Math.max(0, Math.min(1, newtonRoot(c, pts[first + i], t))));
      c = generateBezier(pts, first, last, u, t1, t2);
      ({ max, split } = maxError(pts, first, last, c, u));
      if (max < err2) {
        out.push(c);
        return;
      }
    }
  }
  if (depth > 40) {
    out.push(c);
    return;
  }
  split = Math.max(first + 1, Math.min(last - 1, split));
  const center = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts, first, split, t1, center, err2, out, depth + 1);
  fitCubic(pts, split, last, mul(center, -1), t2, err2, out, depth + 1);
}
/** Resample a polyline to roughly uniform spacing (keeps endpoints). */
export function resample(pts: Pt[], spacing: number, closed = false): Pt[] {
  if (pts.length < 2) return pts.slice();
  const src = closed ? [...pts, pts[0]] : pts;
  const out: Pt[] = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i], l = dist(a, b);
    let t = spacing - carry;
    while (t <= l) {
      out.push(lerp(a, b, t / l));
      t += spacing;
    }
    carry = l - (t - spacing);
  }
  if (!closed && dist(out[out.length - 1], src[src.length - 1]) > 1e-9) out.push(src[src.length - 1]);
  if (closed && out.length > 1 && dist(out[out.length - 1], out[0]) < spacing * 0.5) out.pop();
  return out;
}
/** Indices of corners: local maxima of the turning angle over a +/- `window` neighbourhood. */
export function findCorners(pts: Pt[], closed: boolean, window: number, threshold = (60 * Math.PI) / 180): number[] {
  const n = pts.length, turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!closed && (i < window || i >= n - window)) continue;
    const a = pts[(i - window + n) % n], b = pts[i], c = pts[(i + window) % n];
    const d1 = norm(sub(b, a)), d2 = norm(sub(c, b));
    turn[i] = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < threshold) continue;
    let peak = true;
    for (let k = 1; k <= window && peak; k++) {
      const l = closed ? (i - k + n) % n : i - k, r = closed ? (i + k) % n : i + k;
      if ((l >= 0 && turn[l] > turn[i]) || (r < n && turn[r] >= turn[i])) peak = false;
    }
    if (peak) corners.push(i);
  }
  return corners;
}
function smoothRun(pts: Pt[], passes: number): Pt[] {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const next = cur.slice();
    for (let i = 1; i < cur.length - 1; i++) next[i] = [(cur[i - 1][0] + 2 * cur[i][0] + cur[i + 1][0]) / 4, (cur[i - 1][1] + 2 * cur[i][1] + cur[i + 1][1]) / 4];
    cur = next;
  }
  return cur;
}
/** Fit cubic knots to a digitized polyline. Corners become cusp knots; the
 * joins between fitted pieces are smooth. `tolerance` is in pixels. */
export function fitPath(input: Pt[], tolerance: number, closed: boolean, opts: { spacing?: number; smooth?: number; cornerWindow?: number } = {}): SubPath | undefined {
  // Sample no finer than the tolerance needs; long traces stay cheap to fit.
  const spacing = Math.max(opts.spacing ?? 1, Math.min(tolerance / 2, 2));
  let pts = resample(input.filter((p, i) => i === 0 || dist(p, input[i - 1]) > 1e-9), spacing, closed);
  if (pts.length < 2) return;
  const err2 = Math.max(0.05, tolerance) ** 2;
  const window = Math.max(2, opts.cornerWindow ?? Math.round(3 / spacing));
  let corners = pts.length > 2 * window + 1 ? findCorners(pts, closed, window) : [];
  if (closed) {
    // Start a closed loop at a corner so every run has fixed endpoints.
    const shift = corners.length ? corners[0] : 0;
    pts = [...pts.slice(shift), ...pts.slice(0, shift)];
    corners = corners.map((c) => (c - shift + pts.length) % pts.length).sort((a, b) => a - b);
    if (!corners.length || corners[0] !== 0) corners.unshift(0);
    pts = [...pts, pts[0]];
    corners.push(pts.length - 1);
  } else corners = [0, ...corners.filter((c) => c > 0 && c < pts.length - 1), pts.length - 1];
  const smoothCorners = closed && corners.length === 2;
  const knots: Knot[] = [];
  for (let r = 0; r + 1 < corners.length; r++) {
    let run = pts.slice(corners[r], corners[r + 1] + 1);
    if (run.length < 2) continue;
    run = smoothRun(run, opts.smooth ?? 2);
    const n = run.length;
    // End tangents from a few pixels of the run, so pointer jitter at the ends is ignored.
    const reach = Math.max(2, Math.round(4 / spacing));
    let t1 = norm(sub(run[Math.min(n - 1, reach)], run[0])), t2 = norm(sub(run[Math.max(0, n - 1 - reach)], run[n - 1]));
    if (smoothCorners) {
      // A loop without corners: the seam is smooth too.
      const seam = norm(sub(run[1], run[n - 2]));
      t1 = seam;
      t2 = mul(seam, -1);
    }
    const cubics: Cubic[] = [];
    fitCubic(run, 0, n - 1, t1, t2, err2, cubics);
    for (let i = 0; i < cubics.length; i++) {
      const c = cubics[i];
      if (!knots.length) knots.push({ linked: false, points: [c[0][0], c[0][1], c[0][0], c[0][1], c[1][0], c[1][1]] });
      else {
        const k = knots[knots.length - 1];
        k.points[4] = c[1][0];
        k.points[5] = c[1][1];
        k.linked = i > 0 || smoothCorners ? smoothKnot(k) : false;
      }
      knots.push({ linked: false, points: [c[2][0], c[2][1], c[3][0], c[3][1], c[3][0], c[3][1]] });
    }
  }
  if (!knots.length) return;
  if (closed && knots.length > 1) {
    const last = knots.pop()!, first = knots[0];
    first.points[0] = last.points[0];
    first.points[1] = last.points[1];
    first.linked = smoothCorners ? smoothKnot(first) : false;
  }
  // Collapse handles of straight runs so they export as lines.
  const p: SubPath = { open: !closed, fillRule: 'non-zero', operation: 'combine', knots };
  for (let i = 0; i < segmentCount(p); i++) straighten(p, i, tolerance);
  return p;
}
/** Replace a cubic whose controls lie within `tol` of its chord by a line. */
function straighten(p: SubPath, i: number, tol: number) {
  const c = segment(p, i);
  const [a, , , b] = c, l = dist(a, b);
  if (!l) return;
  const off = (q: Pt) => Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / l;
  const along = (q: Pt) => ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / (l * l);
  const k1 = p.knots[i], k2 = p.knots[(i + 1) % p.knots.length];
  // Only runs between corners become lines; inside a smooth run that would add kinks.
  if (k1.linked || k2.linked) return;
  if (off(c[1]) < tol * 0.25 && off(c[2]) < tol * 0.25 && along(c[1]) >= 0 && along(c[2]) <= 1) {
    k1.points[4] = k1.points[2];
    k1.points[5] = k1.points[3];
    k2.points[0] = k2.points[2];
    k2.points[1] = k2.points[3];
    k1.linked = smoothKnot(k1);
    k2.linked = smoothKnot(k2);
  }
}

// ----- Curvature pen: handles that pass smoothly through the anchors -----
export function autoSmooth(p: SubPath, only?: Set<number>) {
  const n = p.knots.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const k = p.knots[i];
    if (only && !only.has(i)) continue;
    if (k.linked === false && !only) continue;
    const P = anchor(k);
    const hasPrev = !p.open || i > 0, hasNext = !p.open || i < n - 1;
    const prev = hasPrev ? anchor(p.knots[(i - 1 + n) % n]) : undefined;
    const next = hasNext ? anchor(p.knots[(i + 1) % n]) : undefined;
    let dir: Pt;
    if (prev && next) dir = norm(sub(next, prev));
    else if (next) dir = norm(sub(next, P));
    else dir = norm(sub(P, prev!));
    const li = prev ? dist(P, prev) / 3 : 0, lo = next ? dist(P, next) / 3 : 0;
    // Open endpoints aim at the neighbour's incoming tangent for a natural end.
    if (p.open && (i === 0 || i === n - 1) && n > 2) {
      const nb = i === 0 ? p.knots[1] : p.knots[n - 2];
      const target = i === 0 ? inHandle(nb) : outHandle(nb);
      dir = i === 0 ? norm(sub(target, P)) : norm(sub(P, target));
    }
    k.points[0] = P[0] - dir[0] * li;
    k.points[1] = P[1] - dir[1] * li;
    k.points[4] = P[0] + dir[0] * lo;
    k.points[5] = P[1] + dir[1] * lo;
    k.linked = true;
  }
}

/** Snap b to the nearest 45 degree direction from a. */
export function snap45(a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [a[0] + Math.cos(angle) * len, a[1] + Math.sin(angle) * len];
}
/** Reverse a subpath's direction (swapping in/out handles). */
export function reverseSubPath(p: SubPath) {
  p.knots.reverse();
  for (const k of p.knots) {
    const [ix, iy, , , ox, oy] = k.points;
    k.points[0] = ox;
    k.points[1] = oy;
    k.points[4] = ix;
    k.points[5] = iy;
  }
}
/** Reshape a curved segment so the point at parameter t follows a drag of (dx, dy).
 * Weights follow the common "drag a curve" construction used by vector editors. */
export function dragSegment(c: Cubic, t: number, dx: number, dy: number): [Pt, Pt] {
  t = Math.max(0.01, Math.min(0.99, t));
  let w: number;
  if (t <= 1 / 6) w = 0;
  else if (t <= 0.5) w = Math.pow((6 * t - 1) / 2, 3) / 2;
  else if (t <= 5 / 6) w = (1 - Math.pow((6 * (1 - t) - 1) / 2, 3)) / 2 + 0.5;
  else w = 1;
  const s = 1 - t;
  const k1 = (1 - w) / (3 * t * s * s), k2 = w / (3 * t * t * s);
  return [[c[1][0] + dx * k1, c[1][1] + dy * k1], [c[2][0] + dx * k2, c[2][1] + dy * k2]];
}
/** Delete knots; subpaths left with fewer than two anchors are removed. */
export function deleteKnots(m: VectorMask, refs: KnotRef[]) {
  const byPath = new Map<number, Set<number>>();
  for (const r of refs) {
    if (!byPath.has(r.path)) byPath.set(r.path, new Set());
    byPath.get(r.path)!.add(r.knot);
  }
  for (const [pi, ks] of byPath) {
    const p = m.paths[pi];
    if (p) p.knots = p.knots.filter((_, i) => !ks.has(i));
  }
  const keep = m.paths.map((p) => p.knots.length >= 2);
  // When a component's first contour disappears, its operation moves to the next.
  m.paths.forEach((p, i) => {
    if (!keep[i] && p.operation && m.paths[i + 1] && !m.paths[i + 1].operation) m.paths[i + 1].operation = p.operation;
  });
  m.paths = m.paths.filter((_, i) => keep[i]);
  return cleanMask(m);
}
