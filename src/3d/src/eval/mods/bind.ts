// Deform modifiers that need a bind step: Laplacian Deform (anchored surface editing), Mesh
// Deform (cage with mean value coordinates) and Surface Deform (follow a target surface).
// Bind data lives on the modifier in `_bind_*` typed arrays (saved with the file, skipped by
// signatures and inspectors).
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, objId, targetToLocal, vgroupFactor } from './common';
import { SurfaceQuery, triangles, transformedPositions } from './spatial';
import { vertexNeighbors } from '../../mesh/mesh';
import { groupWeights, vertexNormals } from '../meshbuild';

// ---------------------------------------------------------------------------
// Laplacian Deform

/** Per-vertex orthonormal frame (rows: tangent, bitangent, normal) from normals and a neighbour. */
function localFrames(P: ArrayLike<number>, normals: Float32Array, nb: { offsets: Uint32Array; neighbors: Uint32Array }): Float64Array {
  const nv = P.length / 3;
  const F = new Float64Array(nv * 9);
  const n = new Vector3(),
    t = new Vector3(),
    b = new Vector3();
  for (let v = 0; v < nv; v++) {
    n.fromArray(normals, v * 3);
    if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
    t.set(0, 0, 0);
    // the neighbour direction projected into the tangent plane (first one that is not parallel)
    for (let k = nb.offsets[v]; k < nb.offsets[v + 1] && t.lengthSq() < 1e-12; k++) {
      const j = nb.neighbors[k];
      t.set(P[j * 3] - P[v * 3], P[j * 3 + 1] - P[v * 3 + 1], P[j * 3 + 2] - P[v * 3 + 2]);
      t.addScaledVector(n, -t.dot(n));
    }
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0).addScaledVector(n, -n.x);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    t.normalize();
    b.crossVectors(n, t);
    F.set([t.x, t.y, t.z, b.x, b.y, b.z, n.x, n.y, n.z], v * 9);
  }
  return F;
}

/** Uniform Laplacian coordinates: each vertex minus the average of its neighbours. */
function laplacianCoords(P: ArrayLike<number>, nb: { offsets: Uint32Array; neighbors: Uint32Array }): Float64Array {
  const nv = P.length / 3;
  const d = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const s = nb.offsets[v],
      e = nb.offsets[v + 1];
    if (e === s) continue;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (let q = s; q < e; q++) sum += P[nb.neighbors[q] * 3 + k];
      d[v * 3 + k] = P[v * 3 + k] - sum / (e - s);
    }
  }
  return d;
}

/**
 * Least-squares solve of L·x = δ with anchored vertices fixed (conjugate gradients on the
 * normal equations, warm-started from `x`). Solves the three coordinates independently.
 */
function solveAnchored(x: Float64Array, delta: Float64Array, anchored: Uint8Array, nb: { offsets: Uint32Array; neighbors: Uint32Array }, maxIter = 600) {
  const nv = anchored.length;
  const deg = new Float64Array(nv);
  for (let v = 0; v < nv; v++) deg[v] = nb.offsets[v + 1] - nb.offsets[v];
  // A·y: row v = y_v - mean(y_neighbours)
  const applyA = (y: Float64Array, out: Float64Array) => {
    for (let v = 0; v < nv; v++) {
      if (!deg[v]) {
        out[v] = 0;
        continue;
      }
      let s = 0;
      for (let q = nb.offsets[v]; q < nb.offsets[v + 1]; q++) s += y[nb.neighbors[q]];
      out[v] = y[v] - s / deg[v];
    }
  };
  // Aᵀ·r
  const applyAT = (r: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let v = 0; v < nv; v++) {
      if (!deg[v]) continue;
      out[v] += r[v];
      const w = r[v] / deg[v];
      for (let q = nb.offsets[v]; q < nb.offsets[v + 1]; q++) out[nb.neighbors[q]] -= w;
    }
  };
  // diagonal of AᵀA for a Jacobi preconditioner
  const diag = new Float64Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!deg[v]) continue;
    diag[v] += 1;
    for (let q = nb.offsets[v]; q < nb.offsets[v + 1]; q++) diag[nb.neighbors[q]] += 1 / (deg[v] * deg[v]);
  }
  const xs = new Float64Array(nv),
    b = new Float64Array(nv),
    r = new Float64Array(nv),
    z = new Float64Array(nv),
    p = new Float64Array(nv),
    Ap = new Float64Array(nv),
    t1 = new Float64Array(nv),
    t2 = new Float64Array(nv);
  const mask = (a: Float64Array) => {
    for (let v = 0; v < nv; v++) if (anchored[v]) a[v] = 0;
  };
  for (let k = 0; k < 3; k++) {
    for (let v = 0; v < nv; v++) xs[v] = x[v * 3 + k];
    // b = Aᵀ(δ) restricted to free vertices; residual r = b - AᵀA·xs (anchors included in xs)
    for (let v = 0; v < nv; v++) t1[v] = delta[v * 3 + k];
    applyAT(t1, b);
    applyA(xs, t1);
    applyAT(t1, t2);
    for (let v = 0; v < nv; v++) r[v] = b[v] - t2[v];
    mask(r);
    let bn = 0;
    for (let v = 0; v < nv; v++) if (!anchored[v]) bn += b[v] * b[v];
    const tol = Math.max(1e-24, 1e-14 * bn);
    for (let v = 0; v < nv; v++) z[v] = diag[v] > 0 ? r[v] / diag[v] : r[v];
    p.set(z);
    let rz = 0;
    for (let v = 0; v < nv; v++) rz += r[v] * z[v];
    for (let it = 0; it < maxIter; it++) {
      let rr = 0;
      for (let v = 0; v < nv; v++) rr += r[v] * r[v];
      if (rr <= tol) break;
      applyA(p, t1);
      applyAT(t1, Ap);
      mask(Ap);
      let pAp = 0;
      for (let v = 0; v < nv; v++) pAp += p[v] * Ap[v];
      if (Math.abs(pAp) < 1e-30) break;
      const alpha = rz / pAp;
      for (let v = 0; v < nv; v++) {
        xs[v] += alpha * p[v];
        r[v] -= alpha * Ap[v];
      }
      for (let v = 0; v < nv; v++) z[v] = diag[v] > 0 ? r[v] / diag[v] : r[v];
      let rz2 = 0;
      for (let v = 0; v < nv; v++) rz2 += r[v] * z[v];
      const beta = rz2 / rz;
      rz = rz2;
      for (let v = 0; v < nv; v++) p[v] = z[v] + beta * p[v];
    }
    for (let v = 0; v < nv; v++) x[v * 3 + k] = xs[v];
  }
}

/**
 * Deform `input` so anchored vertices stay where they are in the input while every other vertex
 * keeps the rest shape's local detail (Laplacian coordinates carried along by vertex frames).
 */
export function laplacianDeform(m: EvalMesh, rest: Float32Array, anchors: Uint8Array, repeat: number): Float32Array {
  const nb = vertexNeighbors(m);
  const P = m.positions;
  const nv = P.length / 3;
  const restMesh = { ...m, positions: rest };
  const delta0 = laplacianCoords(rest, nb);
  const restFrames = localFrames(rest, vertexNormals(restMesh), nb);
  // detail in the rest frames
  const local = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const o = v * 9,
      d = v * 3;
    for (let r = 0; r < 3; r++) local[d + r] = restFrames[o + r * 3] * delta0[d] + restFrames[o + r * 3 + 1] * delta0[d + 1] + restFrames[o + r * 3 + 2] * delta0[d + 2];
  }
  // start from the rest shape moved so anchors match: anchors from the input, others from rest
  const x = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) x[v * 3 + k] = anchors[v] ? P[v * 3 + k] : rest[v * 3 + k];
  let delta = delta0;
  const rounds = Math.max(1, repeat) + 1;
  for (let it = 0; it < rounds; it++) {
    solveAnchored(x, delta, anchors, nb);
    if (it === rounds - 1) break;
    // re-express the detail in frames of the current solution
    const cur = Float32Array.from(x);
    const frames = localFrames(cur, vertexNormals({ ...m, positions: cur }), nb);
    delta = new Float64Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const o = v * 9,
        d = v * 3;
      for (let k = 0; k < 3; k++) delta[d + k] = frames[o + k] * local[d] + frames[o + 3 + k] * local[d + 1] + frames[o + 6 + k] * local[d + 2];
    }
  }
  return Float32Array.from(x);
}

function laplacianDeformMod(m: EvalMesh, mod: ModifierBase): EvalMesh {
  const rest = mod._bind_rest as Float32Array | undefined;
  if (!rest) return m;
  if (rest.length !== m.positions.length) throw new Error('Vertices changed from the bind state');
  const w = groupWeights(m, typeof mod.vertex_group === 'string' ? mod.vertex_group : '');
  if (!w) throw new Error('Anchor vertex group required');
  const nv = m.positions.length / 3;
  const inv = bool(mod, 'invert_vertex_group');
  const anchors = new Uint8Array(nv);
  let n = 0;
  for (let v = 0; v < nv; v++) if ((w[v] > 0) !== inv) (anchors[v] = 1), n++;
  if (!n) return m;
  return { ...m, positions: laplacianDeform(m, rest, anchors, Math.round(num(mod, 'iterations', 1))) };
}

// ---------------------------------------------------------------------------
// Mesh Deform: mean value coordinates over a closed triangle cage

/** Mean value coordinates of point x with respect to a closed triangle mesh. */
export function meanValueCoords(x: Vector3, C: ArrayLike<number>, tris: ArrayLike<number>, out: Float64Array): boolean {
  const nc = C.length / 3;
  out.fill(0);
  const d = new Float64Array(nc);
  const u = new Float64Array(nc * 3);
  for (let j = 0; j < nc; j++) {
    const dx = C[j * 3] - x.x,
      dy = C[j * 3 + 1] - x.y,
      dz = C[j * 3 + 2] - x.z;
    d[j] = Math.hypot(dx, dy, dz);
    if (d[j] < 1e-9) {
      out[j] = 1;
      return true;
    }
    u[j * 3] = dx / d[j];
    u[j * 3 + 1] = dy / d[j];
    u[j * 3 + 2] = dz / d[j];
  }
  const th = [0, 0, 0],
    c = [0, 0, 0],
    s = [0, 0, 0],
    id = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 3) {
    id[0] = tris[t];
    id[1] = tris[t + 1];
    id[2] = tris[t + 2];
    for (let i = 0; i < 3; i++) {
      const a = id[(i + 1) % 3] * 3,
        b = id[(i + 2) % 3] * 3;
      const l = Math.hypot(u[a] - u[b], u[a + 1] - u[b + 1], u[a + 2] - u[b + 2]);
      th[i] = 2 * Math.asin(Math.min(1, l / 2));
    }
    const h = (th[0] + th[1] + th[2]) / 2;
    if (Math.PI - h < 1e-7) {
      // x lies on this triangle: use its 2D barycentric coordinates
      out.fill(0);
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        const w = Math.sin(th[i]) * d[id[(i + 2) % 3]] * d[id[(i + 1) % 3]];
        out[id[i]] = w;
        sum += w;
      }
      for (let i = 0; i < 3; i++) out[id[i]] /= sum || 1;
      return true;
    }
    const a0 = id[0] * 3,
      a1 = id[1] * 3,
      a2 = id[2] * 3;
    const det = u[a0] * (u[a1 + 1] * u[a2 + 2] - u[a1 + 2] * u[a2 + 1]) - u[a0 + 1] * (u[a1] * u[a2 + 2] - u[a1 + 2] * u[a2]) + u[a0 + 2] * (u[a1] * u[a2 + 1] - u[a1 + 1] * u[a2]);
    const sign = det < 0 ? -1 : 1;
    let skip = false;
    for (let i = 0; i < 3; i++) {
      c[i] = (2 * Math.sin(h) * Math.sin(h - th[i])) / (Math.sin(th[(i + 1) % 3]) * Math.sin(th[(i + 2) % 3])) - 1;
      s[i] = sign * Math.sqrt(Math.max(0, 1 - c[i] * c[i]));
      if (Math.abs(s[i]) < 1e-9) skip = true;
    }
    if (skip) continue;
    for (let i = 0; i < 3; i++) {
      const ip = (i + 1) % 3,
        im = (i + 2) % 3;
      out[id[i]] += (th[i] - c[ip] * th[im] - c[im] * th[ip]) / (d[id[i]] * Math.sin(th[ip]) * s[im]);
    }
  }
  let sum = 0;
  for (let j = 0; j < nc; j++) sum += out[j];
  if (!Number.isFinite(sum) || Math.abs(sum) < 1e-12) return false;
  for (let j = 0; j < nc; j++) out[j] /= sum;
  return true;
}

export interface MeshDeformBind {
  /** cage positions at bind time (mesh space) */
  cage: Float32Array;
  /** per vertex: `k` cage indices and weights (sparse rows) */
  index: Uint32Array;
  weight: Float32Array;
  k: number;
  /** vertex positions at bind time */
  rest: Float32Array;
}

/** Bind mesh vertices to a cage (both in the mesh's local space). */
export function bindMeshDeform(P: Float32Array, cage: Float32Array, cageTris: ArrayLike<number>, maxInfluences = 64): MeshDeformBind {
  const nv = P.length / 3,
    nc = cage.length / 3;
  const k = Math.min(nc, maxInfluences);
  const index = new Uint32Array(nv * k),
    weight = new Float32Array(nv * k);
  const w = new Float64Array(nc);
  const order = new Uint32Array(nc);
  const x = new Vector3();
  for (let v = 0; v < nv; v++) {
    x.fromArray(P, v * 3);
    if (!meanValueCoords(x, cage, cageTris, w)) continue;
    // keep the strongest influences (all of them for small cages)
    for (let j = 0; j < nc; j++) order[j] = j;
    if (k < nc) {
      const arr = Array.from(order).sort((a, b) => Math.abs(w[b]) - Math.abs(w[a]));
      for (let j = 0; j < nc; j++) order[j] = arr[j];
    }
    let sum = 0;
    for (let j = 0; j < k; j++) sum += w[order[j]];
    for (let j = 0; j < k; j++) {
      index[v * k + j] = order[j];
      weight[v * k + j] = k < nc && Math.abs(sum) > 1e-9 ? w[order[j]] / sum : w[order[j]];
    }
  }
  return { cage: Float32Array.from(cage), index, weight, k, rest: Float32Array.from(P) };
}

function meshDeformMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const cage0 = mod._bind_cage as Float32Array | undefined;
  if (!cage0) return m;
  const index = mod._bind_index as Uint32Array,
    weight = mod._bind_weight as Float32Array,
    rest = mod._bind_rest as Float32Array;
  const k = Math.round(num(mod, '_bind_k', 1));
  if (rest.length !== m.positions.length) throw new Error('Vertices changed from the bind state');
  const cid = objId(mod, 'object');
  const cev = cid ? ctx.graph?.get(cid) : undefined;
  const tm = targetToLocal(ctx, cid);
  if (!cev?.mesh || !tm) return m;
  const cage = transformedPositions(cev.mesh.positions, tm);
  if (cage.length !== cage0.length) throw new Error('Cage vertices changed from the bind state');
  const dynamic = bool(mod, 'use_dynamic_bind');
  const P = m.positions,
    nv = P.length / 3;
  const out = new Float32Array(P.length);
  const vw = vgroupFactor(m, mod);
  for (let v = 0; v < nv; v++) {
    let dx = 0,
      dy = 0,
      dz = 0;
    for (let j = 0; j < k; j++) {
      const c = index[v * k + j] * 3,
        w = weight[v * k + j];
      dx += (cage[c] - cage0[c]) * w;
      dy += (cage[c + 1] - cage0[c + 1]) * w;
      dz += (cage[c + 2] - cage0[c + 2]) * w;
    }
    // static binds deform the bind-time shape; dynamic ones keep changes made before this modifier
    const base = dynamic ? P : rest;
    const f = vw ? vw[v] : 1;
    for (let a = 0; a < 3; a++) {
      const d = a === 0 ? dx : a === 1 ? dy : dz;
      const res = base[v * 3 + a] + d;
      out[v * 3 + a] = P[v * 3 + a] + (res - P[v * 3 + a]) * f;
    }
  }
  return { ...m, positions: out };
}

// ---------------------------------------------------------------------------
// Surface Deform

export interface SurfaceBind {
  /** per vertex and influence: target triangle vertex ids (×3), barycentric weights (×3), offset in the triangle frame (×3), weight */
  tris: Int32Array;
  bary: Float32Array;
  offset: Float32Array;
  weight: Float32Array;
  k: number;
  targetVerts: number;
}

/** Frame of a target triangle: origin at the barycentric point, axes tangent/bitangent/normal. */
function triFrame(T: ArrayLike<number>, a: number, b: number, c: number, bary: ArrayLike<number>, o: number, origin: Vector3, tx: Vector3, ty: Vector3, nz: Vector3): boolean {
  const A = new Vector3().fromArray(T, a * 3),
    B = new Vector3().fromArray(T, b * 3),
    C = new Vector3().fromArray(T, c * 3);
  origin.set(0, 0, 0).addScaledVector(A, bary[o]).addScaledVector(B, bary[o + 1]).addScaledVector(C, bary[o + 2]);
  tx.subVectors(B, A);
  nz.crossVectors(tx, new Vector3().subVectors(C, A));
  if (nz.lengthSq() < 1e-24 || tx.lengthSq() < 1e-24) return false;
  tx.normalize();
  nz.normalize();
  ty.crossVectors(nz, tx);
  return true;
}

/** Bind vertices to the nearest target triangles (positions all in the mesh's local space). */
export function bindSurface(P: Float32Array, target: EvalMesh, targetPos: Float32Array, falloff: number, only: Uint8Array | null, k = 4): SurfaceBind {
  const nv = P.length / 3;
  const q = new SurfaceQuery({ ...target, positions: targetPos });
  const { tris } = triangles({ ...target, positions: targetPos });
  const out: SurfaceBind = { tris: new Int32Array(nv * k * 3).fill(-1), bary: new Float32Array(nv * k * 3), offset: new Float32Array(nv * k * 3), weight: new Float32Array(nv * k), k, targetVerts: targetPos.length / 3 };
  const p = new Vector3(),
    origin = new Vector3(),
    tx = new Vector3(),
    ty = new Vector3(),
    nz = new Vector3(),
    A = new Vector3(),
    B = new Vector3(),
    C = new Vector3(),
    cp = new Vector3();
  // triangles around each target vertex (candidates near the closest triangle)
  const nt = tris.length / 3;
  const tv = targetPos.length / 3;
  const vt = { offsets: new Uint32Array(tv + 1), tris: new Uint32Array(tris.length) };
  for (let i = 0; i < tris.length; i++) vt.offsets[tris[i] + 1]++;
  for (let i = 0; i < tv; i++) vt.offsets[i + 1] += vt.offsets[i];
  const fill = vt.offsets.slice(0, tv);
  for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) vt.tris[fill[tris[t * 3 + c]]++] = t;
  for (let v = 0; v < nv; v++) {
    if (only && !only[v]) continue;
    p.fromArray(P, v * 3);
    const h = q.nearest(p);
    if (!h) continue;
    // candidate triangles: the nearest one and the others that are almost as near
    const cands: { t: number; d: number }[] = [];
    const radius = h.distance * 1.5 + 1e-6;
    const near = new Set<number>();
    for (const tv of h.tri) for (let q = vt.offsets[tv]; q < vt.offsets[tv + 1]; q++) near.add(vt.tris[q]);
    for (const t of near) {
      A.fromArray(targetPos, tris[t * 3] * 3);
      B.fromArray(targetPos, tris[t * 3 + 1] * 3);
      C.fromArray(targetPos, tris[t * 3 + 2] * 3);
      const d = closestOnTri(p, A, B, C, cp).distanceTo(p);
      if (d <= radius) cands.push({ t, d });
    }
    cands.sort((x, y) => x.d - y.d);
    const use = cands.slice(0, k);
    let wsum = 0;
    use.forEach((c, i) => {
      const s = (v * k + i) * 3;
      const ia = tris[c.t * 3],
        ib = tris[c.t * 3 + 1],
        ic = tris[c.t * 3 + 2];
      A.fromArray(targetPos, ia * 3);
      B.fromArray(targetPos, ib * 3);
      C.fromArray(targetPos, ic * 3);
      // barycentric coordinates of the projection onto the triangle's plane (may be outside)
      const n = new Vector3().subVectors(B, A).cross(new Vector3().subVectors(C, A));
      if (n.lengthSq() < 1e-24) return;
      n.normalize();
      const proj = p.clone().addScaledVector(n, -n.dot(new Vector3().subVectors(p, A)));
      const bc = baryOf(proj, A, B, C);
      out.tris.set([ia, ib, ic], s);
      out.bary.set(bc, s);
      triFrame(targetPos, ia, ib, ic, out.bary, s, origin, tx, ty, nz);
      const rel = new Vector3().subVectors(p, origin);
      out.offset.set([rel.dot(tx), rel.dot(ty), rel.dot(nz)], s);
      const w = 1 / Math.pow(c.d + 1e-4, falloff);
      out.weight[v * k + i] = w;
      wsum += w;
    });
    if (wsum > 0) for (let i = 0; i < k; i++) out.weight[v * k + i] /= wsum;
  }
  return out;
}

function baryOf(p: Vector3, a: Vector3, b: Vector3, c: Vector3): [number, number, number] {
  const v0 = new Vector3().subVectors(b, a),
    v1 = new Vector3().subVectors(c, a),
    v2 = new Vector3().subVectors(p, a);
  const d00 = v0.dot(v0),
    d01 = v0.dot(v1),
    d11 = v1.dot(v1),
    d20 = v2.dot(v0),
    d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01 || 1e-30;
  const y = (d11 * d20 - d01 * d21) / den,
    z = (d00 * d21 - d01 * d20) / den;
  return [1 - y - z, y, z];
}

function closestOnTri(p: Vector3, a: Vector3, b: Vector3, c: Vector3, out: Vector3): Vector3 {
  const ab = new Vector3().subVectors(b, a),
    ac = new Vector3().subVectors(c, a),
    ap = new Vector3().subVectors(p, a);
  const d1 = ab.dot(ap),
    d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return out.copy(a);
  const bp = new Vector3().subVectors(p, b),
    d3 = ab.dot(bp),
    d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return out.copy(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(a).addScaledVector(ab, d1 / (d1 - d3));
  const cp = new Vector3().subVectors(p, c),
    d5 = ab.dot(cp),
    d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return out.copy(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(a).addScaledVector(ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return out.copy(b).addScaledVector(new Vector3().subVectors(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  const den = 1 / (va + vb + vc);
  return out.copy(a).addScaledVector(ab, vb * den).addScaledVector(ac, vc * den);
}

/** Positions following the target surface from bind data. */
export function applySurfaceBind(P: Float32Array, b: SurfaceBind, targetPos: ArrayLike<number>, strength: number, factor: Float32Array | null): Float32Array {
  const nv = P.length / 3,
    k = b.k;
  const out = Float32Array.from(P);
  const origin = new Vector3(),
    tx = new Vector3(),
    ty = new Vector3(),
    nz = new Vector3(),
    acc = new Vector3();
  for (let v = 0; v < nv; v++) {
    acc.set(0, 0, 0);
    let wsum = 0;
    for (let i = 0; i < k; i++) {
      const s = (v * k + i) * 3;
      const a = b.tris[s];
      if (a < 0) continue;
      if (!triFrame(targetPos, a, b.tris[s + 1], b.tris[s + 2], b.bary, s, origin, tx, ty, nz)) continue;
      const w = b.weight[v * k + i];
      origin.addScaledVector(tx, b.offset[s]).addScaledVector(ty, b.offset[s + 1]).addScaledVector(nz, b.offset[s + 2]);
      acc.addScaledVector(origin, w);
      wsum += w;
    }
    if (wsum <= 0) continue;
    acc.multiplyScalar(1 / wsum);
    const f = strength * (factor ? factor[v] : 1);
    for (let a = 0; a < 3; a++) out[v * 3 + a] = P[v * 3 + a] + (acc.getComponent(a) - P[v * 3 + a]) * f;
  }
  return out;
}

export function surfaceBindFrom(mod: ModifierBase): SurfaceBind | null {
  const tris = mod._bind_tris as Int32Array | undefined;
  if (!tris) return null;
  return { tris, bary: mod._bind_bary as Float32Array, offset: mod._bind_offset as Float32Array, weight: mod._bind_weight as Float32Array, k: num(mod, '_bind_k', 4), targetVerts: num(mod, '_bind_target_verts', 0) };
}

function surfaceDeformMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const b = surfaceBindFrom(mod);
  if (!b) return m;
  if (b.weight.length / b.k !== m.positions.length / 3) throw new Error('Vertices changed from the bind state');
  const tid = objId(mod, 'target');
  const tev = tid ? ctx.graph?.get(tid) : undefined;
  const tm = targetToLocal(ctx, tid);
  if (!tev?.mesh || !tm) return m;
  if (tev.mesh.positions.length / 3 !== b.targetVerts) throw new Error('Target vertices changed from the bind state');
  const T = transformedPositions(tev.mesh.positions, tm);
  return { ...m, positions: applySurfaceBind(m.positions, b, T, num(mod, 'strength', 1), vgroupFactor(m, mod)) };
}

export const bindModifiers: ModifierType[] = [
  {
    type: 'LAPLACIANDEFORM',
    label: 'Laplacian Deform',
    category: 'DEFORM',
    icon: 'mod_laplacian',
    deformOnly: true,
    defaults: () => ({ iterations: 1, vertex_group: '', invert_vertex_group: false }),
    apply: laplacianDeformMod,
  },
  {
    type: 'MESH_DEFORM',
    label: 'Mesh Deform',
    category: 'DEFORM',
    icon: 'mod_meshdeform',
    deformOnly: true,
    defaults: () => ({ object: null, precision: 5, use_dynamic_bind: false, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.object as string],
    apply: meshDeformMod,
  },
  {
    type: 'SURFACE_DEFORM',
    label: 'Surface Deform',
    category: 'DEFORM',
    icon: 'mod_surfacedeform',
    deformOnly: true,
    defaults: () => ({ target: null, falloff: 4, strength: 1, use_sparse_bind: false, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.target as string],
    apply: surfaceDeformMod,
  },
];

for (const t of bindModifiers) registerModifier(t);

void Matrix4;
