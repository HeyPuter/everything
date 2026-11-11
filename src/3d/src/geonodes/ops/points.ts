// Distribute Points on Faces and Instance on Points.
import { InstancesComponent, MeshComponent, PointsComponent, allocData, composeMat, dataComps, mulMat, type AttrMap, type InstanceReference } from '../geometry';
import { faceNormals } from '../meshutil';
import { triangulatePoly } from '../../mesh/mesh';
import { hash2, hash3, u2f } from '../noise';
import { eulerFromAxes } from '../curveutil';

export interface DistributeResult {
  points: PointsComponent;
  normal: Float32Array;
  rotation: Float32Array;
}

interface Tri {
  face: number;
  c: [number, number, number]; // corners
}

function triangles(m: MeshComponent, faceSel: Uint8Array | null): Tri[] {
  const out: Tri[] = [];
  const tmp: number[] = [];
  for (let f = 0; f < m.faceCount; f++) {
    if (faceSel && !faceSel[f]) continue;
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    tmp.length = 0;
    triangulatePoly(m.positions, m.corners.subarray(s, e), tmp, s);
    for (let i = 0; i < tmp.length; i += 3) out.push({ face: f, c: [tmp[i], tmp[i + 1], tmp[i + 2]] });
  }
  return out;
}

/**
 * Random distribution: each triangle receives a deterministic number of points with expectation
 * area × density (density evaluated per corner; lower corner density thins the points out).
 */
export function distributeRandom(m: MeshComponent, faceSel: Uint8Array | null, density: Float32Array /* per corner */, seed: number): { tri: number[]; bary: number[]; tris: Tri[] } {
  const P = m.positions;
  const tris = triangles(m, faceSel);
  const triOut: number[] = [],
    bary: number[] = [];
  tris.forEach((t, ti) => {
    const [a, b, c] = t.c.map((k) => m.corners[k]);
    const ux = P[b * 3] - P[a * 3],
      uy = P[b * 3 + 1] - P[a * 3 + 1],
      uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3],
      vy = P[c * 3 + 1] - P[a * 3 + 1],
      vz = P[c * 3 + 2] - P[a * 3 + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const d0 = Math.max(0, density[t.c[0]]),
      d1 = Math.max(0, density[t.c[1]]),
      d2 = Math.max(0, density[t.c[2]]);
    const dmax = Math.max(d0, d1, d2);
    if (dmax <= 0 || area <= 0) return;
    const h = hash2(ti >>> 0, seed >>> 0);
    const expected = area * dmax;
    const count = Math.floor(expected + u2f(h));
    for (let k = 0; k < count; k++) {
      let r1 = u2f(hash3(ti >>> 0, seed >>> 0, (k * 3 + 1) >>> 0)),
        r2 = u2f(hash3(ti >>> 0, seed >>> 0, (k * 3 + 2) >>> 0));
      if (r1 + r2 > 1) {
        r1 = 1 - r1;
        r2 = 1 - r2;
      }
      const w0 = 1 - r1 - r2,
        w1 = r1,
        w2 = r2;
      const dens = w0 * d0 + w1 * d1 + w2 * d2;
      if (dens < dmax) {
        const keep = u2f(hash3(ti >>> 0, seed >>> 0, (k * 3 + 3) >>> 0));
        if (keep * dmax > dens) continue;
      }
      triOut.push(ti);
      bary.push(w0, w1, w2);
    }
  });
  return { tri: triOut, bary, tris };
}

/** Poisson disk: random candidates at Density Max, thinned so no two are closer than Distance Min. */
export function distributePoisson(m: MeshComponent, faceSel: Uint8Array | null, distMin: number, densityMax: number, factor: Float32Array /* per corner */, seed: number) {
  const ones = new Float32Array(m.cornerCount).fill(densityMax);
  const r = distributeRandom(m, faceSel, ones, seed);
  const P = m.positions;
  const pos = (i: number) => {
    const t = r.tris[r.tri[i]];
    const [a, b, c] = t.c.map((k) => m.corners[k]);
    const w = [r.bary[i * 3], r.bary[i * 3 + 1], r.bary[i * 3 + 2]];
    return [0, 1, 2].map((k) => P[a * 3 + k] * w[0] + P[b * 3 + k] * w[1] + P[c * 3 + k] * w[2]);
  };
  const n = r.tri.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => hash2(x, seed) - hash2(y, seed));
  const cell = Math.max(distMin, 1e-6);
  const grid = new Map<string, number[][]>();
  const keepTri: number[] = [],
    keepBary: number[] = [];
  for (const i of order) {
    const p = pos(i);
    if (distMin > 0) {
      const gx = Math.floor(p[0] / cell),
        gy = Math.floor(p[1] / cell),
        gz = Math.floor(p[2] / cell);
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++)
        for (let dy = -1; dy <= 1 && ok; dy++)
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const l = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (l) for (const q of l) if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 < distMin * distMin) ok = false;
          }
      if (!ok) continue;
      const k = `${gx},${gy},${gz}`;
      const l = grid.get(k);
      if (l) l.push(p);
      else grid.set(k, [p]);
    }
    // density factor thinning
    const t = r.tris[r.tri[i]];
    const w = [r.bary[i * 3], r.bary[i * 3 + 1], r.bary[i * 3 + 2]];
    const f = w[0] * factor[t.c[0]] + w[1] * factor[t.c[1]] + w[2] * factor[t.c[2]];
    if (f < 1 && u2f(hash3(i >>> 0, seed >>> 0, 0x5f3759df)) >= f) continue;
    keepTri.push(r.tri[i]);
    keepBary.push(w[0], w[1], w[2]);
  }
  // keep a stable order (by triangle) like the random method
  const idx = keepTri.map((_, i) => i).sort((a, b) => keepTri[a] - keepTri[b] || a - b);
  return {
    tri: idx.map((i) => keepTri[i]),
    bary: idx.flatMap((i) => keepBary.slice(i * 3, i * 3 + 3)),
    tris: r.tris,
  };
}

/** Build the point cloud for sampled triangles with interpolated attributes. */
export function buildDistributed(m: MeshComponent, s: { tri: number[]; bary: number[]; tris: Tri[] }, seed: number): DistributeResult {
  const n = s.tri.length;
  const P = m.positions;
  const pos = new Float32Array(n * 3);
  const fn = faceNormals(m);
  const normal = new Float32Array(n * 3),
    rotation = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = s.tris[s.tri[i]];
    const [a, b, c] = t.c.map((k) => m.corners[k]);
    const w0 = s.bary[i * 3],
      w1 = s.bary[i * 3 + 1],
      w2 = s.bary[i * 3 + 2];
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = P[a * 3 + k] * w0 + P[b * 3 + k] * w1 + P[c * 3 + k] * w2;
    normal.set(fn.subarray(t.face * 3, t.face * 3 + 3), i * 3);
    rotation.set(eulerFromAxes([P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], [fn[t.face * 3], fn[t.face * 3 + 1], fn[t.face * 3 + 2]]), i * 3);
  }
  const attrs: AttrMap = new Map();
  for (const [name, a] of m.attrs) {
    if (name === 'sharp_face' || name.startsWith('.')) continue;
    const comps = dataComps(a.type);
    const d = allocData(a.type, n);
    const isInt = a.type === 'INT',
      isBool = a.type === 'BOOLEAN';
    for (let i = 0; i < n; i++) {
      const t = s.tris[s.tri[i]];
      const w = [s.bary[i * 3], s.bary[i * 3 + 1], s.bary[i * 3 + 2]];
      for (let k = 0; k < comps; k++) {
        let v: number;
        if (a.domain === 'POINT') v = t.c.reduce((acc, corner, j) => acc + a.data[m.corners[corner] * comps + k] * w[j], 0);
        else if (a.domain === 'CORNER') v = t.c.reduce((acc, corner, j) => acc + a.data[corner * comps + k] * w[j], 0);
        else if (a.domain === 'FACE') v = a.data[t.face * comps + k];
        else continue;
        d[i * comps + k] = isBool ? (v >= 0.5 ? 1 : 0) : isInt ? Math.round(v) : v;
      }
    }
    if (a.domain === 'POINT' || a.domain === 'CORNER' || a.domain === 'FACE') attrs.set(name, { domain: 'POINT', type: a.type, data: d });
  }
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) ids[i] = hash3(s.tri[i] >>> 0, i >>> 0, seed >>> 0) & 0x7fffffff;
  attrs.set('id', { domain: 'POINT', type: 'INT', data: ids });
  attrs.set('radius', {
    domain: 'POINT',
    type: 'FLOAT',
    data: new Float32Array(n).fill(0.05),
  });
  return {
    points: new PointsComponent(pos, attrs, m.materials),
    normal,
    rotation,
  };
}

/** Instances at the given points (positions + per point rotation/scale), with point attributes. */
export function instanceOnPoints(
  positions: Float32Array,
  pointAttrs: AttrMap,
  sel: Uint8Array | null,
  refs: InstanceReference[],
  refIndexOf: (i: number) => number,
  rotation: Float32Array,
  scale: Float32Array,
  /** transform applied before the point's own (a picked instance keeps its transform) */
  local?: (i: number) => ArrayLike<number> | null,
): InstancesComponent {
  const n = positions.length / 3;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!sel || sel[i]) keep.push(i);
  const T = new Float32Array(keep.length * 16),
    R = new Int32Array(keep.length);
  const m = new Float64Array(16);
  keep.forEach((s, i) => {
    composeMat(positions.subarray(s * 3, s * 3 + 3), rotation.subarray(s * 3, s * 3 + 3), scale.subarray(s * 3, s * 3 + 3), m);
    const l = local?.(s);
    T.set(l ? mulMat(m, l) : m, i * 16);
    R[i] = refIndexOf(s);
  });
  const attrs: AttrMap = new Map();
  for (const [name, a] of pointAttrs) {
    // point attributes (instance attributes when instancing on instances) carry over
    if ((a.domain !== 'POINT' && a.domain !== 'INSTANCE') || name === 'radius' || name === 'position') continue;
    const comps = dataComps(a.type);
    const d = allocData(a.type, keep.length);
    keep.forEach((s, i) => {
      for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[s * comps + k];
    });
    attrs.set(name, { domain: 'INSTANCE', type: a.type, data: d });
  }
  return new InstancesComponent(T, R, refs, attrs);
}
