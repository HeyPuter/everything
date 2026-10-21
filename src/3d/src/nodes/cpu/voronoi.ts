// Voronoi (cellular) texture in 1–4 dimensions on the CPU: F1, F2, Smooth F1, Distance to Edge and
// N-Sphere Radius with Euclidean / Manhattan / Chebychev / Minkowski metrics and fractal detail.
// Each cell holds one jittered feature point; cells are hashed with `hash.ts`.
import { hf1, hf1to3, cellHash, cellColorHash } from './hash';

export type VoronoiFeature = 'F1' | 'F2' | 'SMOOTH_F1' | 'DISTANCE_TO_EDGE' | 'N_SPHERE_RADIUS';
export type VoronoiMetric = 'EUCLIDEAN' | 'MANHATTAN' | 'CHEBYCHEV' | 'MINKOWSKI';

export interface VoronoiParams {
  /** dimensions 1–4 */
  n: number;
  scale: number;
  detail: number;
  roughness: number;
  lacunarity: number;
  smoothness: number;
  exponent: number;
  randomness: number;
  feature: VoronoiFeature;
  metric: VoronoiMetric;
  normalize: boolean;
}

export interface VoronoiResult {
  distance: number;
  color: [number, number, number];
  /** feature point position (n components, in input space) */
  position: [number, number, number, number];
  radius: number;
}

type V = number[];

function dist(a: V, b: V, n: number, metric: VoronoiMetric, e: number) {
  let s = 0;
  switch (metric) {
    case 'MANHATTAN':
      for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
      return s;
    case 'CHEBYCHEV':
      for (let i = 0; i < n; i++) s = Math.max(s, Math.abs(a[i] - b[i]));
      return s;
    case 'MINKOWSKI':
      for (let i = 0; i < n; i++) s += Math.pow(Math.abs(a[i] - b[i]), e);
      return Math.pow(s, 1 / e);
    default:
      for (let i = 0; i < n; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
      return Math.sqrt(s);
  }
}

/** Jitter of the feature point of a cell (components in [0, 1]). */
function cellJitter(c: V, n: number, out: V) {
  if (n === 1) {
    out[0] = hf1(c[0]);
    return out;
  }
  return cellHash(c, n, out);
}
/** Color of a cell. */
function cellColor(c: V, n: number, out: V) {
  if (n === 1) return hf1to3(c[0], out);
  return cellColorHash(c, n, out);
}

/** Visit the cell offsets of [-r, r]^n, last axis outermost. */
function forOffsets(n: number, r: number, fn: (o: V) => void) {
  const o = [0, 0, 0, 0];
  const w = 2 * r + 1;
  const total = w ** n;
  for (let k = 0; k < total; k++) {
    let t = k;
    for (let i = 0; i < n; i++) {
      o[i] = (t % w) - r;
      t = Math.floor(t / w);
    }
    fn(o);
  }
}

interface Octave {
  distance: number;
  color: V;
  position: V;
}

function octave(p: V, P: VoronoiParams): Octave {
  const n = P.n;
  const cell = [0, 0, 0, 0],
    local = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    cell[i] = Math.floor(p[i]);
    local[i] = p[i] - cell[i];
  }
  const c = [0, 0, 0, 0],
    j = [0, 0, 0, 0],
    pt = [0, 0, 0, 0];
  const point = (o: V) => {
    for (let i = 0; i < n; i++) c[i] = cell[i] + o[i];
    cellJitter(c, n, j);
    for (let i = 0; i < n; i++) pt[i] = o[i] + j[i] * P.randomness;
    return pt;
  };
  const colorAt = (o: V) => {
    for (let i = 0; i < n; i++) c[i] = cell[i] + o[i];
    return cellColor(c, n, [0, 0, 0]);
  };
  if (P.feature === 'SMOOTH_F1' && P.smoothness !== 0) {
    const sm = Math.max(0, Math.min(0.5, P.smoothness / 2));
    let sd = 8;
    const col = [0, 0, 0],
      pos = [0, 0, 0, 0];
    forOffsets(n, 2, (o) => {
      const q = point(o);
      const d = dist(q, local, n, P.metric, P.exponent);
      const t = Math.max(0, Math.min(1, 0.5 + (0.5 * (sd - d)) / sm));
      const h = t * t * (3 - 2 * t);
      let corr = sm * h * (1 - h);
      sd = sd + (d - sd) * h - corr;
      corr /= 1 + 3 * sm;
      const cc = colorAt(o);
      for (let i = 0; i < 3; i++) col[i] = col[i] + (cc[i] - col[i]) * h - corr;
      for (let i = 0; i < n; i++) pos[i] = pos[i] + (q[i] - pos[i]) * h - corr;
    });
    for (let i = 0; i < n; i++) pos[i] += cell[i];
    return { distance: sd, color: col, position: pos };
  }
  let d1 = Infinity,
    d2 = Infinity;
  const o1 = [0, 0, 0, 0],
    o2 = [0, 0, 0, 0],
    p1 = [0, 0, 0, 0],
    p2 = [0, 0, 0, 0];
  const f2 = P.feature === 'F2';
  forOffsets(n, 1, (o) => {
    const q = point(o);
    const d = dist(q, local, n, P.metric, P.exponent);
    if (d < d1) {
      if (f2) {
        d2 = d1;
        for (let i = 0; i < n; i++) {
          o2[i] = o1[i];
          p2[i] = p1[i];
        }
      }
      d1 = d;
      for (let i = 0; i < n; i++) {
        o1[i] = o[i];
        p1[i] = q[i];
      }
    } else if (f2 && d < d2) {
      d2 = d;
      for (let i = 0; i < n; i++) {
        o2[i] = o[i];
        p2[i] = q[i];
      }
    }
  });
  const oo = f2 ? o2 : o1,
    pp = f2 ? p2 : p1;
  const pos = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) pos[i] = pp[i] + cell[i];
  return { distance: f2 ? d2 : d1, color: colorAt(oo), position: pos };
}

function distanceToEdge(p: V, P: VoronoiParams): number {
  const n = P.n;
  const cell = [0, 0, 0, 0],
    local = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    cell[i] = Math.floor(p[i]);
    local[i] = p[i] - cell[i];
  }
  const c = [0, 0, 0, 0],
    j = [0, 0, 0, 0];
  const toPoint = (o: V, out: V) => {
    for (let i = 0; i < n; i++) c[i] = cell[i] + o[i];
    cellJitter(c, n, j);
    for (let i = 0; i < n; i++) out[i] = o[i] + j[i] * P.randomness - local[i];
    return out;
  };
  if (n === 1) {
    // two neighbours of the closest point bound its cell
    const mid = toPoint([0], [0])[0] + local[0];
    const left = toPoint([-1], [0])[0] + local[0];
    const right = toPoint([1], [0])[0] + local[0];
    const dl = Math.abs((mid + left) / 2 - local[0]);
    const dr = Math.abs((mid + right) / 2 - local[0]);
    return Math.min(dl, dr);
  }
  const closest = [0, 0, 0, 0];
  let best = Infinity;
  const v = [0, 0, 0, 0];
  forOffsets(n, 1, (o) => {
    toPoint(o, v);
    let d = 0;
    for (let i = 0; i < n; i++) d += v[i] * v[i];
    if (d < best) {
      best = d;
      for (let i = 0; i < n; i++) closest[i] = v[i];
    }
  });
  best = Infinity;
  forOffsets(n, 1, (o) => {
    toPoint(o, v);
    let l2 = 0;
    for (let i = 0; i < n; i++) l2 += (v[i] - closest[i]) ** 2;
    if (l2 > 0.0001) {
      const l = Math.sqrt(l2);
      let d = 0;
      for (let i = 0; i < n; i++) d += ((closest[i] + v[i]) / 2) * ((v[i] - closest[i]) / l);
      best = Math.min(best, d);
    }
  });
  return best;
}

function nSphereRadius(p: V, P: VoronoiParams): number {
  const n = P.n;
  const cell = [0, 0, 0, 0],
    local = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    cell[i] = Math.floor(p[i]);
    local[i] = p[i] - cell[i];
  }
  const c = [0, 0, 0, 0],
    j = [0, 0, 0, 0];
  const point = (o: V, out: V) => {
    for (let i = 0; i < n; i++) c[i] = cell[i] + o[i];
    cellJitter(c, n, j);
    for (let i = 0; i < n; i++) out[i] = o[i] + j[i] * P.randomness;
    return out;
  };
  const q = [0, 0, 0, 0],
    closest = [0, 0, 0, 0],
    closestOff = [0, 0, 0, 0];
  let best = Infinity;
  forOffsets(n, 1, (o) => {
    point(o, q);
    const d = dist(q, local, n, 'EUCLIDEAN', 1);
    if (d < best) {
      best = d;
      for (let i = 0; i < n; i++) {
        closest[i] = q[i];
        closestOff[i] = o[i];
      }
    }
  });
  best = Infinity;
  const other = [0, 0, 0, 0],
    oo = [0, 0, 0, 0];
  forOffsets(n, 1, (o) => {
    let zero = true;
    for (let i = 0; i < n; i++) if (o[i] !== 0) zero = false;
    if (zero) return;
    for (let i = 0; i < n; i++) oo[i] = o[i] + closestOff[i];
    point(oo, q);
    const d = dist(closest, q, n, 'EUCLIDEAN', 1);
    if (d < best) {
      best = d;
      for (let i = 0; i < n; i++) other[i] = q[i];
    }
  });
  return dist(other, closest, n, 'EUCLIDEAN', 1) / 2;
}

/** Largest feature distance used to normalize fractal output. */
function maxDistance(P: VoronoiParams): number {
  const n = P.n;
  const ones = [1, 1, 1, 1],
    zero = [0, 0, 0, 0];
  const unit = dist(ones, zero, n, P.metric, P.exponent);
  if (P.feature === 'F2') return (1 + 0.5 * P.randomness) * unit;
  return (0.5 + 0.5 * P.randomness) * unit;
}

/** Evaluate the texture at `coord` (n components, unscaled). */
export function voronoi(coord: V, P: VoronoiParams): VoronoiResult {
  const n = P.n;
  const p = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) p[i] = coord[i] * P.scale;
  const res: VoronoiResult = { distance: 0, color: [0, 0, 0], position: [0, 0, 0, 0], radius: 0 };
  const detail = Math.max(0, Math.min(15, P.detail));
  const rough = Math.max(0, Math.min(1, P.roughness));
  const zero = detail === 0 || rough === 0 || P.lacunarity === 0;
  const q = [0, 0, 0, 0];
  if (P.feature === 'N_SPHERE_RADIUS') {
    res.radius = nSphereRadius(p, P);
    return res;
  }
  if (P.feature === 'DISTANCE_TO_EDGE') {
    const md = 0.5 + 0.5 * P.randomness;
    let amp = 1,
      maxAmp = md,
      sc = 1,
      d = 8;
    const steps = Math.ceil(detail);
    for (let i = 0; i <= steps; i++) {
      for (let k = 0; k < n; k++) q[k] = p[k] * sc;
      const od = distanceToEdge(q, P);
      if (zero) {
        d = od;
        break;
      }
      if (i <= detail) {
        maxAmp = maxAmp + (md / sc - maxAmp) * amp;
        d = d + (Math.min(d, od / sc) - d) * amp;
        sc *= P.lacunarity;
        amp *= rough;
      } else {
        const rem = detail - Math.floor(detail);
        if (rem !== 0) {
          const la = maxAmp + (md / sc - maxAmp) * amp;
          maxAmp = maxAmp + (la - maxAmp) * rem;
          const ld = d + (Math.min(d, od / sc) - d) * amp;
          d = d + (Math.min(d, ld) - d) * rem;
        }
      }
    }
    res.distance = P.normalize ? d / maxAmp : d;
    return res;
  }
  let amp = 1,
    maxAmp = 0,
    sc = 1;
  const col = [0, 0, 0],
    pos = [0, 0, 0, 0];
  let d = 0;
  const steps = Math.ceil(detail);
  for (let i = 0; i <= steps; i++) {
    for (let k = 0; k < n; k++) q[k] = p[k] * sc;
    const o = octave(q, P);
    if (zero) {
      maxAmp = 1;
      d = o.distance;
      for (let k = 0; k < 3; k++) col[k] = o.color[k];
      for (let k = 0; k < n; k++) pos[k] = o.position[k];
      break;
    }
    if (i <= detail) {
      maxAmp += amp;
      d += o.distance * amp;
      for (let k = 0; k < 3; k++) col[k] += o.color[k] * amp;
      for (let k = 0; k < n; k++) pos[k] = pos[k] + (o.position[k] / sc - pos[k]) * amp;
      sc *= P.lacunarity;
      amp *= rough;
    } else {
      const rem = detail - Math.floor(detail);
      if (rem !== 0) {
        maxAmp = maxAmp + amp * rem;
        d = d + o.distance * amp * rem;
        for (let k = 0; k < 3; k++) col[k] = col[k] + o.color[k] * amp * rem;
        for (let k = 0; k < n; k++) {
          const t = pos[k] + (o.position[k] / sc - pos[k]) * amp;
          pos[k] = pos[k] + (t - pos[k]) * rem;
        }
      }
    }
  }
  if (P.normalize) {
    d /= maxAmp * maxDistance(P);
    for (let k = 0; k < 3; k++) col[k] /= maxAmp;
  }
  res.distance = d;
  res.color = [col[0], col[1], col[2]];
  const s = P.scale;
  for (let k = 0; k < n; k++) res.position[k] = s !== 0 ? pos[k] / s : 0;
  return res;
}
