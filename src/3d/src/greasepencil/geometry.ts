// Stroke render geometry: every stroke segment becomes a screen-space quad that the vertex shader
// expands around its two end points (the fragment shader draws a tapered capsule, which gives
// round joins and caps); dots/squares materials emit one quad per point; fills are triangulated
// (strokes that share a fill id are combined with the even-odd rule, so inner curves become holes).
// Pure CPU code, unit tested.
import { ShapeUtils, Vector2 } from 'three';
import type { GPDrawing } from './types';

export type RGBA = [number, number, number, number];

export interface StrokeStyle {
  stroke: boolean;
  fill: boolean;
  color: RGBA;
  fillColor: RGBA;
  mode: 'LINE' | 'DOTS' | 'BOX';
  /** squares: follow the stroke path, the object X axis, or stay screen aligned */
  alignment?: 'PATH' | 'OBJECT' | 'FIXED';
  /** gradient fill toward a secondary color */
  gradient?: { type: 'LINEAR' | 'RADIAL'; mix: RGBA; factor: number; flip: boolean; offset: [number, number]; angle: number; scale: [number, number] };
  /** holdout: the stroke / fill cuts the object's image instead of drawing */
  holdoutStroke?: boolean;
  holdoutFill?: boolean;
}

/** Plane of a fill: unit normal and two in-plane axes (u, v) from the loops' Newell normal. */
export function fillPlane(P: ArrayLike<number>, loops: number[][]): { N: number[]; U: number[]; V: number[] } {
  const n = [0, 0, 0];
  for (const l of loops) newell(P, l, n);
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const N = [n[0] / len, n[1] / len, n[2] / len];
  // an axis not parallel to the normal gives the plane's u direction
  const ref = Math.abs(N[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = [N[1] * ref[2] - N[2] * ref[1], N[2] * ref[0] - N[0] * ref[2], N[0] * ref[1] - N[1] * ref[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  const U = [u[0] / ul, u[1] / ul, u[2] / ul];
  const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
  return { N, U, V };
}

/** Gradient coordinates of fill points: the fill's plane, normalized to its bounds, then moved / turned / scaled. */
export function gradientUV(P: ArrayLike<number>, loops: number[][], g: NonNullable<StrokeStyle['gradient']>): Map<number, [number, number]> {
  const { U, V } = fillPlane(P, loops);
  const pts = new Map<number, [number, number]>();
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const l of loops)
    for (const i of l) {
      const x = P[i * 3] * U[0] + P[i * 3 + 1] * U[1] + P[i * 3 + 2] * U[2];
      const y = P[i * 3] * V[0] + P[i * 3 + 1] * V[1] + P[i * 3 + 2] * V[2];
      pts.set(i, [x, y]);
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  const w = x1 - x0 || 1,
    h = y1 - y0 || 1;
  const c = Math.cos(-g.angle),
    s = Math.sin(-g.angle);
  for (const [i, [x, y]] of pts) {
    let a = (x - x0) / w - 0.5 - g.offset[0],
      b = (y - y0) / h - 0.5 - g.offset[1];
    [a, b] = [(a * c - b * s) / (g.scale[0] || 1), (a * s + b * c) / (g.scale[1] || 1)];
    pts.set(i, [a + 0.5, b + 0.5]);
  }
  return pts;
}

/** Whether stroke s has its own fill texture transform (set with the Gradient tool). */
export function hasStrokeUV(d: GPDrawing, s: number): boolean {
  const n = d.offsets.length - 1;
  if (!d.uv_translation || !d.uv_rotation || !d.uv_scale || d.uv_rotation.length !== n) return false;
  return d.uv_translation[s * 2] !== 0 || d.uv_translation[s * 2 + 1] !== 0 || d.uv_rotation[s] !== 0 || d.uv_scale[s * 2] !== 1 || d.uv_scale[s * 2 + 1] !== 1;
}

/**
 * Gradient coordinates from a stroke's own transform: in the fill plane, the gradient starts at
 * `uv_translation`, runs along `uv_rotation` and spans `uv_scale` (linear: u 0 → 1; radial: the
 * distance from the start, 0 → 1).
 */
export function strokeUV(P: ArrayLike<number>, loops: number[][], d: GPDrawing, s: number, radial: boolean): Map<number, [number, number]> {
  const { U, V } = fillPlane(P, loops);
  const tx = d.uv_translation![s * 2],
    ty = d.uv_translation![s * 2 + 1],
    r = d.uv_rotation![s];
  const sx = d.uv_scale![s * 2] || 1,
    sy = d.uv_scale![s * 2 + 1] || 1;
  const c = Math.cos(-r),
    sn = Math.sin(-r);
  const pts = new Map<number, [number, number]>();
  for (const l of loops)
    for (const i of l) {
      const x = P[i * 3] * U[0] + P[i * 3 + 1] * U[1] + P[i * 3 + 2] * U[2] - tx;
      const y = P[i * 3] * V[0] + P[i * 3 + 1] * V[1] + P[i * 3 + 2] * V[2] - ty;
      const u = (x * c - y * sn) / sx,
        v = (x * sn + y * c) / sy;
      pts.set(i, radial ? [0.5 + u * 0.5, 0.5 + v * 0.5] : [u, v]);
    }
  return pts;
}

/** Color of the Fill tool's guide lines. */
export const GUIDE_COLOR: RGBA = [0.1, 0.75, 0.95, 0.9];

/** Primitive kinds stored in aInfo.x */
export const KIND_FILL = 0,
  KIND_SEGMENT = 1,
  KIND_DOT = 2,
  KIND_SQUARE = 3;

export interface StrokeBuffers {
  p0: Float32Array; // 3
  p1: Float32Array; // 3
  radius: Float32Array; // 2 (at p0, p1)
  c0: Float32Array; // 4
  c1: Float32Array; // 4
  corner: Float32Array; // 2 (end 0/1, side -1/+1)
  info: Float32Array; // 4 (kind, order, flags, stroke index)
  /** neighbouring points of a segment (xyz + radius; radius 0 = none): before p0 and after p1 */
  nbr0: Float32Array;
  nbr1: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  /** next free draw order */
  orderEnd: number;
  /** per stroke: first draw order used (fill or line), -1 when not drawn */
  strokeOrder: Int32Array;
}

class Grow {
  a: Float32Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Float32Array(Math.max(16, cap));
  }
  push4(x: number, y: number, z: number, w: number) {
    if (this.n + 4 > this.a.length) this.grow();
    const a = this.a;
    a[this.n++] = x;
    a[this.n++] = y;
    a[this.n++] = z;
    a[this.n++] = w;
  }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) this.grow();
    const a = this.a;
    a[this.n++] = x;
    a[this.n++] = y;
    a[this.n++] = z;
  }
  push2(x: number, y: number) {
    if (this.n + 2 > this.a.length) this.grow();
    this.a[this.n++] = x;
    this.a[this.n++] = y;
  }
  grow() {
    const b = new Float32Array(this.a.length * 2);
    b.set(this.a);
    this.a = b;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/** Point color: material color mixed with the vertex color (alpha = factor), alpha × point opacity. */
export function pointColor(d: GPDrawing, i: number, base: RGBA, out: number[] = [0, 0, 0, 0]): number[] {
  const f = d.vertex_color[i * 4 + 3];
  out[0] = base[0] + (d.vertex_color[i * 4] - base[0]) * f;
  out[1] = base[1] + (d.vertex_color[i * 4 + 1] - base[1]) * f;
  out[2] = base[2] + (d.vertex_color[i * 4 + 2] - base[2]) * f;
  out[3] = base[3] * d.opacity[i];
  return out;
}

export function fillColorOf(d: GPDrawing, s: number, base: RGBA): RGBA {
  const f = d.fill_color[s * 4 + 3];
  return [base[0] + (d.fill_color[s * 4] - base[0]) * f, base[1] + (d.fill_color[s * 4 + 1] - base[1]) * f, base[2] + (d.fill_color[s * 4 + 2] - base[2]) * f, base[3] * d.fill_opacity[s]];
}

/**
 * Build GPU buffers for a drawing. `styles[i]` is the style of material slot i (null = not drawn).
 * Draw orders start at `orderStart` (each fill and each stroke line takes one order value so later
 * strokes draw over earlier ones while overlaps inside one stroke never blend twice).
 */
/** `holdout`: only the holdout strokes / fills (true) or everything else (false). */
/** `guides`: also draw the Fill tool's guide lines (viewport only). */
export function buildStrokeBuffers(d: GPDrawing, styles: (StrokeStyle | null)[], orderStart = 0, radiusOffset = 0, holdout = false, guides = false): StrokeBuffers {
  const nPts = d.position.length / 3;
  const nStrokes = d.offsets.length - 1;
  const est = nPts * 4 + 64;
  const p0 = new Grow(est * 3),
    p1 = new Grow(est * 3),
    rad = new Grow(est * 2),
    c0 = new Grow(est * 4),
    c1 = new Grow(est * 4),
    corner = new Grow(est * 2),
    info = new Grow(est * 4),
    nb0 = new Grow(est * 4),
    nb1 = new Grow(est * 4);
  let index = new Uint32Array(Math.max(64, nPts * 6 + 64));
  let ni = 0;
  let nv = 0;
  const pushIndex = (...ix: number[]) => {
    if (ni + ix.length > index.length) {
      const b = new Uint32Array(index.length * 2 + ix.length);
      b.set(index);
      index = b;
    }
    for (const x of ix) index[ni++] = x;
  };
  const P = d.position;
  const R = (i: number) => Math.max(0, d.radius[i] + radiusOffset);
  const ca: number[] = [0, 0, 0, 0],
    cb: number[] = [0, 0, 0, 0];
  let order = orderStart;
  const strokeOrder = new Int32Array(nStrokes).fill(-1);

  // fill groups: strokes sharing a non-zero fill id are filled together at the first one's slot
  const groups = new Map<number, number[]>();
  for (let s = 0; s < nStrokes; s++) {
    const id = d.fill_id[s];
    if (!id) continue;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = []));
    g.push(s);
  }

  const NONE = [0, 0, 0, 0];
  const quad = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    ra: number,
    rb: number,
    colA: number[],
    colB: number[],
    kind: number,
    flags: number,
    s: number,
    n0: number[] = NONE,
    n1: number[] = NONE,
  ) => {
    for (let k = 0; k < 4; k++) {
      nb0.push4(n0[0], n0[1], n0[2], n0[3]);
      nb1.push4(n1[0], n1[1], n1[2], n1[3]);
      p0.push3(ax, ay, az);
      p1.push3(bx, by, bz);
      rad.push2(ra, rb);
      c0.push4(colA[0], colA[1], colA[2], colA[3]);
      c1.push4(colB[0], colB[1], colB[2], colB[3]);
      corner.push2(k >> 1, k & 1 ? 1 : -1);
      info.push4(kind, order, flags, s);
    }
    pushIndex(nv, nv + 1, nv + 2, nv + 2, nv + 1, nv + 3);
    nv += 4;
  };

  const stype = d.stroke_type && d.stroke_type.length === nStrokes ? d.stroke_type : null;
  const guide = d.is_fill_guide && d.is_fill_guide.length === nStrokes ? d.is_fill_guide : null;
  for (let s = 0; s < nStrokes; s++) {
    const st0 = styles[d.material_index[s]] ?? null;
    if (!st0) continue;
    // fill guides only show where the caller asks for them (Fill tool, viewport)
    if (guide?.[s] && !(guides && !holdout)) continue;
    // a per stroke type overrides the material's stroke / fill switches
    const t = guide?.[s] ? 1 : (stype?.[s] ?? 0);
    const st: StrokeStyle = guide?.[s] ? { ...st0, stroke: true, fill: false, mode: 'LINE', color: GUIDE_COLOR } : t ? { ...st0, stroke: (t & 1) !== 0, fill: (t & 2) !== 0 } : st0;
    const a = d.offsets[s],
      b = d.offsets[s + 1];
    const n = b - a;
    if (n <= 0) continue;
    // fill
    if (st.fill && !!st.holdoutFill === holdout) {
      const gid = d.fill_id[s];
      const members = gid ? groups.get(gid)! : [s];
      if (members[0] === s) {
        const loops: number[][] = members.map((m) => {
          const out: number[] = [];
          for (let i = d.offsets[m]; i < d.offsets[m + 1]; i++) out.push(i);
          return out;
        });
        const tris = triangulateLoops(P, loops);
        if (tris.length) {
          const fc = fillColorOf(d, s, st.fillColor);
          const g = st.gradient;
          const uv = g ? (hasStrokeUV(d, s) ? strokeUV(P, loops, d, s, g.type === 'RADIAL') : gradientUV(P, loops, g)) : null;
          let ca2 = fc as number[],
            cb2 = fc as number[];
          if (g) {
            const mix = [g.mix[0], g.mix[1], g.mix[2], g.mix[3] * d.fill_opacity[s]];
            [ca2, cb2] = g.flip ? [mix, fc] : [fc, mix];
          }
          if (fc[3] > 0 || (g && g.mix[3] > 0)) {
            if (strokeOrder[s] < 0) strokeOrder[s] = order;
            for (const i of tris) {
              p0.push3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
              p1.push3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
              rad.push2(0, 0);
              c0.push4(ca2[0], ca2[1], ca2[2], ca2[3]);
              c1.push4(cb2[0], cb2[1], cb2[2], cb2[3]);
              corner.push2(0, 0);
              info.push4(KIND_FILL, order, 0, s);
              const t = uv?.get(i) ?? [0, 0];
              // fills keep their gradient coordinates and kind (1 linear, 2 radial) in the first neighbour slot
              nb0.push4(t[0], t[1], g ? (g.type === 'RADIAL' ? 2 : 1) : 0, g ? g.factor : 0);
              nb1.push4(0, 0, 0, 0);
              pushIndex(nv++);
            }
            order++;
          }
        }
      }
    }
    if (!st.stroke || !!st.holdoutStroke !== holdout) continue;
    if (strokeOrder[s] < 0) strokeOrder[s] = order;
    if (st.mode !== 'LINE') {
      const kind = st.mode === 'DOTS' ? KIND_DOT : KIND_SQUARE;
      for (let i = a; i < b; i++) {
        pointColor(d, i, st.color, ca);
        const j = i + 1 < b ? i + 1 : i - 1 >= a ? i - 1 : i;
        const sign = j < i ? -1 : 1;
        // p1 only gives the alignment direction (squares follow the path)
        let dx = (P[j * 3] - P[i * 3]) * sign,
          dy = (P[j * 3 + 1] - P[i * 3 + 1]) * sign,
          dz = (P[j * 3 + 2] - P[i * 3 + 2]) * sign;
        if (st.alignment === 'OBJECT') [dx, dy, dz] = [Math.max(R(i), 1e-4), 0, 0];
        // flag 8: screen aligned (fixed)
        quad(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], P[i * 3] + dx, P[i * 3 + 1] + dy, P[i * 3 + 2] + dz, R(i), R(i), ca, ca, kind, st.alignment === 'FIXED' ? 8 : 0, s);
      }
      order++;
      continue;
    }
    const cyclic = !!d.cyclic[s] && n > 2;
    const segs = n === 1 ? 1 : cyclic ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const i = a + k;
      const j = n === 1 ? i : a + ((k + 1) % n);
      pointColor(d, i, st.color, ca);
      pointColor(d, j, st.color, cb);
      let flags = 0;
      if (!cyclic && k === 0 && d.start_cap[s]) flags |= 1;
      if (!cyclic && k === segs - 1 && d.end_cap[s]) flags |= 2;
      // neighbours (for single-coverage joins): the point before i and the point after j
      const hasPrev = n > 1 && (k > 0 || cyclic),
        hasNext = n > 1 && (k < segs - 1 || cyclic);
      const pi = k > 0 ? i - 1 : a + n - 1,
        nj = a + ((k + 2) % n);
      const n0 = hasPrev ? [P[pi * 3], P[pi * 3 + 1], P[pi * 3 + 2], R(pi)] : NONE;
      const n1 = hasNext ? [P[nj * 3], P[nj * 3 + 1], P[nj * 3 + 2], R(nj)] : NONE;
      quad(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], P[j * 3], P[j * 3 + 1], P[j * 3 + 2], R(i), R(j), ca, cb, KIND_SEGMENT, flags, s, n0, n1);
    }
    order++;
  }
  return {
    p0: p0.done(),
    p1: p1.done(),
    radius: rad.done(),
    c0: c0.done(),
    c1: c1.done(),
    corner: corner.done(),
    info: info.done(),
    nbr0: nb0.done(),
    nbr1: nb1.done(),
    index: index.slice(0, ni),
    vertexCount: nv,
    orderEnd: order,
    strokeOrder,
  };
}

// ---------------------------------------------------------------------------
// fill triangulation

/** Newell normal of a closed polygon (unnormalized). */
function newell(P: ArrayLike<number>, loop: number[], n: number[]) {
  for (let k = 0; k < loop.length; k++) {
    const i = loop[k],
      j = loop[(k + 1) % loop.length];
    const xi = P[i * 3],
      yi = P[i * 3 + 1],
      zi = P[i * 3 + 2],
      xj = P[j * 3],
      yj = P[j * 3 + 1],
      zj = P[j * 3 + 2];
    n[0] += (yi - yj) * (zi + zj);
    n[1] += (zi - zj) * (xi + xj);
    n[2] += (xi - xj) * (yi + yj);
  }
}

function pointInPolygon(x: number, y: number, poly: Vector2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Triangulate closed loops (point indices into P, xyz) with the even-odd rule: loops nested an odd
 * number of times are holes of their innermost enclosing loop. Returns point indices (3 per tri).
 */
export function triangulateLoops(P: ArrayLike<number>, loops: number[][]): number[] {
  const clean = loops
    .map((l) => {
      const out: number[] = [];
      for (const i of l) {
        const last = out[out.length - 1];
        if (last !== undefined && P[last * 3] === P[i * 3] && P[last * 3 + 1] === P[i * 3 + 1] && P[last * 3 + 2] === P[i * 3 + 2]) continue;
        out.push(i);
      }
      while (out.length > 1 && P[out[0] * 3] === P[out[out.length - 1] * 3] && P[out[0] * 3 + 1] === P[out[out.length - 1] * 3 + 1] && P[out[0] * 3 + 2] === P[out[out.length - 1] * 3 + 2]) out.pop();
      return out;
    })
    .filter((l) => l.length >= 3);
  if (!clean.length) return [];
  // projection plane from the combined Newell normal
  const nrm = [0, 0, 0];
  for (const l of clean) {
    const ln = [0, 0, 0];
    newell(P, l, ln);
    // orient each loop's contribution consistently (holes may wind either way)
    const s = ln[0] * nrm[0] + ln[1] * nrm[1] + ln[2] * nrm[2] < 0 ? -1 : 1;
    nrm[0] += ln[0] * s;
    nrm[1] += ln[1] * s;
    nrm[2] += ln[2] * s;
  }
  const ax = Math.abs(nrm[0]),
    ay = Math.abs(nrm[1]),
    az = Math.abs(nrm[2]);
  // drop the dominant axis
  const [u, v] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
  const polys = clean.map((l) => l.map((i) => new Vector2(P[i * 3 + u], P[i * 3 + v])));
  // earcut drops a closing point equal to the first one; keep the index maps in step
  polys.forEach((pl, k) => {
    while (pl.length > 1 && pl[0].equals(pl[pl.length - 1])) {
      pl.pop();
      clean[k].pop();
    }
  });
  // nesting depth of each loop
  const depth = polys.map((pl, k) => {
    let dpt = 0;
    for (let m = 0; m < polys.length; m++) if (m !== k && pointInPolygon(pl[0].x, pl[0].y, polys[m])) dpt++;
    return dpt;
  });
  const area = polys.map((pl) => Math.abs(ShapeUtils.area(pl)));
  const out: number[] = [];
  for (let k = 0; k < polys.length; k++) {
    if (depth[k] % 2) continue;
    // holes: odd-depth loops whose innermost container is this loop
    const holes: number[] = [];
    for (let m = 0; m < polys.length; m++) {
      if (depth[m] !== depth[k] + 1 || !pointInPolygon(polys[m][0].x, polys[m][0].y, polys[k])) continue;
      // innermost container check: no other even loop of the same depth closer inside
      let inner = true;
      for (let q = 0; q < polys.length; q++) if (q !== k && depth[q] === depth[k] && area[q] < area[k] && pointInPolygon(polys[m][0].x, polys[m][0].y, polys[q])) inner = false;
      if (inner) holes.push(m);
    }
    const contour = polys[k];
    const holePts = holes.map((m) => polys[m]);
    const idxMap = [...clean[k], ...holes.flatMap((m) => clean[m])];
    let faces: number[][];
    try {
      faces = ShapeUtils.triangulateShape(
        contour.slice(),
        holePts.map((x) => x.slice()),
      );
    } catch {
      faces = [];
    }
    for (const f of faces) out.push(idxMap[f[0]], idxMap[f[1]], idxMap[f[2]]);
  }
  return out;
}
