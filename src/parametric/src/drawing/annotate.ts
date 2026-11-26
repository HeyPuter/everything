// Drawing annotations: dimensions measured from the model edges a view shows (which follow
// the model as it changes), centre marks and centrelines, notes, hole callouts, and the
// marks a section or detail view leaves on its parent. Everything is drawn as display-list
// items in sheet millimetres.

import type { DrawingAnnotation, DrawingDimKind, DrawingDimension, DrawingRef, HoleFeature } from '../model/types';
import { textWidth } from './pdf';
import type { Item } from './sheet';
import { type P2, type Prim, arcOverHalf } from './views';

export const DANGER = '#d32f2f';
const THIN = 0.18;
const ARROW = 2.4, AW = 0.8;
export const DIM_TEXT_SIZE = 3;

/** What a reference points at, in view coordinates. */
export type Geo =
  | { kind: 'point'; p: P2 }
  | { kind: 'line'; a: P2; b: P2 }
  | { kind: 'circle'; c: P2; r: number; full: boolean; a: P2; b: P2; m: P2 };

export function resolveRef(prims: Prim[], ref: DrawingRef): Geo | null {
  for (const p of prims) {
    if (p.edge !== ref.edge) continue;
    if (ref.at === 'start') return { kind: 'point', p: p.a };
    if (ref.at === 'end') return { kind: 'point', p: p.b };
    if (ref.at === 'center') { if (p.kind === 'arc') return { kind: 'point', p: p.c }; continue; }
    if (p.kind === 'line') return { kind: 'line', a: p.a, b: p.b };
    if (p.kind === 'arc') return { kind: 'circle', c: p.c, r: p.r, full: p.full, a: p.a, b: p.b, m: p.m };
  }
  return null;
}

const sub2 = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const len2 = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };
const perp = (a: P2): P2 => [-a[1], a[0]];

/** The measured geometry of a dimension, in view coordinates. */
export type Measured =
  | { kind: 'linear'; p1: P2; p2: P2; u: P2; value: number }
  | { kind: 'radial'; c: P2; r: number; diameter: boolean; value: number }
  | { kind: 'angle'; v: P2; d1: P2; d2: P2; value: number; e1: P2[]; e2: P2[] };

function pointOf(g: Geo): P2 {
  return g.kind === 'point' ? g.p : g.kind === 'circle' ? g.c : [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
}

/** Where the line through p in direction u meets the line through a, b (null when parallel). */
function meet(p: P2, u: P2, a: P2, b: P2): P2 | null {
  const d = sub2(b, a);
  const den = u[0] * d[1] - u[1] * d[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
  return [p[0] + u[0] * t, p[1] + u[1] * t];
}

function foot(p: P2, a: P2, b: P2): P2 {
  const d = unit(sub2(b, a));
  const t = dot2(sub2(p, a), d);
  return [a[0] + d[0] * t, a[1] + d[1] * t];
}

/**
 * The kind of dimension a selection gives, placed at `at`: a circle its diameter (an arc its
 * radius), two lines that meet their angle, else a distance, horizontal or vertical when the
 * value is placed beyond the ends of what it measures (or that is what the geometry is), else
 * aligned with it.
 */
export function guessKind(gs: Geo[], at: P2): DrawingDimKind {
  if (gs.length === 1 && gs[0].kind === 'circle') return gs[0].full || arcOverHalf(gs[0]) ? 'diameter' : 'radius';
  if (gs.length === 2 && gs[0].kind === 'line' && gs[1].kind === 'line') {
    const d1 = unit(sub2(gs[0].b, gs[0].a)), d2 = unit(sub2(gs[1].b, gs[1].a));
    if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-6) return 'angle';
    // Parallel: the distance across them.
    if (Math.abs(d1[1]) < 1e-9) return 'vertical';
    if (Math.abs(d1[0]) < 1e-9) return 'horizontal';
    return 'aligned';
  }
  let p1: P2, p2: P2;
  if (gs.length === 1 && gs[0].kind === 'line') { p1 = gs[0].a; p2 = gs[0].b; }
  else if (gs.length === 2 && (gs[0].kind === 'line' || gs[1].kind === 'line')) {
    const [l, o] = gs[0].kind === 'line' ? [gs[0], gs[1]] : [gs[1] as Extract<Geo, { kind: 'line' }>, gs[0]];
    const d = unit(sub2(l.b, l.a));
    if (Math.abs(d[1]) < 1e-9) return 'vertical';
    if (Math.abs(d[0]) < 1e-9) return 'horizontal';
    p1 = pointOf(o); p2 = foot(p1, l.a, l.b);
  } else if (gs.length === 2) { p1 = pointOf(gs[0]); p2 = pointOf(gs[1]); }
  else return 'aligned';
  const dx = Math.abs(p2[0] - p1[0]), dy = Math.abs(p2[1] - p1[1]);
  if (dy < 1e-9) return 'horizontal';
  if (dx < 1e-9) return 'vertical';
  const inX = at[0] > Math.min(p1[0], p2[0]) && at[0] < Math.max(p1[0], p2[0]);
  const inY = at[1] > Math.min(p1[1], p2[1]) && at[1] < Math.max(p1[1], p2[1]);
  if (inX && !inY) return 'horizontal';
  if (inY && !inX) return 'vertical';
  return 'aligned';
}

/** Measures a dimension of the given kind on the geometry (view coordinates, model millimetres). */
export function measure(kind: DrawingDimKind, gs: Geo[]): Measured | null {
  if (kind === 'radius' || kind === 'diameter') {
    const c = gs.find((g) => g.kind === 'circle') as Extract<Geo, { kind: 'circle' }> | undefined;
    if (!c) return null;
    return { kind: 'radial', c: c.c, r: c.r, diameter: kind === 'diameter', value: kind === 'diameter' ? 2 * c.r : c.r };
  }
  if (kind === 'angle') {
    if (gs.length !== 2 || gs[0].kind !== 'line' || gs[1].kind !== 'line') return null;
    const [l1, l2] = gs as Extract<Geo, { kind: 'line' }>[];
    const d1 = unit(sub2(l1.b, l1.a)), d2 = unit(sub2(l2.b, l2.a));
    const v = meet(l1.a, d1, l2.a, l2.b);
    if (!v) return null;
    return { kind: 'angle', v, d1, d2, value: (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot2(d1, d2))))) * 180) / Math.PI, e1: [l1.a, l1.b], e2: [l2.a, l2.b] };
  }
  const u: P2 | null = kind === 'horizontal' ? [1, 0] : kind === 'vertical' ? [0, 1] : null;
  let p1: P2, p2: P2;
  if (gs.length === 1) {
    const g = gs[0];
    if (g.kind === 'line') { p1 = g.a; p2 = g.b; }
    else if (g.kind === 'circle') {
      // A circle alone measured linearly: its width across.
      const w: P2 = u ?? [1, 0];
      p1 = [g.c[0] - w[0] * g.r, g.c[1] - w[1] * g.r]; p2 = [g.c[0] + w[0] * g.r, g.c[1] + w[1] * g.r];
    } else return null;
  } else if (gs.length === 2) {
    const [g1, g2] = gs;
    if (g1.kind === 'line' && g2.kind === 'line') {
      // Parallel lines: from the middle of the first across to the second.
      p1 = pointOf(g1);
      const dir = u ?? perp(unit(sub2(g1.b, g1.a)));
      p2 = meet(p1, dir, g2.a, g2.b) ?? foot(p1, g2.a, g2.b);
    } else if (g1.kind === 'line' || g2.kind === 'line') {
      const [l, o] = g1.kind === 'line' ? [g1, g2] : [g2 as Extract<Geo, { kind: 'line' }>, g1];
      p1 = pointOf(o);
      if (u) {
        const q = meet(p1, u, l.a, l.b);
        p2 = q ?? foot(p1, l.a, l.b);
      } else p2 = foot(p1, l.a, l.b);
      if (g1.kind === 'line') [p1, p2] = [p2, p1];
    } else { p1 = pointOf(g1); p2 = pointOf(g2); }
  } else return null;
  const dir = u ?? unit(sub2(p2, p1));
  const value = Math.abs(dot2(sub2(p2, p1), dir));
  return { kind: 'linear', p1, p2, u: dir, value };
}

export interface Placement {
  /** View coordinates to sheet. */
  T: (p: P2) => P2;
  s: number;
}

export interface AnnoFormat {
  length: (mm: number, decimals?: number) => string;
  angle: (deg: number, decimals?: number) => string;
}

type Box = [number, number, number, number];
const textBox = (s: string, x: number, y: number, size: number, anchor: 'start' | 'middle' | 'end'): Box => {
  const w = textWidth(s, size);
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return [x0 - 0.5, y - size * 0.8, x0 + w + 0.5, y + size * 0.25];
};

function arrow(items: Item[], tip: P2, dir: P2, color?: string) {
  const d = unit(dir), n = perp(d);
  items.push({ t: 'tri', a: tip, b: [tip[0] - d[0] * ARROW + n[0] * AW, tip[1] - d[1] * ARROW + n[1] * AW], c: [tip[0] - d[0] * ARROW - n[0] * AW, tip[1] - d[1] * ARROW - n[1] * AW], color });
}

const line = (items: Item[], a: P2, b: P2, color?: string, w = THIN, dash?: number[]) =>
  items.push({ t: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, ...(dash ? { dash } : {}) });

/** Readable text rotation (degrees, SVG sense) for text along direction u: never upside down, verticals read upward. */
function readable(u: P2): number {
  let a = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  if (a >= 90 - 1e-9) a -= 180;
  if (a < -90 - 1e-9) a += 180;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

/** Draws a dimension. Returns the box its value takes (for picking), or null when it cannot be measured. */
export function drawDimension(items: Item[], dim: DrawingDimension, m: Measured | null, pl: Placement, fmt: AnnoFormat): Box {
  const at = pl.T(dim.at);
  const pre = dim.prefix ?? '';
  if (!m) {
    // Its geometry is gone: the dimension stays where it was, plainly marked.
    const s = `${pre}${dim.kind === 'diameter' ? 'Ø' : dim.kind === 'radius' ? 'R' : ''}? (missing)`;
    items.push({ t: 'text', s, x: at[0], y: at[1], size: DIM_TEXT_SIZE, anchor: 'middle', color: DANGER });
    return textBox(s, at[0], at[1], DIM_TEXT_SIZE, 'middle');
  }
  if (m.kind === 'radial') {
    const s = `${pre}${m.diameter ? 'Ø' : 'R'}${fmt.length(m.value, dim.decimals)}`;
    const c = pl.T(m.c), r = m.r * pl.s;
    const d = unit(len2(sub2(at, c)) > 1e-9 ? sub2(at, c) : [1, -1]);
    const rim: P2 = [c[0] + d[0] * r, c[1] + d[1] * r];
    const tw = textWidth(s, DIM_TEXT_SIZE);
    if (len2(sub2(at, c)) > r) {
      // Outside: a leader from the value to the circle, arrow pointing at the centre, a short shoulder under the value.
      const right = at[0] >= c[0];
      const shoulder: P2 = [at[0] + (right ? -3 : 3), at[1]];
      line(items, rim, shoulder);
      line(items, shoulder, at);
      arrow(items, rim, sub2(rim, shoulder));
      if (m.diameter) {
        // The other side of a diameter: arrow inward from outside too.
        const far: P2 = [c[0] - d[0] * r, c[1] - d[1] * r];
        line(items, far, [far[0] - d[0] * 4, far[1] - d[1] * 4]);
        arrow(items, far, d);
      }
      const x = right ? at[0] + 0.8 : at[0] - 0.8;
      items.push({ t: 'text', s, x, y: at[1] - 0.8, size: DIM_TEXT_SIZE, anchor: right ? 'start' : 'end' });
      return textBox(s, x, at[1] - 0.8, DIM_TEXT_SIZE, right ? 'start' : 'end');
    }
    // Inside: across the circle (diameter) or from the centre (radius), the value at the point placed.
    const from: P2 = m.diameter ? [c[0] - d[0] * r, c[1] - d[1] * r] : c;
    line(items, from, rim);
    arrow(items, rim, d);
    if (m.diameter) arrow(items, from, [-d[0], -d[1]]);
    items.push({ t: 'text', s, x: at[0], y: at[1] - 0.8, size: DIM_TEXT_SIZE, anchor: 'middle' });
    void tw;
    return textBox(s, at[0], at[1] - 0.8, DIM_TEXT_SIZE, 'middle');
  }
  if (m.kind === 'angle') {
    const s = `${pre}${fmt.angle(m.value, dim.decimals)}`;
    const v = pl.T(m.v);
    const rho = Math.max(len2(sub2(at, v)), 3);
    // The two rays bounding the angle the value was placed in.
    const ta = Math.atan2(at[1] - v[1], at[0] - v[0]);
    const cands = [m.d1, [-m.d1[0], -m.d1[1]] as P2].flatMap((a) => [m.d2, [-m.d2[0], -m.d2[1]] as P2].map((b) => [a, b] as [P2, P2]));
    let best: [number, number] = [0, 0];
    for (const [a, b] of cands) {
      const aa = Math.atan2(a[1], a[0]);
      let sw = Math.atan2(b[1], b[0]) - aa;
      while (sw <= -Math.PI) sw += 2 * Math.PI;
      while (sw > Math.PI) sw -= 2 * Math.PI;
      let rel = ta - aa;
      while (rel <= -Math.PI) rel += 2 * Math.PI;
      while (rel > Math.PI) rel -= 2 * Math.PI;
      if ((sw >= 0 && rel >= 0 && rel <= sw) || (sw < 0 && rel <= 0 && rel >= sw)) { best = [aa, sw]; break; }
    }
    const [a0, sw] = best;
    const n = Math.max(8, Math.ceil(Math.abs(sw) / 0.08));
    const pts: P2[] = [];
    for (let i = 0; i <= n; i++) { const t = a0 + (sw * i) / n; pts.push([v[0] + rho * Math.cos(t), v[1] + rho * Math.sin(t)]); }
    for (let i = 0; i < n; i++) line(items, pts[i], pts[i + 1]);
    const sg = Math.sign(sw) || 1;
    arrow(items, pts[0], [Math.sin(a0) * sg, -Math.cos(a0) * sg]);
    const a1 = a0 + sw;
    arrow(items, pts[n], [-Math.sin(a1) * sg, Math.cos(a1) * sg]);
    // Extension lines from the edges out to the arc.
    for (const [ang, ends] of [[a0, m.e1], [a1, m.e2]] as [number, P2[]][]) {
      const dir: P2 = [Math.cos(ang), Math.sin(ang)];
      const far = Math.max(...ends.map((e) => dot2(sub2(pl.T(e), v), dir)));
      if (rho > far + 1) line(items, [v[0] + dir[0] * (far + 1), v[1] + dir[1] * (far + 1)], [v[0] + dir[0] * (rho + 1.5), v[1] + dir[1] * (rho + 1.5)]);
    }
    items.push({ t: 'text', s, x: at[0], y: at[1], size: DIM_TEXT_SIZE, anchor: 'middle' });
    return textBox(s, at[0], at[1], DIM_TEXT_SIZE, 'middle');
  }
  // Linear: extension lines from the points to the dimension line through the value.
  const s = `${pre}${fmt.length(m.value, dim.decimals)}`;
  const p1 = pl.T(m.p1), p2 = pl.T(m.p2);
  const u = m.u, n = perp(u);
  const o1 = dot2(sub2(at, p1), n), o2 = dot2(sub2(at, p2), n);
  const d1: P2 = [p1[0] + n[0] * o1, p1[1] + n[1] * o1], d2: P2 = [p2[0] + n[0] * o2, p2[1] + n[1] * o2];
  for (const [p, d, o] of [[p1, d1, o1], [p2, d2, o2]] as [P2, P2, number][]) {
    if (Math.abs(o) < 1e-6) continue;
    const sg = Math.sign(o);
    line(items, [p[0] + n[0] * sg * 1, p[1] + n[1] * sg * 1], [d[0] + n[0] * sg * 2, d[1] + n[1] * sg * 2]);
  }
  // From d1 toward d2 along u (or against it).
  const span = dot2(sub2(d2, d1), u);
  const e: P2 = span >= 0 ? u : [-u[0], -u[1]];
  const L = Math.abs(span);
  const tw = textWidth(s, DIM_TEXT_SIZE);
  // The value's place along the line, from d1.
  const ta = dot2(sub2(at, d1), e);
  const outside = L < 2 * ARROW + 1;
  let lo = Math.min(0, ta - tw / 2 - 0.5), hi = Math.max(L, ta + tw / 2 + 0.5);
  if (outside) { lo = Math.min(lo, -ARROW - 2); hi = Math.max(hi, L + ARROW + 2); }
  line(items, [d1[0] + e[0] * lo, d1[1] + e[1] * lo], [d1[0] + e[0] * hi, d1[1] + e[1] * hi]);
  arrow(items, d1, outside ? e : [-e[0], -e[1]]);
  arrow(items, d2, outside ? [-e[0], -e[1]] : e);
  const rot = readable(u);
  const ra = (rot * Math.PI) / 180;
  const textUp: P2 = [Math.sin(ra), -Math.cos(ra)];
  const base: P2 = [d1[0] + e[0] * ta + textUp[0] * 1, d1[1] + e[1] * ta + textUp[1] * 1];
  items.push({ t: 'text', s, x: base[0], y: base[1], size: DIM_TEXT_SIZE, anchor: 'middle', ...(rot ? { rotate: rot } : {}) });
  const half = tw / 2 + 0.5, h = DIM_TEXT_SIZE;
  const ux: P2 = [Math.cos(ra), Math.sin(ra)];
  const corners: P2[] = [-half, half].flatMap((a) => [-0.3, h].map((b) => [base[0] + ux[0] * a + textUp[0] * b, base[1] + ux[1] * a + textUp[1] * b] as P2));
  return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
}

/** Centre mark: a small cross at the centre and lines out past the circle. */
export function drawCenterMark(items: Item[], c: P2, r: number, color?: string) {
  const g = 1.5, ext = 2.5;
  for (const d of [[1, 0], [0, 1]] as P2[]) {
    line(items, [c[0] - d[0] * g, c[1] - d[1] * g], [c[0] + d[0] * g, c[1] + d[1] * g], color);
    if (r > g + 1) {
      line(items, [c[0] + d[0] * (g + 1), c[1] + d[1] * (g + 1)], [c[0] + d[0] * (r + ext), c[1] + d[1] * (r + ext)], color);
      line(items, [c[0] - d[0] * (g + 1), c[1] - d[1] * (g + 1)], [c[0] - d[0] * (r + ext), c[1] - d[1] * (r + ext)], color);
    }
  }
}

export const CHAIN = [6, 1.2, 1, 1.2];

/** Centreline between two points (sheet), running a little past both. */
export function drawCenterline(items: Item[], a: P2, b: P2, color?: string) {
  const u = unit(sub2(b, a)), ext = 2.5;
  line(items, [a[0] - u[0] * ext, a[1] - u[1] * ext], [b[0] + u[0] * ext, b[1] + u[1] * ext], color, THIN, CHAIN);
}

export const NOTE_SIZE = 3.5;

/** A note: lines of text from `at` (top line's baseline), with a leader arrow to `tip`. */
export function drawNote(items: Item[], text: string, at: P2, size: number, tip?: P2, color?: string): Box {
  const lines = text.split('\n');
  let w = 0;
  lines.forEach((s, i) => {
    items.push({ t: 'text', s, x: at[0], y: at[1] + i * size * 1.4, size, color });
    w = Math.max(w, textWidth(s, size));
  });
  const box: Box = [at[0] - 0.5, at[1] - size * 0.8, at[0] + w + 0.5, at[1] + (lines.length - 1) * size * 1.4 + size * 0.25];
  if (tip) {
    // From the side of the text nearer the tip, at the first line's middle height.
    const y = at[1] - size * 0.35;
    const from: P2 = tip[0] < at[0] + w / 2 ? [at[0] - 1, y] : [at[0] + w + 1, y];
    line(items, tip, from, color);
    arrow(items, tip, sub2(tip, from), color);
  }
  return box;
}

/** The cutting line of a section view on its parent: thick ends, a chain line between, arrows and letters. */
export function drawCuttingLine(items: Item[], a: P2, b: P2, sight: P2, letter: string) {
  const u = unit(sub2(b, a));
  const end = Math.min(5, len2(sub2(b, a)) / 3);
  line(items, a, [a[0] + u[0] * end, a[1] + u[1] * end], undefined, 0.6);
  line(items, b, [b[0] - u[0] * end, b[1] - u[1] * end], undefined, 0.6);
  line(items, [a[0] + u[0] * end, a[1] + u[1] * end], [b[0] - u[0] * end, b[1] - u[1] * end], undefined, THIN, [8, 1.5, 1.5, 1.5]);
  const w = unit(sight);
  for (const p of [a, b]) {
    const tip: P2 = [p[0] + w[0] * 7, p[1] + w[1] * 7];
    line(items, p, tip, undefined, 0.35);
    arrow(items, tip, w);
    const q: P2 = [tip[0] + w[0] * 2.5, tip[1] + w[1] * 2.5 + 1.75];
    items.push({ t: 'text', s: letter, x: q[0], y: q[1], size: 3.5, bold: true, anchor: 'middle' });
  }
}

/**
 * The viewing arrow of an auxiliary view on its parent: square to the edge it looks at, on the
 * side it is seen from, pointing at the edge's middle `m`, with the view's letter at its tail.
 */
export function drawViewArrow(items: Item[], m: P2, sight: P2, letter: string) {
  const w = unit(sight);
  const tip: P2 = [m[0] - w[0] * 2, m[1] - w[1] * 2], tail: P2 = [m[0] - w[0] * 12, m[1] - w[1] * 12];
  line(items, tail, tip, undefined, 0.35);
  arrow(items, tip, w);
  const q: P2 = [tail[0] - w[0] * 2.5, tail[1] - w[1] * 2.5 + 1.75];
  items.push({ t: 'text', s: letter, x: q[0], y: q[1], size: 3.5, bold: true, anchor: 'middle' });
}

/** The circle of a detail view on its parent, with its letter. */
export function drawDetailCircle(items: Item[], c: P2, r: number, letter: string) {
  items.push({ t: 'circle', cx: c[0], cy: c[1], r, w: 0.35, dash: [6, 1.2, 1, 1.2] });
  const k = Math.SQRT1_2;
  items.push({ t: 'text', s: letter, x: c[0] + (r + 1.5) * k, y: c[1] - (r + 1.5) * k, size: 3.5, bold: true, anchor: 'start' });
}

export interface HoleSpec {
  kind: 'simple' | 'counterbore' | 'countersink';
  diameter: number;
  /** Absent: through all. */
  depth?: number;
  cbDiameter?: number;
  cbDepth?: number;
  csDiameter?: number;
  csAngle?: number;
  /** Holes made by the same feature with this size. */
  count: number;
}

/**
 * The hole feature a face was made by and which hole of it the face belongs to, from the
 * face's name: "f2:p1:1" is face 1 of the hole at sketch point p1, and "f2:p1:1@f5.3" the same
 * face of copy 3 of a pattern or mirror f5 (see the kernel's naming). Null when the name does
 * not have that form; the caller checks that the feature is a hole.
 */
export function holeInstance(name: string): { feature: string; key: string } | null {
  const [base, ...copies] = name.replace(/#\d+$/, '').split('@');
  const parts = base.split(':');
  if (parts.length < 3 || !parts[0] || !parts[1]) return null;
  return { feature: parts[0], key: [parts[1], ...copies].join('@') };
}

/** How many holes of a hole feature the part has: one per hole centre, and per pattern or mirror copy of it. */
export function holeCount(faceNames: string[], feature: string): number {
  const keys = new Set<string>();
  for (const n of faceNames) {
    const h = holeInstance(n);
    if (h?.feature === feature) keys.add(h.key);
  }
  return keys.size;
}

/** The sizes of a hole feature (its Params evaluated) for a callout of `count` holes. */
export function holeSpecOf(f: HoleFeature, count: number): HoleSpec {
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  return {
    kind: f.kind === 'counterbore' ? 'counterbore' : f.kind === 'countersink' ? 'countersink' : 'simple',
    diameter: num(f.diameter),
    depth: f.end === 'blind' ? num(f.depth) : undefined,
    cbDiameter: num(f.cbDiameter), cbDepth: num(f.cbDepth), csDiameter: num(f.csDiameter), csAngle: num(f.csAngle),
    count: Math.max(1, count),
  };
}

/** A hole callout's lines: count, diameter and depth, then the counterbore or countersink. */
export function holeCalloutText(h: HoleSpec, fmt: AnnoFormat): string {
  const lines: string[] = [];
  const n = h.count > 1 ? `${h.count}X ` : '';
  lines.push(`${n}Ø${fmt.length(h.diameter)} ${h.depth === undefined ? 'THRU' : `DEEP ${fmt.length(h.depth)}`}`);
  if (h.kind === 'counterbore' && h.cbDiameter !== undefined) lines.push(`CBORE Ø${fmt.length(h.cbDiameter)} DEEP ${fmt.length(h.cbDepth ?? 0)}`);
  if (h.kind === 'countersink' && h.csDiameter !== undefined) lines.push(`CSK Ø${fmt.length(h.csDiameter)} X ${fmt.angle(h.csAngle ?? 90, 0)}`);
  return lines.join('\n');
}

/** Annotations belonging to a view (deleted with it). */
export const annotationsOf = (list: DrawingAnnotation[] | undefined, views: string[]) => (list ?? []).filter((a) => a.view && views.includes(a.view));

export { textBox };
