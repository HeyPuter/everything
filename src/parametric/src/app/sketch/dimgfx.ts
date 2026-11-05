// Geometry of dimension annotations in sketch coordinates: extension lines,
// dimension lines, arrowheads and default label positions.

import type { SkArc, SkCircle, SkDimension, SkLine, SketchFeature } from '../../model/types';
import { type Vec2, cross2, dot2, norm2, sub2 } from '../../math/vec';
import { ORIGIN_ID, SketchIndex, arcRadius } from '../../sketch/geom';
import { lineIntersection } from '../../sketch/ops';

export interface DimGfx {
  lines: Vec2[][];
  /** Where the label is drawn. */
  label: Vec2;
}

/** `px` is the size of one screen pixel in sketch units. Pass `ix` when drawing many dimensions. */
export function dimGraphics(sk: SketchFeature, d: Pick<SkDimension, 'type' | 'refs' | 'at' | 'sector'>, px: number, ix = new SketchIndex(sk.entities)): DimGfx | null {
  const ent = (id: string) => (id === ORIGIN_ID ? undefined : ix.get(id));
  const center = (id: string): Vec2 => {
    const e = ent(id);
    return e && (e.t === 'circle' || e.t === 'arc') ? ix.pt(e.c) : ix.pt(id);
  };
  const arrow = (tip: Vec2, dir: Vec2): Vec2[][] => {
    const s = px * 9, w = px * 3.2;
    const n: Vec2 = [-dir[1], dir[0]];
    const b: Vec2 = [tip[0] - dir[0] * s, tip[1] - dir[1] * s];
    return [[[b[0] + n[0] * w, b[1] + n[1] * w], tip, [b[0] - n[0] * w, b[1] - n[1] * w]]];
  };
  const at = d.at;
  const ext = px * 6;
  const linear = (p: Vec2, q: Vec2, u: Vec2): DimGfx => {
    // u: unit measuring direction. Dimension line sits at the label's offset.
    const n: Vec2 = [-u[1], u[0]];
    const off = dot2(sub2(at, p), n);
    const offQ = dot2(sub2(at, q), n);
    const p2: Vec2 = [p[0] + n[0] * off, p[1] + n[1] * off];
    const q2: Vec2 = [q[0] + n[0] * offQ, q[1] + n[1] * offQ];
    const sgn = (v: number) => (v >= 0 ? 1 : -1);
    const lines: Vec2[][] = [
      [p, [p2[0] + n[0] * ext * sgn(off), p2[1] + n[1] * ext * sgn(off)]],
      [q, [q2[0] + n[0] * ext * sgn(offQ), q2[1] + n[1] * ext * sgn(offQ)]],
    ];
    const dir = norm2(sub2(q2, p2));
    // Extend the dimension line to the label when it sits outside.
    const tl = dot2(sub2(at, p2), dir), len = Math.hypot(q2[0] - p2[0], q2[1] - p2[1]);
    const a0 = Math.min(0, tl - px * 20), a1 = Math.max(len, tl + px * 20);
    const start: Vec2 = [p2[0] + dir[0] * (tl < 0 ? a0 : 0), p2[1] + dir[1] * (tl < 0 ? a0 : 0)];
    const end: Vec2 = [p2[0] + dir[0] * (tl > len ? a1 : len), p2[1] + dir[1] * (tl > len ? a1 : len)];
    lines.push([start, end]);
    if (len > px * 2) lines.push(...arrow(p2, [-dir[0], -dir[1]]), ...arrow(q2, dir));
    return { lines, label: at };
  };
  const [a, b] = d.refs;
  switch (d.type) {
    case 'hdistance':
    case 'vdistance': {
      let p: Vec2, q: Vec2;
      if (d.refs.length === 1) { const l = ent(a) as SkLine; p = ix.pt(l.a); q = ix.pt(l.b); }
      else { p = center(a); q = center(b); }
      if (d.type === 'hdistance') return linear(p[0] <= q[0] ? p : q, p[0] <= q[0] ? q : p, [1, 0]);
      return linear(p[1] <= q[1] ? p : q, p[1] <= q[1] ? q : p, [0, 1]);
    }
    case 'distance': {
      if (d.refs.length === 1) {
        const l = ent(a) as SkLine;
        const p = ix.pt(l.a), q = ix.pt(l.b);
        return linear(p, q, norm2(sub2(q, p)));
      }
      const ea = ent(a), eb = ent(b);
      if (ea?.t === 'line' || eb?.t === 'line') {
        const line = (ea?.t === 'line' ? ea : eb) as SkLine;
        const other = line === ea ? b : a;
        const oe = ent(other);
        const la = ix.pt(line.a), lb = ix.pt(line.b);
        const u = norm2(sub2(lb, la));
        let p: Vec2;
        if (oe?.t === 'line') { const q1 = ix.pt(oe.a), q2 = ix.pt(oe.b); p = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2]; }
        else p = center(other);
        const t = dot2(sub2(p, la), u);
        const foot: Vec2 = [la[0] + u[0] * t, la[1] + u[1] * t];
        const dir = norm2(sub2(p, foot));
        if (Math.hypot(p[0] - foot[0], p[1] - foot[1]) < 1e-12) return { lines: [], label: at };
        return linear(foot, p, dir);
      }
      const p = center(a), q = center(b);
      return linear(p, q, norm2(sub2(q, p)));
    }
    case 'radius':
    case 'diameter': {
      const e = ent(a) as SkCircle | SkArc;
      const c = ix.pt(e.c);
      const r = e.t === 'circle' ? e.r : arcRadius(ix, e);
      const u = norm2(sub2(at, c));
      const dir: Vec2 = u[0] === 0 && u[1] === 0 ? [1, 0] : u;
      const edge: Vec2 = [c[0] + dir[0] * r, c[1] + dir[1] * r];
      const lines: Vec2[][] = [];
      if (d.type === 'diameter') {
        const opp: Vec2 = [c[0] - dir[0] * r, c[1] - dir[1] * r];
        lines.push([opp, at], ...arrow(edge, dir), ...arrow(opp, [-dir[0], -dir[1]]));
      } else {
        lines.push([c, at], ...arrow(edge, dir));
      }
      return { lines, label: at };
    }
    case 'angle': {
      const l1 = ent(a) as SkLine;
      const p1 = ix.pt(l1.a), q1 = ix.pt(l1.b);
      let p2: Vec2, q2: Vec2;
      if (b) { const l2 = ent(b) as SkLine; p2 = ix.pt(l2.a); q2 = ix.pt(l2.b); }
      else { p2 = p1; q2 = [p1[0] + 1, p1[1]]; }
      const c = lineIntersection(p1, q1, p2, q2) ?? p1;
      const s = d.sector ?? 0;
      const d1 = norm2(sub2(q1, p1)), d2 = norm2(sub2(q2, p2));
      const u1: Vec2 = s & 1 ? [-d1[0], -d1[1]] : d1;
      const u2: Vec2 = s & 2 ? [-d2[0], -d2[1]] : d2;
      const r = Math.max(px * 12, Math.hypot(at[0] - c[0], at[1] - c[1]));
      const a1 = Math.atan2(u1[1], u1[0]);
      let sweep = Math.atan2(cross2(u1, u2), dot2(u1, u2));
      const pts: Vec2[] = [];
      const n = 32;
      for (let i = 0; i <= n; i++) {
        const t = a1 + (sweep * i) / n;
        pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
      }
      const lines: Vec2[][] = [pts];
      // Extension lines from the geometry to the arc when the arc is beyond.
      lines.push([c, pts[0]], [c, pts[n]]);
      const tan0: Vec2 = [-Math.sin(a1) * Math.sign(sweep || 1), Math.cos(a1) * Math.sign(sweep || 1)];
      const a2 = a1 + sweep;
      const tan1: Vec2 = [Math.sin(a2) * Math.sign(sweep || 1), -Math.cos(a2) * Math.sign(sweep || 1)];
      lines.push(...arrow(pts[0], [-tan0[0], -tan0[1]]), ...arrow(pts[n], [-tan1[0], -tan1[1]]));
      sweep = 0;
      return { lines, label: at };
    }
  }
}

/** A sensible default label position for a new dimension. */
export function defaultLabel(sk: SketchFeature, refs: string[], type: SkDimension['type'], px: number): Vec2 {
  const ix = new SketchIndex(sk.entities);
  const e = refs[0] === ORIGIN_ID ? undefined : ix.get(refs[0]);
  if (refs.length === 1 && e?.t === 'line') {
    const a = ix.pt(e.a), b = ix.pt(e.b);
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n = norm2([-(b[1] - a[1]), b[0] - a[0]]);
    return [m[0] + n[0] * px * 28, m[1] + n[1] * px * 28];
  }
  if (e && (e.t === 'circle' || e.t === 'arc')) {
    const c = ix.pt(e.c);
    const r = e.t === 'circle' ? e.r : arcRadius(ix, e);
    void type;
    return [c[0] + r * 0.9 + px * 30, c[1] + r * 0.6 + px * 20];
  }
  return [0, 0];
}
