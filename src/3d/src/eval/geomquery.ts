// Point queries against evaluated meshes (nearest surface point, ray casts), in mesh space.
import { Vector3 } from 'three';
import type { EvalMesh } from './types';

/** Triangle corner indices of a mesh (fan triangulation), cached per index array. */
const triCache = new WeakMap<Uint32Array, { offsets: Uint32Array; tris: Uint32Array }>();
export function meshTriangles(m: EvalMesh): Uint32Array {
  const hit = triCache.get(m.indices);
  if (hit && hit.offsets === m.offsets) return hit.tris;
  const out: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s + 1; c < e - 1; c++) out.push(m.indices[s], m.indices[c], m.indices[c + 1]);
  }
  const tris = Uint32Array.from(out);
  triCache.set(m.indices, { offsets: m.offsets, tris });
  return tris;
}

/** Closest point on triangle abc to p (written to out). */
export function closestOnTriangle(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: Vector3): Vector3 {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const acx = c.x - a.x,
    acy = c.y - a.y,
    acz = c.z - a.z;
  const apx = p.x - a.x,
    apy = p.y - a.y,
    apz = p.z - a.z;
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  const bpx = p.x - b.x,
    bpy = p.y - b.y,
    bpz = p.z - b.z;
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return out.set(a.x + abx * v, a.y + aby * v, a.z + abz * v);
  }
  const cpx = p.x - c.x,
    cpy = p.y - c.y,
    cpz = p.z - c.z;
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return out.set(a.x + acx * w, a.y + acy * w, a.z + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return out.set(b.x + (c.x - b.x) * w, b.y + (c.y - b.y) * w, b.z + (c.z - b.z) * w);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom,
    w = vc * denom;
  return out.set(a.x + abx * v + acx * w, a.y + aby * v + acy * w, a.z + abz * v + acz * w);
}

export interface SurfaceHit {
  point: Vector3;
  /** face normal (unit) */
  normal: Vector3;
  distance: number;
  /** triangle index */
  tri: number;
}

const A = new Vector3(),
  B = new Vector3(),
  C = new Vector3(),
  Q = new Vector3();

function triNormal(a: Vector3, b: Vector3, c: Vector3) {
  return new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
}

/** Nearest point on the mesh surface (falls back to the nearest vertex for meshes without faces). */
export function closestPointOnMesh(m: EvalMesh, p: Vector3): SurfaceHit | null {
  const P = m.positions;
  const tris = meshTriangles(m);
  let best = Infinity,
    bi = -1;
  const bestPt = new Vector3();
  for (let t = 0; t < tris.length; t += 3) {
    A.fromArray(P, tris[t] * 3);
    B.fromArray(P, tris[t + 1] * 3);
    C.fromArray(P, tris[t + 2] * 3);
    closestOnTriangle(p, A, B, C, Q);
    const d = Q.distanceToSquared(p);
    if (d < best) {
      best = d;
      bi = t;
      bestPt.copy(Q);
    }
  }
  if (bi < 0) {
    for (let i = 0; i < P.length; i += 3) {
      Q.fromArray(P, i);
      const d = Q.distanceToSquared(p);
      if (d < best) {
        best = d;
        bestPt.copy(Q);
      }
    }
    if (best === Infinity) return null;
    return { point: bestPt, normal: p.clone().sub(bestPt).normalize(), distance: Math.sqrt(best), tri: -1 };
  }
  A.fromArray(P, tris[bi] * 3);
  B.fromArray(P, tris[bi + 1] * 3);
  C.fromArray(P, tris[bi + 2] * 3);
  return { point: bestPt, normal: triNormal(A, B, C), distance: Math.sqrt(best), tri: bi / 3 };
}

/** First hit of a ray with the mesh. `cull` skips faces facing towards (FRONT) or away from (BACK) the ray. */
export function raycastMesh(m: EvalMesh, origin: Vector3, dir: Vector3, maxDist = Infinity, cull: 'OFF' | 'FRONT' | 'BACK' = 'OFF'): SurfaceHit | null {
  const P = m.positions;
  const tris = meshTriangles(m);
  const d = dir.clone().normalize();
  const e1 = new Vector3(),
    e2 = new Vector3(),
    h = new Vector3(),
    s = new Vector3(),
    q = new Vector3();
  let best = maxDist,
    bi = -1;
  for (let t = 0; t < tris.length; t += 3) {
    A.fromArray(P, tris[t] * 3);
    B.fromArray(P, tris[t + 1] * 3);
    C.fromArray(P, tris[t + 2] * 3);
    e1.subVectors(B, A);
    e2.subVectors(C, A);
    h.crossVectors(d, e2);
    const det = e1.dot(h);
    if (Math.abs(det) < 1e-12) continue;
    // det < 0: the face's front side points towards the ray origin
    if (cull === 'FRONT' && det < 0) continue;
    if (cull === 'BACK' && det > 0) continue;
    const f = 1 / det;
    s.subVectors(origin, A);
    const u = f * s.dot(h);
    if (u < 0 || u > 1) continue;
    q.crossVectors(s, e1);
    const v = f * d.dot(q);
    if (v < 0 || u + v > 1) continue;
    const dist = f * e2.dot(q);
    if (dist >= 0 && dist < best) {
      best = dist;
      bi = t;
    }
  }
  if (bi < 0) return null;
  A.fromArray(P, tris[bi] * 3);
  B.fromArray(P, tris[bi + 1] * 3);
  C.fromArray(P, tris[bi + 2] * 3);
  return { point: origin.clone().addScaledVector(d, best), normal: triNormal(A, B, C), distance: best, tri: bi / 3 };
}
