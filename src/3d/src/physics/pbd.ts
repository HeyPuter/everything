// Position-based (XPBD) mesh dynamics shared by Cloth and Soft Body: distance
// constraints (structural / shear / bending), pinning and goal springs, optional
// shape matching, effector forces, collision against collider meshes and simple
// self collision. Everything is in world space; one call advances one frame.
import { closestSurface, segmentHit, newHit, type ColliderMesh } from './colliders';
import { effectorForce, type Effector } from './fields';

export const KIND_STRUCT = 0,
  KIND_SHEAR = 1,
  KIND_BEND = 2,
  /** springs through the inside of a closed mesh */
  KIND_INTERNAL = 3,
  /** sewing springs (loose edges pulling their ends together) */
  KIND_SEW = 4;

export interface Topology {
  /** constraint endpoints */
  a: Uint32Array;
  b: Uint32Array;
  kind: Uint8Array;
  /** rest lengths */
  rest: Float32Array;
  /** triangles for normals / wind */
  tris: Uint32Array;
  nverts: number;
}

/** Build structural (edges), shear (face diagonals) and bending (vertices two edges apart) constraints. */
export function buildTopology(
  positions: ArrayLike<number>,
  offsets: ArrayLike<number>,
  indices: ArrayLike<number>,
  opts: { shear: boolean; bend: boolean; sewing?: ArrayLike<number> | null; internal?: { maxLength: number; maxDiversion: number; normalCheck: boolean } | null },
): Topology {
  const nv = positions.length / 3;
  const nf = offsets.length - 1;
  const key = (i: number, j: number) => (i < j ? i * nv + j : j * nv + i);
  const edges = new Map<number, [number, number, number]>();
  const nbr: Set<number>[] = Array.from({ length: nv }, () => new Set<number>());
  const faceOf: number[][] = Array.from({ length: nv }, () => []);
  const tris: number[] = [];
  for (let f = 0; f < nf; f++) {
    const s = offsets[f],
      e = offsets[f + 1];
    for (let c = s; c < e; c++) {
      const i = indices[c],
        j = indices[c + 1 < e ? c + 1 : s];
      if (i === j) continue;
      edges.set(key(i, j), [i, j, KIND_STRUCT]);
      nbr[i].add(j);
      nbr[j].add(i);
      faceOf[i].push(f);
    }
    for (let c = s + 1; c + 1 < e; c++) tris.push(indices[s], indices[c], indices[c + 1]);
  }
  if (opts.shear)
    for (let f = 0; f < nf; f++) {
      const s = offsets[f],
        e = offsets[f + 1];
      if (e - s < 4) continue;
      for (let c = s; c < e; c++)
        for (let d = c + 1; d < e; d++) {
          const i = indices[c],
            j = indices[d];
          const k = key(i, j);
          if (!edges.has(k)) edges.set(k, [i, j, KIND_SHEAR]);
        }
    }
  if (opts.bend) {
    const shareFace = (i: number, j: number) => {
      const fi = faceOf[i];
      for (const f of faceOf[j]) if (fi.includes(f)) return true;
      return false;
    };
    for (let v = 0; v < nv; v++)
      for (const n of nbr[v])
        for (const m of nbr[n]) {
          if (m <= v || nbr[v].has(m)) continue;
          const k = key(v, m);
          if (edges.has(k) || shareFace(v, m)) continue;
          edges.set(k, [v, m, KIND_BEND]);
        }
  }
  // sewing: loose edges become springs pulling their two vertices together
  const sew: [number, number][] = [];
  if (opts.sewing)
    for (let k = 0; k + 1 < opts.sewing.length; k += 2) {
      const i = opts.sewing[k],
        j = opts.sewing[k + 1];
      if (i !== j && !edges.has(key(i, j))) sew.push([i, j]);
    }
  const internal = opts.internal ? internalSprings(positions, tris, nbr, opts.internal) : [];
  const n = edges.size + sew.length + internal.length;
  const a = new Uint32Array(n),
    b = new Uint32Array(n),
    kind = new Uint8Array(n),
    rest = new Float32Array(n);
  let i = 0;
  const dist = (p: number, q: number) => Math.hypot(positions[p * 3] - positions[q * 3], positions[p * 3 + 1] - positions[q * 3 + 1], positions[p * 3 + 2] - positions[q * 3 + 2]);
  for (const [p, q, k] of edges.values()) {
    a[i] = p;
    b[i] = q;
    kind[i] = k;
    rest[i] = dist(p, q);
    i++;
  }
  for (const [p, q] of sew) {
    a[i] = p;
    b[i] = q;
    kind[i] = KIND_SEW;
    rest[i] = 0;
    i++;
  }
  for (const [p, q] of internal) {
    a[i] = p;
    b[i] = q;
    kind[i] = KIND_INTERNAL;
    rest[i] = dist(p, q);
    i++;
  }
  return { a, b, kind, rest, tris: new Uint32Array(tris), nverts: nv };
}

/** Internal springs: each vertex is connected through the inside of the mesh to the nearest vertex of the
 *  face hit by a ray along its inverted normal. */
function internalSprings(positions: ArrayLike<number>, tris: number[], nbr: Set<number>[], o: { maxLength: number; maxDiversion: number; normalCheck: boolean }): [number, number][] {
  const nv = positions.length / 3;
  const P = (i: number, c: number) => positions[i * 3 + c];
  // area-weighted vertex normals
  const N = new Float64Array(nv * 3);
  const fn = (t: number) => {
    const i = tris[t],
      j = tris[t + 1],
      k = tris[t + 2];
    const e1 = [P(j, 0) - P(i, 0), P(j, 1) - P(i, 1), P(j, 2) - P(i, 2)],
      e2 = [P(k, 0) - P(i, 0), P(k, 1) - P(i, 1), P(k, 2) - P(i, 2)];
    return [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  };
  for (let t = 0; t < tris.length; t += 3) {
    const n = fn(t);
    for (const v of [tris[t], tris[t + 1], tris[t + 2]]) for (let c = 0; c < 3; c++) N[v * 3 + c] += n[c];
  }
  for (let v = 0; v < nv; v++) {
    const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) N[v * 3 + c] /= l;
  }
  const out: [number, number][] = [];
  const seen = new Set<number>();
  const maxLen = o.maxLength > 0 ? o.maxLength : Infinity;
  const cosDiv = Math.cos(Math.max(0, Math.min(Math.PI / 2, o.maxDiversion)));
  // uniform grid of triangles so each ray only tests the triangles along its path
  let mnx = Infinity,
    mny = Infinity,
    mnz = Infinity,
    mxx = -Infinity,
    mxy = -Infinity,
    mxz = -Infinity;
  for (let v = 0; v < nv; v++) {
    mnx = Math.min(mnx, P(v, 0));
    mny = Math.min(mny, P(v, 1));
    mnz = Math.min(mnz, P(v, 2));
    mxx = Math.max(mxx, P(v, 0));
    mxy = Math.max(mxy, P(v, 1));
    mxz = Math.max(mxz, P(v, 2));
  }
  const diag = Math.hypot(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  const res = Math.max(1, Math.min(32, Math.round(Math.cbrt(tris.length / 3 / 4))));
  const cs = diag / res + 1e-9;
  const cellKey = (x: number, y: number, z: number) => `${Math.floor((x - mnx) / cs)},${Math.floor((y - mny) / cs)},${Math.floor((z - mnz) / cs)}`;
  const grid = new Map<string, number[]>();
  for (let t = 0; t < tris.length; t += 3) {
    let ax = Infinity,
      ay = Infinity,
      az = Infinity,
      bx = -Infinity,
      by = -Infinity,
      bz = -Infinity;
    for (const c of [tris[t], tris[t + 1], tris[t + 2]]) {
      ax = Math.min(ax, P(c, 0));
      ay = Math.min(ay, P(c, 1));
      az = Math.min(az, P(c, 2));
      bx = Math.max(bx, P(c, 0));
      by = Math.max(by, P(c, 1));
      bz = Math.max(bz, P(c, 2));
    }
    for (let x = Math.floor((ax - mnx) / cs); x <= Math.floor((bx - mnx) / cs); x++)
      for (let y = Math.floor((ay - mny) / cs); y <= Math.floor((by - mny) / cs); y++)
        for (let z = Math.floor((az - mnz) / cs); z <= Math.floor((bz - mnz) / cs); z++) {
          const k = `${x},${y},${z}`;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(t);
        }
  }
  const tested = new Set<number>();
  for (let v = 0; v < nv; v++) {
    const ox = P(v, 0),
      oy = P(v, 1),
      oz = P(v, 2);
    const dx = -N[v * 3],
      dy = -N[v * 3 + 1],
      dz = -N[v * 3 + 2];
    let best = Infinity,
      bestT = -1;
    tested.clear();
    const reach = Math.min(maxLen, diag);
    for (let step = 0; step <= reach + cs; step += cs * 0.5) {
      if (step > best) break;
      const l = grid.get(cellKey(ox + dx * step, oy + dy * step, oz + dz * step));
      if (!l) continue;
      for (const t of l) {
        if (tested.has(t)) continue;
        tested.add(t);
        const i = tris[t],
          j = tris[t + 1],
          k = tris[t + 2];
        if (i === v || j === v || k === v) continue;
        const e1x = P(j, 0) - P(i, 0),
          e1y = P(j, 1) - P(i, 1),
          e1z = P(j, 2) - P(i, 2);
        const e2x = P(k, 0) - P(i, 0),
          e2y = P(k, 1) - P(i, 1),
          e2z = P(k, 2) - P(i, 2);
        const hx = dy * e2z - dz * e2y,
          hy = dz * e2x - dx * e2z,
          hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-12) continue;
        const f = 1 / det;
        const sx = ox - P(i, 0),
          sy = oy - P(i, 1),
          sz = oz - P(i, 2);
        const u = f * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y,
          qy = sz * e1x - sx * e1z,
          qz = sx * e1y - sy * e1x;
        const w = f * (dx * qx + dy * qy + dz * qz);
        if (w < 0 || u + w > 1) continue;
        const d = f * (e2x * qx + e2y * qy + e2z * qz);
        if (d > 1e-6 && d < best) {
          best = d;
          bestT = t;
        }
      }
    }
    if (bestT < 0 || best > maxLen) continue;
    // the nearest corner of the hit face
    const hx = ox + dx * best,
      hy = oy + dy * best,
      hz = oz + dz * best;
    let target = -1,
      td = Infinity;
    for (const c of [tris[bestT], tris[bestT + 1], tris[bestT + 2]]) {
      const d = Math.hypot(P(c, 0) - hx, P(c, 1) - hy, P(c, 2) - hz);
      if (d < td) {
        td = d;
        target = c;
      }
    }
    if (target < 0 || nbr[v].has(target)) continue;
    // keep springs that run close to the ray direction (and between facing normals when asked)
    const sx = P(target, 0) - ox,
      sy = P(target, 1) - oy,
      sz = P(target, 2) - oz;
    const sl = Math.hypot(sx, sy, sz) || 1;
    if ((sx * dx + sy * dy + sz * dz) / sl < cosDiv) continue;
    if (o.normalCheck && N[target * 3] * N[v * 3] + N[target * 3 + 1] * N[v * 3 + 1] + N[target * 3 + 2] * N[v * 3 + 2] > -0.3) continue;
    const k = v < target ? v * nv + target : target * nv + v;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([v, target]);
  }
  return out;
}

export interface PBDState {
  x: Float64Array;
  v: Float64Array;
}

export interface PBDParams {
  /** seconds per frame (already multiplied by the time scale) */
  dt: number;
  substeps: number;
  iterations: number;
  gravity: [number, number, number];
  /** velocity drag per second */
  airDamping: number;
  /** compliance for stretch / compression / shear / bend (0 = rigid) */
  compliance: [number, number, number, number];
  /** velocity damping along constraints per second: stretch / compression / shear / bend */
  damping: [number, number, number, number];
  /** per-vertex mass (kg) */
  mass: number;
  /** pin weights 0..1 (1 = fully pinned to its target) */
  pin: Float32Array | null;
  pinStiffness: number;
  /** soft body goal: weight per vertex (0..1), spring and friction factors */
  goal: { weights: Float32Array; spring: number; friction: number } | null;
  /** shape matching stiffness 0..1 (soft body volume preservation) */
  shapeMatch: number;
  /** effector weight multiplier */
  fieldWeight: number;
  collision: { distance: number; quality: number } | null;
  self: { distance: number; friction: number } | null;
  /** rest-length scale (shrinking) */
  restScale: number;
  /** per-constraint compliance overrides when stretched / compressed (property weights) */
  stretchCompliance?: Float32Array | null;
  compressCompliance?: Float32Array | null;
  /** per-constraint rest-length scale (shrink group) */
  restScales?: Float32Array | null;
  /** internal spring compliance when stretched / compressed */
  internalCompliance?: [number, number];
  /** sewing spring compliance */
  sewCompliance?: number;
  /** pressure inside a closed mesh */
  pressure?: { uniform: number; factor: number; targetVolume: number; density: number; weights: Float32Array | null } | null;
  /** effector weight per field type */
  fieldTypeWeights?: Record<string, number> | null;
  /** aerodynamics: faces resist moving through the air (and generate lift) */
  aero?: { factor: number; lift: boolean } | null;
  /** plasticity: springs take on part of their stretch permanently (per frame fraction) */
  plastic?: number;
  /** per-vertex mass multipliers (mass vertex group) */
  massScale?: ArrayLike<number> | null;
  /** share of the velocity lost by vertices touching a collider (soft body choke) */
  choke?: number;
  /** self collision push strength 0..1 (soft body ball stiffness) */
  selfStiffness?: number;
}

export function initState(world: Float32Array): PBDState {
  return { x: Float64Array.from(world), v: new Float64Array(world.length) };
}

function vertexNormals(x: Float64Array, tris: Uint32Array, out: Float64Array) {
  out.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const i = tris[t] * 3,
      j = tris[t + 1] * 3,
      k = tris[t + 2] * 3;
    const e1x = x[j] - x[i],
      e1y = x[j + 1] - x[i + 1],
      e1z = x[j + 2] - x[i + 2];
    const e2x = x[k] - x[i],
      e2y = x[k + 1] - x[i + 1],
      e2z = x[k + 2] - x[i + 2];
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    for (const v of [i, j, k]) {
      out[v] += nx;
      out[v + 1] += ny;
      out[v + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
}

/** Polar decomposition rotation (as 3x3 row-major) of A via quaternion iteration. */
function extractRotation(A: number[], q: number[]) {
  // q = [x, y, z, w]
  for (let iter = 0; iter < 20; iter++) {
    const [x, y, z, w] = q;
    // rotation matrix of q (row-major)
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    // omega = sum_i r_i × a_i / (|sum r_i·a_i| + eps)  (columns)
    let ox = 0,
      oy = 0,
      oz = 0,
      dot = 0;
    for (let c = 0; c < 3; c++) {
      const rx = R[c],
        ry = R[3 + c],
        rz = R[6 + c];
      const ax = A[c],
        ay = A[3 + c],
        az = A[6 + c];
      ox += ry * az - rz * ay;
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      dot += rx * ax + ry * ay + rz * az;
    }
    const s = 1 / (Math.abs(dot) + 1e-9);
    ox *= s;
    oy *= s;
    oz *= s;
    const angle = Math.hypot(ox, oy, oz);
    if (angle < 1e-9) break;
    const h = angle / 2,
      sn = Math.sin(h) / angle;
    const dx = ox * sn,
      dy = oy * sn,
      dz = oz * sn,
      dw = Math.cos(h);
    // q = d * q
    const nx = dw * x + dx * w + dy * z - dz * y;
    const ny = dw * y - dx * z + dy * w + dz * x;
    const nz = dw * z + dx * y - dy * x + dz * w;
    const nw = dw * w - dx * x - dy * y - dz * z;
    const l = Math.hypot(nx, ny, nz, nw) || 1;
    q[0] = nx / l;
    q[1] = ny / l;
    q[2] = nz / l;
    q[3] = nw / l;
  }
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

const hit = newHit();

/**
 * Advance one frame. targets0/targets1 are the world-space rest (pin/goal) positions at
 * the start and end of the frame; they are interpolated per substep.
 */
export function stepFrame(
  st: PBDState,
  topo: Topology,
  P: PBDParams,
  targets0: Float32Array,
  targets1: Float32Array,
  effectors: Effector[],
  colliders: ColliderMesh[],
  time: number,
  restShape?: Float32Array,
) {
  const n = topo.nverts;
  const x = st.x,
    v = st.v;
  const p = new Float64Array(x.length);
  const h = P.dt / Math.max(1, P.substeps);
  const h2 = h * h;
  const w = new Float64Array(n);
  const baseW = P.mass > 0 ? 1 / P.mass : 0;
  for (let i = 0; i < n; i++) {
    const pin = P.pin ? P.pin[i] * P.pinStiffness : 0;
    const ms = P.massScale ? Math.max(0.01, P.massScale[i] ?? 1) : 1;
    w[i] = pin >= 0.999 ? 0 : (baseW / ms) * (1 - Math.min(1, pin));
  }
  const lambda = new Float64Array(topo.a.length);
  const normals = new Float64Array(x.length);
  const f = new Float64Array(3);
  const useNormals = effectors.some((e) => e.field.type === 'WIND') || !!(P.aero && P.aero.factor > 0);
  if (useNormals) vertexNormals(x, topo.tris, normals);
  const nrm: [number, number, number] = [0, 0, 1];
  const thick = P.collision?.distance ?? 0;
  const collided = new Uint8Array(n);
  const gw = P.goal;
  // shape matching rest data
  let restCx = 0,
    restCy = 0,
    restCz = 0;
  if (P.shapeMatch > 0 && restShape) {
    for (let i = 0; i < n; i++) {
      restCx += restShape[i * 3];
      restCy += restShape[i * 3 + 1];
      restCz += restShape[i * 3 + 2];
    }
    restCx /= n;
    restCy /= n;
    restCz /= n;
  }
  const q = [0, 0, 0, 1];
  const pressureF = P.pressure ? new Float64Array(x.length) : null;
  const restVolume = P.pressure ? Math.abs(meshVolume(targets0, topo.tris)) : 0;
  for (let s = 0; s < P.substeps; s++) {
    if (pressureF && P.pressure) pressureForces(x, topo.tris, P.pressure, restVolume, P.gravity, pressureF);
    const t1 = (s + 1) / P.substeps;
    // targets at the end of this substep
    const tgt = (i: number, c: number) => targets0[i * 3 + c] + (targets1[i * 3 + c] - targets0[i * 3 + c]) * t1;
    for (const c of colliders) c.setTime(t1);
    // 1. predict
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (w[i] === 0) {
        p[k] = tgt(i, 0);
        p[k + 1] = tgt(i, 1);
        p[k + 2] = tgt(i, 2);
        continue;
      }
      f[0] = f[1] = f[2] = 0;
      if (effectors.length) {
        if (useNormals) {
          nrm[0] = normals[k];
          nrm[1] = normals[k + 1];
          nrm[2] = normals[k + 2];
        }
        effectorForce(effectors, x[k], x[k + 1], x[k + 2], v[k], v[k + 1], v[k + 2], time + s / P.substeps, f, P.fieldWeight, useNormals ? nrm : null, P.fieldTypeWeights);
      }
      if (pressureF) {
        f[0] += pressureF[k];
        f[1] += pressureF[k + 1];
        f[2] += pressureF[k + 2];
      }
      if (P.aero && P.aero.factor > 0) {
        // air pressure on the surface: against the motion along the normal (plus lift sideways)
        const nx0 = normals[k],
          ny0 = normals[k + 1],
          nz0 = normals[k + 2];
        const vn = v[k] * nx0 + v[k + 1] * ny0 + v[k + 2] * nz0;
        const a = P.aero.factor * 0.1;
        f[0] -= nx0 * vn * a * P.mass;
        f[1] -= ny0 * vn * a * P.mass;
        f[2] -= nz0 * vn * a * P.mass;
        if (P.aero.lift) {
          const tx = v[k] - nx0 * vn,
            ty = v[k + 1] - ny0 * vn,
            tz = v[k + 2] - nz0 * vn;
          const sgn = vn >= 0 ? -1 : 1;
          const tl = Math.hypot(tx, ty, tz);
          f[0] += nx0 * tl * a * 0.5 * sgn * P.mass;
          f[1] += ny0 * tl * a * 0.5 * sgn * P.mass;
          f[2] += nz0 * tl * a * 0.5 * sgn * P.mass;
        }
      }
      const drag = Math.max(0, 1 - P.airDamping * h);
      v[k] = (v[k] + h * (P.gravity[0] + f[0] * baseW)) * drag;
      v[k + 1] = (v[k + 1] + h * (P.gravity[1] + f[1] * baseW)) * drag;
      v[k + 2] = (v[k + 2] + h * (P.gravity[2] + f[2] * baseW)) * drag;
      p[k] = x[k] + v[k] * h;
      p[k + 1] = x[k + 1] + v[k + 1] * h;
      p[k + 2] = x[k + 2] + v[k + 2] * h;
    }
    lambda.fill(0);
    // 2. constraints
    for (let it = 0; it < P.iterations; it++) {
      const A = topo.a,
        B = topo.b,
        K = topo.kind,
        R = topo.rest;
      for (let c = 0; c < A.length; c++) {
        const i = A[c],
          j = B[c];
        const wi = w[i],
          wj = w[j],
          ws = wi + wj;
        if (ws === 0) continue;
        const ia = i * 3,
          ja = j * 3;
        const dx = p[ia] - p[ja],
          dy = p[ia + 1] - p[ja + 1],
          dz = p[ia + 2] - p[ja + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-12) continue;
        const C = len - R[c] * (P.restScales ? P.restScales[c] : P.restScale);
        const kind = K[c];
        let comp: number;
        if (kind === KIND_INTERNAL) comp = C > 0 ? (P.internalCompliance?.[0] ?? 1e6) : (P.internalCompliance?.[1] ?? 1e6);
        else if (kind === KIND_SEW) comp = P.sewCompliance ?? 1e-4;
        else if (C > 0 && P.stretchCompliance) comp = P.stretchCompliance[c];
        else if (C <= 0 && P.compressCompliance) comp = P.compressCompliance[c];
        else comp = kind === KIND_STRUCT ? (C > 0 ? P.compliance[0] : P.compliance[1]) : kind === KIND_SHEAR ? P.compliance[2] : P.compliance[3];
        const at = comp / h2;
        const dl = (-C - at * lambda[c]) / (ws + at);
        lambda[c] += dl;
        const sx = (dx / len) * dl,
          sy = (dy / len) * dl,
          sz = (dz / len) * dl;
        p[ia] += sx * wi;
        p[ia + 1] += sy * wi;
        p[ia + 2] += sz * wi;
        p[ja] -= sx * wj;
        p[ja + 1] -= sy * wj;
        p[ja + 2] -= sz * wj;
      }
      // partial pins
      if (P.pin)
        for (let i = 0; i < n; i++) {
          const pw = Math.min(1, P.pin[i] * P.pinStiffness);
          if (pw <= 0 || w[i] === 0) continue;
          const k = i * 3;
          p[k] += (tgt(i, 0) - p[k]) * pw;
          p[k + 1] += (tgt(i, 1) - p[k + 1]) * pw;
          p[k + 2] += (tgt(i, 2) - p[k + 2]) * pw;
        }
      // soft body goal springs
      if (gw)
        for (let i = 0; i < n; i++) {
          const g = gw.weights[i] * gw.spring;
          if (g <= 0 || w[i] === 0) continue;
          const k = i * 3,
            a = Math.min(1, g / P.iterations);
          p[k] += (tgt(i, 0) - p[k]) * a;
          p[k + 1] += (tgt(i, 1) - p[k + 1]) * a;
          p[k + 2] += (tgt(i, 2) - p[k + 2]) * a;
        }
    }
    // 3. shape matching (once per substep)
    if (P.shapeMatch > 0 && restShape) {
      let cx = 0,
        cy = 0,
        cz = 0;
      for (let i = 0; i < n; i++) {
        cx += p[i * 3];
        cy += p[i * 3 + 1];
        cz += p[i * 3 + 2];
      }
      cx /= n;
      cy /= n;
      cz /= n;
      const Apq = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const px = p[i * 3] - cx,
          py = p[i * 3 + 1] - cy,
          pz = p[i * 3 + 2] - cz;
        const qx = restShape[i * 3] - restCx,
          qy = restShape[i * 3 + 1] - restCy,
          qz = restShape[i * 3 + 2] - restCz;
        Apq[0] += px * qx;
        Apq[1] += px * qy;
        Apq[2] += px * qz;
        Apq[3] += py * qx;
        Apq[4] += py * qy;
        Apq[5] += py * qz;
        Apq[6] += pz * qx;
        Apq[7] += pz * qy;
        Apq[8] += pz * qz;
      }
      const Rm = extractRotation(Apq, q);
      const k = Math.min(1, P.shapeMatch);
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const qx = restShape[i * 3] - restCx,
          qy = restShape[i * 3 + 1] - restCy,
          qz = restShape[i * 3 + 2] - restCz;
        const gx = cx + Rm[0] * qx + Rm[1] * qy + Rm[2] * qz;
        const gy = cy + Rm[3] * qx + Rm[4] * qy + Rm[5] * qz;
        const gz = cz + Rm[6] * qx + Rm[7] * qy + Rm[8] * qz;
        p[i * 3] += (gx - p[i * 3]) * k;
        p[i * 3 + 1] += (gy - p[i * 3 + 1]) * k;
        p[i * 3 + 2] += (gz - p[i * 3 + 2]) * k;
      }
    }
    // 4. collisions
    if (P.collision && colliders.length) {
      collided.fill(0);
      for (let pass = 0; pass < Math.max(1, P.collision.quality); pass++)
        for (let i = 0; i < n; i++) {
          if (w[i] === 0) continue;
          const k = i * 3;
          let px = p[k],
            py = p[k + 1],
            pz = p[k + 2];
          const ox = x[k],
            oy = x[k + 1],
            oz = x[k + 2];
          // tunnelling: segment from the previous position crosses a surface
          if (pass === 0 && segmentHit(colliders, ox, oy, oz, px, py, pz, hit, thick)) {
            const th = thick + (hit.collider!.settings.thickness_outer ?? 0.02);
            const side = (ox - hit.cx) * hit.nx + (oy - hit.cy) * hit.ny + (oz - hit.cz) * hit.nz >= 0 ? 1 : -1;
            const single = hit.collider!.settings.use_culling;
            const sg = single ? 1 : side;
            px = hit.cx + hit.nx * th * sg;
            py = hit.cy + hit.ny * th * sg;
            pz = hit.cz + hit.nz * th * sg;
            collided[i] = 1;
          }
          const r = thick + 0.1;
          if (closestSurface(colliders, px, py, pz, r, hit)) {
            const cs = hit.collider!.settings;
            const th = thick + (cs.thickness_outer ?? 0.02);
            const s = (px - hit.cx) * hit.nx + (py - hit.cy) * hit.ny + (pz - hit.cz) * hit.nz;
            const sPrev = (ox - hit.cx) * hit.nx + (oy - hit.cy) * hit.ny + (oz - hit.cz) * hit.nz;
            const side = cs.use_culling ? 1 : sPrev >= 0 ? 1 : -1;
            if (hit.dist < th && !(cs.use_culling && sPrev < -th)) {
              let dx = hit.nx * side,
                dy = hit.ny * side,
                dz = hit.nz * side;
              if (hit.dist > 1e-6 && s * side > 0) {
                dx = (px - hit.cx) / hit.dist;
                dy = (py - hit.cy) / hit.dist;
                dz = (pz - hit.cz) / hit.dist;
              }
              px = hit.cx + dx * th;
              py = hit.cy + dy * th;
              pz = hit.cz + dz * th;
              // friction relative to the moving surface
              const fr = 1 - Math.exp(-(cs.cloth_friction ?? 5) * 0.05);
              const sv = 1 / P.substeps;
              const rx = px - ox - hit.vx * sv,
                ry = py - oy - hit.vy * sv,
                rz = pz - oz - hit.vz * sv;
              const rn = rx * dx + ry * dy + rz * dz;
              px -= (rx - dx * rn) * fr;
              py -= (ry - dy * rn) * fr;
              pz -= (rz - dz * rn) * fr;
              collided[i] = 1;
            }
          }
          p[k] = px;
          p[k + 1] = py;
          p[k + 2] = pz;
        }
    }
    // 5. self collision (vertex-vertex)
    if (P.self && P.self.distance > 0) selfCollide(p, x, w, P.self.distance, P.self.friction, restShape ?? targets1, P.selfStiffness ?? 1);
    // 6. velocities
    for (let i = 0; i < n * 3; i++) {
      v[i] = (p[i] - x[i]) / h;
      x[i] = p[i];
    }
    // contact damping
    if (P.collision)
      for (let i = 0; i < n; i++)
        if (collided[i]) {
          // reuse the collider damping of the nearest surface
          const k = i * 3;
          if (closestSurface(colliders, x[k], x[k + 1], x[k + 2], thick + 0.1, hit)) {
            const d = Math.min(1, Math.max(0, hit.collider!.settings.damping ?? 0) + Math.max(0, P.choke ?? 0));
            v[k] *= 1 - d;
            v[k + 1] *= 1 - d;
            v[k + 2] *= 1 - d;
          }
        }
    // constraint damping (relative velocity along constraints)
    const A = topo.a,
      B = topo.b,
      K = topo.kind;
    for (let c = 0; c < A.length; c++) {
      const i = A[c],
        j = B[c];
      const ws = w[i] + w[j];
      if (ws === 0) continue;
      const ia = i * 3,
        ja = j * 3;
      const dx = x[ia] - x[ja],
        dy = x[ia + 1] - x[ja + 1],
        dz = x[ia + 2] - x[ja + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-12) continue;
      const kind = K[c];
      const damp = kind === KIND_STRUCT || kind === KIND_INTERNAL ? (len > topo.rest[c] ? P.damping[0] : P.damping[1]) : kind === KIND_SHEAR ? P.damping[2] : kind === KIND_SEW ? 0 : P.damping[3];
      if (damp <= 0) continue;
      const nx = dx / len,
        ny = dy / len,
        nz = dz / len;
      const rel = (v[ia] - v[ja]) * nx + (v[ia + 1] - v[ja + 1]) * ny + (v[ia + 2] - v[ja + 2]) * nz;
      const dv = rel * Math.min(1, damp * h);
      const fi = w[i] / ws,
        fj = w[j] / ws;
      v[ia] -= nx * dv * fi;
      v[ia + 1] -= ny * dv * fi;
      v[ia + 2] -= nz * dv * fi;
      v[ja] += nx * dv * fj;
      v[ja + 1] += ny * dv * fj;
      v[ja + 2] += nz * dv * fj;
    }
    // goal friction: damp velocity relative to the goal motion
    if (gw && gw.friction > 0)
      for (let i = 0; i < n; i++) {
        const g = gw.weights[i];
        if (g <= 0) continue;
        const k = i * 3;
        const a = Math.min(1, gw.friction * g * h * 10);
        for (let c = 0; c < 3; c++) {
          const gv = (targets1[k + c] - targets0[k + c]) / P.dt;
          v[k + c] += (gv - v[k + c]) * a;
        }
      }
  }
  // plasticity: rest lengths creep towards the current lengths
  if (P.plastic && P.plastic > 0) {
    const A = topo.a,
      B = topo.b,
      R = topo.rest;
    const rate = Math.min(1, P.plastic);
    for (let c = 0; c < A.length; c++) {
      if (topo.kind[c] !== KIND_STRUCT) continue;
      const ia = A[c] * 3,
        ja = B[c] * 3;
      const len = Math.hypot(x[ia] - x[ja], x[ia + 1] - x[ja + 1], x[ia + 2] - x[ja + 2]);
      R[c] += (len - R[c]) * rate;
    }
  }
}

function selfCollide(p: Float64Array, x: Float64Array, w: Float64Array, dist: number, friction: number, rest: ArrayLike<number>, stiffness = 1) {
  const n = w.length;
  const cell = dist * 2;
  const grid = new Map<number, number[]>();
  const key = (ix: number, iy: number, iz: number) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(p[i * 3] / cell), Math.floor(p[i * 3 + 1] / cell), Math.floor(p[i * 3 + 2] / cell));
    let l = grid.get(k);
    if (!l) grid.set(k, (l = []));
    l.push(i);
  }
  const fr = 1 - Math.exp(-friction * 0.05);
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(p[i * 3] / cell),
      iy = Math.floor(p[i * 3 + 1] / cell),
      iz = Math.floor(p[i * 3 + 2] / cell);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++) {
          const l = grid.get(key(ix + a, iy + b, iz + c));
          if (!l) continue;
          for (const j of l) {
            if (j <= i) continue;
            const ws = w[i] + w[j];
            if (ws === 0) continue;
            const dx = p[i * 3] - p[j * 3],
              dy = p[i * 3 + 1] - p[j * 3 + 1],
              dz = p[i * 3 + 2] - p[j * 3 + 2];
            const d = Math.hypot(dx, dy, dz);
            if (d >= dist || d < 1e-9) continue;
            // neighbours that are close at rest are not colliding
            const rd = Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]);
            if (rd < dist * 2) continue;
            const corr = ((dist - d) / ws) * Math.max(0, Math.min(1, stiffness));
            const nx = dx / d,
              ny = dy / d,
              nz = dz / d;
            p[i * 3] += nx * corr * w[i];
            p[i * 3 + 1] += ny * corr * w[i];
            p[i * 3 + 2] += nz * corr * w[i];
            p[j * 3] -= nx * corr * w[j];
            p[j * 3 + 1] -= ny * corr * w[j];
            p[j * 3 + 2] -= nz * corr * w[j];
            // friction: average the tangential displacement
            for (let k = 0; k < 3; k++) {
              const di = p[i * 3 + k] - x[i * 3 + k],
                dj = p[j * 3 + k] - x[j * 3 + k];
              const avg = (di + dj) / 2;
              p[i * 3 + k] += (avg - di) * fr * 0.5;
              p[j * 3 + k] += (avg - dj) * fr * 0.5;
            }
          }
        }
  }
}

/** Signed volume of a closed triangle mesh. */
export function meshVolume(x: ArrayLike<number>, tris: Uint32Array): number {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const i = tris[t] * 3,
      j = tris[t + 1] * 3,
      k = tris[t + 2] * 3;
    v += x[i] * (x[j + 1] * x[k + 2] - x[j + 2] * x[k + 1]) - x[i + 1] * (x[j] * x[k + 2] - x[j + 2] * x[k]) + x[i + 2] * (x[j] * x[k + 1] - x[j + 1] * x[k]);
  }
  return v / 6;
}

const PRESSURE_SCALE = 100;

/** Outward pressure forces per vertex (area weighted), from a uniform pressure, a volume-preserving
 *  term and the weight of a fluid filling the mesh. */
function pressureForces(x: Float64Array, tris: Uint32Array, pr: NonNullable<PBDParams['pressure']>, restVolume: number, gravity: [number, number, number], out: Float64Array) {
  out.fill(0);
  const vol = meshVolume(x, tris);
  const sign = vol < 0 ? -1 : 1;
  const V = Math.abs(vol);
  const target = pr.targetVolume > 0 ? pr.targetVolume : restVolume;
  // pressure settings are in the same units as the cloth stiffness (×1000 internally)
  let P = pr.uniform * PRESSURE_SCALE;
  if (pr.factor && V > 1e-9 && target > 0) P += pr.factor * PRESSURE_SCALE * (target / V - 1);
  const g = Math.hypot(gravity[0], gravity[1], gravity[2]);
  const gx = g > 0 ? gravity[0] / g : 0,
    gy = g > 0 ? gravity[1] / g : 0,
    gz = g > 0 ? gravity[2] / g : -1;
  // the fluid surface is at the highest point against gravity
  let top = Infinity;
  if (pr.density) for (let i = 0; i < x.length; i += 3) top = Math.min(top, x[i] * gx + x[i + 1] * gy + x[i + 2] * gz);
  for (let t = 0; t < tris.length; t += 3) {
    const i = tris[t] * 3,
      j = tris[t + 1] * 3,
      k = tris[t + 2] * 3;
    const e1x = x[j] - x[i],
      e1y = x[j + 1] - x[i + 1],
      e1z = x[j + 2] - x[i + 2];
    const e2x = x[k] - x[i],
      e2y = x[k + 1] - x[i + 1],
      e2z = x[k + 2] - x[i + 2];
    // normal with length = 2 × area, oriented outwards
    const nx = (e1y * e2z - e1z * e2y) * sign,
      ny = (e1z * e2x - e1x * e2z) * sign,
      nz = (e1x * e2y - e1y * e2x) * sign;
    let p = P;
    if (pr.density) {
      const depth = ((x[i] + x[j] + x[k]) * gx + (x[i + 1] + x[j + 1] + x[k + 1]) * gy + (x[i + 2] + x[j + 2] + x[k + 2]) * gz) / 3 - top;
      p += pr.density * PRESSURE_SCALE * 0.01 * g * Math.max(0, depth);
    }
    for (const v of [i, j, k]) {
      const wv = pr.weights ? pr.weights[v / 3] : 1;
      out[v] += (nx * p * wv) / 6;
      out[v + 1] += (ny * p * wv) / 6;
      out[v + 2] += (nz * p * wv) / 6;
    }
  }
}
