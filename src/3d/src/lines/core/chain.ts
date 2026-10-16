// Chaining visible pieces of feature edges into 2D strokes, then splitting, selecting and sorting
// the chains as a line style asks.
import { lerp3, projectPoint, type LineCamera, type Piece } from './visibility';

/** One vertex of a 2D stroke with the attributes styling reads. */
export interface SV {
  x: number;
  y: number;
  /** distance to the camera */
  dist: number;
  /** world position */
  p: [number, number, number];
  /** material key (see `ChainOptions.materialKey`) */
  mat: number;
  obj: number;
  /** angle between the faces (creases) */
  angle: number;
  curv: number;
  /** +1: the surface lies on the (-dy, dx) side of the stroke, -1 the other side, 0 unknown */
  side: number;
  /** vertex group weights carried from the source mesh */
  w?: Record<string, number>;
}

function lerpWeights(a: Record<string, number> | undefined, b: Record<string, number> | undefined, t: number): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) out[k] = (a?.[k] ?? 0) + ((b?.[k] ?? 0) - (a?.[k] ?? 0)) * t;
  return out;
}

export interface Stroke2D {
  pts: SV[];
  qi: number;
  flags: number;
}

export interface ChainOptions {
  use_chaining: boolean;
  chaining: 'PLAIN' | 'SKETCHY';
  rounds: number;
  use_same_object?: boolean;
  /** material key of an edge side (resolved by the caller to a global index) */
  materialKey?: (obj: number, slot: number) => number;
}

export function lerpSV(a: SV, b: SV, t: number): SV {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    dist: a.dist + (b.dist - a.dist) * t,
    p: lerp3(a.p, b.p, t),
    mat: t < 0.5 ? a.mat : b.mat,
    obj: t < 0.5 ? a.obj : b.obj,
    angle: a.angle + (b.angle - a.angle) * t,
    curv: a.curv + (b.curv - a.curv) * t,
    side: t < 0.5 ? a.side : b.side,
    w: lerpWeights(a.w, b.w, t),
  };
}

function pieceVertex(p: Piece, t: number, cam: LineCamera, side: number, mat: number): SV {
  const e = p.edge;
  const w = lerp3(e.pa, e.pb, t);
  const s = projectPoint(cam, w[0], w[1], w[2]);
  return { x: s[0], y: s[1], dist: s[3], p: w, mat, obj: e.object, angle: e.angle, curv: e.curvature, side, w: e.wa || e.wb ? lerpWeights(e.wa, e.wb, t) : undefined };
}

/** Which side of the piece (in its own a → b direction) the surface lies on. */
function pieceSide(p: Piece, cam: LineCamera): number {
  const e = p.edge;
  if (!e.inner) return 0;
  const a = projectPoint(cam, ...lerp3(e.pa, e.pb, p.t0)),
    b = projectPoint(cam, ...lerp3(e.pa, e.pb, p.t1)),
    c = projectPoint(cam, ...e.inner);
  const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return cr > 0 ? 1 : cr < 0 ? -1 : 0;
}

const nodeKey = (obj: number, k: number) => (k < 0 ? k : obj * 4294967296 + k);

/** Chain pieces into strokes (each piece alone when chaining is off). */
export function chainPieces(pieces: Piece[], cam: LineCamera, o: ChainOptions): Stroke2D[] {
  const mk = o.materialKey ?? ((_o: number, s: number) => s);
  const sides = pieces.map((p) => pieceSide(p, cam));
  const verts = (i: number, rev: boolean): [SV, SV] => {
    const p = pieces[i];
    const m = mk(p.edge.object, p.edge.m0);
    const a = pieceVertex(p, p.t0, cam, rev ? -sides[i] : sides[i], m),
      b = pieceVertex(p, p.t1, cam, rev ? -sides[i] : sides[i], m);
    return rev ? [b, a] : [a, b];
  };
  if (!o.use_chaining) return pieces.map((p, i) => ({ pts: verts(i, false), qi: p.qi, flags: p.flags }));
  const at = new Map<number, number[]>();
  pieces.forEach((p, i) => {
    for (const k of [nodeKey(p.edge.object, p.ka), nodeKey(p.edge.object, p.kb)]) {
      let l = at.get(k);
      if (!l) at.set(k, (l = []));
      l.push(i);
    }
  });
  const out: Stroke2D[] = [];
  const rounds = o.chaining === 'SKETCHY' ? Math.max(1, o.rounds) : 1;
  for (let round = 0; round < rounds; round++) {
    const used = new Uint8Array(pieces.length);
    const n = pieces.length;
    // later rounds start from other pieces so the overlapping strokes differ
    const offset = round === 0 ? 0 : Math.floor((n * round * 0.618) % Math.max(1, n));
    for (let s = 0; s < n; s++) {
      const start = (s + offset) % n;
      if (used[start]) continue;
      used[start] = 1;
      const seed = pieces[start];
      const list: { i: number; rev: boolean }[] = [{ i: start, rev: false }];
      // extend forward from kb, then backward from ka
      for (const dir of [1, -1] as const) {
        let cur = start,
          curRev = dir === -1;
        for (;;) {
          const cp = pieces[cur];
          const endKey = nodeKey(cp.edge.object, curRev ? cp.ka : cp.kb);
          const cands = at.get(endKey);
          if (!cands) break;
          const [ca, cb] = verts(cur, curRev);
          const dx = cb.x - ca.x,
            dy = cb.y - ca.y;
          let best = -1,
            bestScore = -Infinity,
            bestRev = false;
          for (const j of cands) {
            if (used[j] || pieces[j].qi !== seed.qi) continue;
            const pj = pieces[j];
            const rev = nodeKey(pj.edge.object, pj.kb) === endKey;
            const [ja, jb] = verts(j, rev);
            const ex = jb.x - ja.x,
              ey = jb.y - ja.y;
            const l1 = Math.hypot(dx, dy) || 1,
              l2 = Math.hypot(ex, ey) || 1;
            const straight = (dx * ex + dy * ey) / (l1 * l2);
            const same = pj.flags & cp.flags ? 1 : 0;
            const score = same * 2 + straight;
            if (score > bestScore) {
              bestScore = score;
              best = j;
              bestRev = rev;
            }
          }
          if (best < 0) break;
          used[best] = 1;
          if (dir === 1) list.push({ i: best, rev: bestRev });
          else list.unshift({ i: best, rev: !bestRev });
          cur = best;
          curRev = bestRev;
        }
      }
      const pts: SV[] = [];
      let flags = 0;
      for (const { i, rev } of list) {
        const [a, b] = verts(i, rev);
        if (!pts.length) pts.push(a);
        pts.push(b);
        flags |= pieces[i].flags;
      }
      out.push({ pts, qi: seed.qi, flags });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// splitting

export function strokeLength(pts: SV[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

/** Cumulative 2D arc length per vertex. */
export function arcLengths(pts: SV[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return out;
}

/** The part of a polyline between arc lengths s0 and s1. */
export function slice(pts: SV[], s0: number, s1: number, arc = arcLengths(pts)): SV[] {
  const out: SV[] = [];
  const at = (s: number): SV => {
    let i = 1;
    while (i < arc.length - 1 && arc[i] < s) i++;
    const seg = arc[i] - arc[i - 1];
    return lerpSV(pts[i - 1], pts[i], seg > 0 ? Math.max(0, Math.min(1, (s - arc[i - 1]) / seg)) : 0);
  };
  out.push(at(s0));
  for (let i = 0; i < pts.length; i++) if (arc[i] > s0 && arc[i] < s1) out.push(pts[i]);
  out.push(at(s1));
  return out;
}

export interface SplitOptions {
  material_boundary?: boolean;
  use_angle_min?: boolean;
  angle_min?: number;
  use_angle_max?: boolean;
  angle_max?: number;
  use_split_length?: boolean;
  split_length?: number;
  use_split_pattern?: boolean;
  pattern?: number[];
}

/** The 2D angle at an interior vertex (π: straight on). */
function cornerAngle(a: SV, b: SV, c: SV): number {
  const ux = a.x - b.x,
    uy = a.y - b.y,
    vx = c.x - b.x,
    vy = c.y - b.y;
  const lu = Math.hypot(ux, uy),
    lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return Math.PI;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
}

export function splitStrokes(strokes: Stroke2D[], o: SplitOptions): Stroke2D[] {
  let list = strokes;
  // split at vertices (material changes, sharp or flat 2D angles)
  if (o.material_boundary || o.use_angle_min || o.use_angle_max) {
    const next: Stroke2D[] = [];
    for (const s of list) {
      let cur: SV[] = [s.pts[0]];
      for (let i = 1; i < s.pts.length; i++) {
        const v = s.pts[i];
        cur.push(v);
        if (i === s.pts.length - 1) break;
        let cut = !!o.material_boundary && s.pts[i + 1].mat !== v.mat;
        if (!cut && (o.use_angle_min || o.use_angle_max)) {
          const ang = cornerAngle(s.pts[i - 1], v, s.pts[i + 1]);
          if (o.use_angle_min && ang < (o.angle_min ?? 0)) cut = true;
          if (o.use_angle_max && ang > (o.angle_max ?? Math.PI)) cut = true;
        }
        if (cut) {
          next.push({ ...s, pts: cur });
          cur = [v];
        }
      }
      if (cur.length > 1) next.push({ ...s, pts: cur });
    }
    list = next;
  }
  if (o.use_split_length && (o.split_length ?? 0) > 0) {
    const next: Stroke2D[] = [];
    const L = o.split_length!;
    for (const s of list) {
      const arc = arcLengths(s.pts);
      const total = arc[arc.length - 1];
      if (total <= L) {
        next.push(s);
        continue;
      }
      const n = Math.ceil(total / L);
      for (let k = 0; k < n; k++) next.push({ ...s, pts: slice(s.pts, (total * k) / n, (total * (k + 1)) / n, arc) });
    }
    list = next;
  }
  if (o.use_split_pattern && o.pattern && o.pattern.some((x) => x > 0)) list = dashes(list, o.pattern);
  return list;
}

/** Keep the dash parts of a dash / gap pattern (lengths in pixels, pairs). */
export function dashes(strokes: Stroke2D[], pattern: number[]): Stroke2D[] {
  const pat: number[] = [];
  for (let i = 0; i + 1 < pattern.length; i += 2) if (pattern[i] > 0 || pattern[i + 1] > 0) pat.push(Math.max(0, pattern[i]), Math.max(0, pattern[i + 1]));
  const period = pat.reduce((a, b) => a + b, 0);
  if (!pat.length || period <= 0) return strokes;
  const out: Stroke2D[] = [];
  for (const s of strokes) {
    const arc = arcLengths(s.pts);
    const total = arc[arc.length - 1];
    let pos = 0,
      k = 0;
    while (pos < total) {
      const d = pat[k % pat.length],
        g = pat[(k + 1) % pat.length];
      if (d > 0) {
        const end = Math.min(total, pos + d);
        if (end - pos > 1e-3) out.push({ ...s, pts: slice(s.pts, pos, end, arc) });
      }
      pos += d + g;
      k += 2;
      if (d + g <= 0) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// selection & sorting

export interface SelectSortOptions {
  use_length_min?: boolean;
  length_min?: number;
  use_length_max?: boolean;
  length_max?: number;
  use_chain_count?: boolean;
  chain_count?: number;
  use_sorting?: boolean;
  sort_key?: 'DISTANCE_FROM_CAMERA' | '2D_LENGTH' | 'PROJECTED_X' | 'PROJECTED_Y';
  sort_order?: 'DEFAULT' | 'REVERSE';
  integration_type?: 'MEAN' | 'MIN' | 'MAX' | 'FIRST' | 'LAST';
}

function integrate(vals: number[], how: SelectSortOptions['integration_type']): number {
  if (!vals.length) return 0;
  switch (how) {
    case 'MIN':
      return Math.min(...vals);
    case 'MAX':
      return Math.max(...vals);
    case 'FIRST':
      return vals[0];
    case 'LAST':
      return vals[vals.length - 1];
    default:
      return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

export function selectAndSort(strokes: Stroke2D[], o: SelectSortOptions): Stroke2D[] {
  let list = strokes.filter((s) => {
    const l = strokeLength(s.pts);
    if (o.use_length_min && l < (o.length_min ?? 0)) return false;
    if (o.use_length_max && l > (o.length_max ?? Infinity)) return false;
    return true;
  });
  if (o.use_sorting) {
    const key = o.sort_key ?? 'DISTANCE_FROM_CAMERA';
    const vals = list.map((s) => {
      if (key === '2D_LENGTH') return strokeLength(s.pts);
      const xs = s.pts.map((p) => (key === 'PROJECTED_X' ? p.x : key === 'PROJECTED_Y' ? p.y : p.dist));
      return integrate(xs, o.integration_type);
    });
    const idx = list.map((_, i) => i);
    // distance: far strokes first so nearer ones are drawn over them; others ascending
    const dirn = (key === 'DISTANCE_FROM_CAMERA' ? -1 : 1) * (o.sort_order === 'REVERSE' ? -1 : 1);
    idx.sort((a, b) => (vals[a] - vals[b]) * dirn || a - b);
    list = idx.map((i) => list[i]);
  }
  if (o.use_chain_count) list = list.slice(0, Math.max(0, Math.round(o.chain_count ?? 0)));
  return list;
}
