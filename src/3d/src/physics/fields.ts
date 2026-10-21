// Force fields (effectors) on objects: Force, Wind, Vortex, Magnetic, Harmonic, Lennard-Jones,
// Turbulence, Drag (Curve Guide acts on particles directly, see guides.ts).
// Evaluated per point as an acceleration-like force; callers divide by mass. The field shape
// (point, line, plane, surface or every vertex) decides where distances are measured from.
import { Matrix4, Vector3 } from 'three';
import type { DocumentData, ObjectData } from '../data/types';
import { caches, hash32, motionKey, worldAt, type FrameCache, type SimContext } from './common';
import type { ForceFieldX } from './types';
import { meshSignature } from '../eval/depsgraph';
import type { EvalMesh } from '../eval/types';
import { closestOnTriangle, meshTriangles } from '../eval/geomquery';

export interface Effector {
  id: string;
  field: ForceFieldX;
  /** world position and unit Z axis of the field object */
  px: number;
  py: number;
  pz: number;
  ax: number;
  ay: number;
  az: number;
  inv: Matrix4;
  scale: number;
  /** world matrix of the field object */
  world: Matrix4;
  /** world-space vertex positions (surface / every point shapes) */
  points?: Float32Array;
  /** world-space triangles of the field mesh (surface shape) */
  tris?: Uint32Array;
}

export function fieldObjects(doc: DocumentData): ObjectData[] {
  const out: ObjectData[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (ob?.field && ob.field.type !== 'NONE' && !ob.hide_viewport) out.push(ob);
  }
  return out;
}

/** Particle systems whose particles act as force fields (Force Field Settings of their settings). */
export function particleFieldSystems(doc: DocumentData): { ob: ObjectData; modId: string; s: Record<string, unknown>; fields: ForceFieldX[] }[] {
  const out: { ob: ObjectData; modId: string; s: Record<string, unknown>; fields: ForceFieldX[] }[] = [];
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (!ob || ob.hide_viewport) continue;
    for (const ps of ob.particle_systems as { id?: string; settings: string }[]) {
      const s = doc.particles[ps.settings] as unknown as Record<string, unknown> | undefined;
      if (!s || s.type === 'HAIR') continue;
      const fields = [s.force_field_1, s.force_field_2].filter((f): f is ForceFieldX => !!f && typeof f === 'object' && (f as ForceFieldX).type !== 'NONE');
      if (!fields.length) continue;
      const m = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && x.particle_system === ps.id);
      if (m) out.push({ ob, modId: m.id, s, fields });
    }
  }
  return out;
}

/** Settings + motion signature of all fields (part of simulation cache hashes). */
export function fieldsKey(doc: DocumentData, refFrame: number): string {
  const parts = particleFieldSystems(doc).map((p) => `P:${p.ob.id}:${JSON.stringify(p.fields)}:${p.s.effector_amount}:${p.s.use_self_effect}:${p.s.count}:${p.s.frame_start}:${p.s.frame_end}:${p.s.lifetime}:${motionKey(doc, p.ob, refFrame)}`);
  return parts.join('|') + fieldObjects(doc)
    .map((ob) => {
      let k = `${ob.id}:${JSON.stringify(ob.field)}:${motionKey(doc, ob, refFrame)}`;
      // guides follow their curve, surface/point fields their mesh
      if (ob.field!.type === 'GUIDE' && ob.type === 'CURVE' && ob.data && doc.curves[ob.data]) k += ':' + JSON.stringify(doc.curves[ob.data].splines);
      const shape = (ob.field as ForceFieldX).shape;
      if ((shape === 'SURFACE' || shape === 'POINTS') && ob.type === 'MESH' && ob.data && doc.meshes[ob.data]) k += ':' + meshSignature(doc.meshes[ob.data]);
      return k;
    })
    .join('|');
}

export function collectEffectors(ctx: SimContext, frame: number, exclude?: string): Effector[] {
  const out: Effector[] = [];
  for (const ob of fieldObjects(ctx.doc)) {
    if (ob.id === exclude) continue;
    const m = worldAt(ctx, ob, frame);
    const e = m.elements;
    const z = new Vector3(e[8], e[9], e[10]);
    const scale = z.length() || 1;
    z.normalize();
    const eff: Effector = { id: ob.id, field: ob.field as ForceFieldX, px: e[12], py: e[13], pz: e[14], ax: z.x, ay: z.y, az: z.z, inv: m.clone().invert(), scale, world: m };
    const shape = (ob.field as ForceFieldX).shape;
    const me = ob.type === 'MESH' && ob.data ? ctx.doc.meshes[ob.data] : undefined;
    if ((shape === 'SURFACE' || shape === 'POINTS') && me) {
      const P = me.positions;
      const W = new Float32Array(P.length);
      const v = new Vector3();
      for (let i = 0; i < P.length; i += 3) {
        v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(m);
        W[i] = v.x;
        W[i + 1] = v.y;
        W[i + 2] = v.z;
      }
      eff.points = W;
      if (shape === 'SURFACE') eff.tris = meshTriangles({ positions: W, offsets: me.offsets, indices: me.indices } as EvalMesh);
    }
    out.push(eff);
  }
  // particles acting as force fields (their own system only feels them with Self Effect)
  for (const p of particleFieldSystems(ctx.doc)) {
    if (p.ob.id === exclude && !p.s.use_self_effect) continue;
    const c = caches.get(`PARTICLES:${p.ob.id}:${p.modId}`) as FrameCache<{ pos: Float32Array; state: Uint8Array }> | undefined;
    const fr = c?.frames.get(Math.round(frame)) ?? c?.nearest(Math.round(frame));
    if (!fr) continue;
    const amount = Math.max(0, Math.round((p.s.effector_amount as number) ?? 0));
    const n = fr.state.length;
    const step = amount > 0 ? Math.max(1, Math.floor(n / amount)) : 1;
    let used = 0;
    for (let i = 0; i < n; i += step) {
      if (fr.state[i] !== 1) continue;
      if (amount > 0 && used >= amount) break;
      used++;
      const m = new Matrix4().makeTranslation(fr.pos[i * 3], fr.pos[i * 3 + 1], fr.pos[i * 3 + 2]);
      for (const f of p.fields) out.push({ id: p.ob.id, field: f, px: fr.pos[i * 3], py: fr.pos[i * 3 + 1], pz: fr.pos[i * 3 + 2], ax: 0, ay: 0, az: 1, inv: m.clone().invert(), scale: 1, world: m });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smooth 3D value noise (own implementation) for turbulence and noise amounts.

function lattice(ix: number, iy: number, iz: number, seed: number, ch: number) {
  return hash32(ix, iy, iz, seed * 4 + ch) / 2147483648 - 1;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise(x: number, y: number, z: number, seed: number, ch: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z);
  const fx = fade(x - ix),
    fy = fade(y - iy),
    fz = fade(z - iz);
  let r = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1,
      dy = (k >> 1) & 1,
      dz = (k >> 2) & 1;
    const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    r += w * lattice(ix + dx, iy + dy, iz + dz, seed, ch);
  }
  return r;
}

function falloff(f: ForceFieldX, dist: number, radial: number, axial: number): number {
  if (f.use_max_distance && (f.distance_max ?? 0) > 0 && dist > f.distance_max!) return 0;
  if (f.use_min_distance && dist < (f.distance_min ?? 0)) return 0;
  const power = f.falloff_power ?? 0;
  if (power <= 0) return 1;
  let r = dist;
  if (f.falloff_type === 'TUBE') r = radial;
  else if (f.falloff_type === 'CONE') r = dist * (1 + Math.max(0, radial / Math.max(1e-6, Math.abs(axial))));
  // 1 / r^power, limited near the field origin to keep the integration stable
  return 1 / Math.pow(Math.max(r, 0.1), power);
}

const _p = new Vector3(),
  _a = new Vector3(),
  _b = new Vector3(),
  _c = new Vector3(),
  _q = new Vector3();

/** Field origins a point is measured against for an effector's shape (written to `out`, x y z triples). */
function shapeOrigins(e: Effector, x: number, y: number, z: number, out: number[]): number {
  const shape = e.field.shape ?? 'POINT';
  const dx = x - e.px,
    dy = y - e.py,
    dz = z - e.pz;
  const axial = dx * e.ax + dy * e.ay + dz * e.az;
  if (shape === 'LINE') {
    out[0] = e.px + e.ax * axial;
    out[1] = e.py + e.ay * axial;
    out[2] = e.pz + e.az * axial;
    return 1;
  }
  if (shape === 'PLANE') {
    out[0] = x - e.ax * axial;
    out[1] = y - e.ay * axial;
    out[2] = z - e.az * axial;
    return 1;
  }
  if (shape === 'POINTS' && e.points) {
    const n = Math.min(e.points.length / 3, 4096);
    for (let i = 0; i < n * 3; i++) out[i] = e.points[i];
    return n;
  }
  if (shape === 'SURFACE' && e.points && e.tris?.length) {
    _p.set(x, y, z);
    let best = Infinity;
    for (let t = 0; t < e.tris.length; t += 3) {
      _a.fromArray(e.points, e.tris[t] * 3);
      _b.fromArray(e.points, e.tris[t + 1] * 3);
      _c.fromArray(e.points, e.tris[t + 2] * 3);
      closestOnTriangle(_p, _a, _b, _c, _q);
      const d = _q.distanceToSquared(_p);
      if (d < best) {
        best = d;
        out[0] = _q.x;
        out[1] = _q.y;
        out[2] = _q.z;
      }
    }
    if (best < Infinity) return 1;
  }
  out[0] = e.px;
  out[1] = e.py;
  out[2] = e.pz;
  return 1;
}

const origins: number[] = [];

/**
 * Accumulate the force of all effectors at a point with velocity v into out.
 * `normal` (optional) makes wind act like pressure on a surface (cloth).
 */
export function effectorForce(
  effs: Effector[],
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  time: number,
  out: Float64Array | number[],
  weight0 = 1,
  normal?: [number, number, number] | null,
  typeWeights?: Record<string, number> | null,
) {
  if (!effs.length || weight0 === 0) return;
  for (const e of effs) {
    const f = e.field;
    // per field type weights (Field Weights panels)
    const weight = typeWeights ? weight0 * (typeWeights[f.type] ?? 1) : weight0;
    if (weight === 0) continue;
    const S = f.strength * weight;
    const n = shapeOrigins(e, x, y, z, origins);
    for (let o = 0; o < n; o++) {
      const ox = origins[o * 3],
        oy = origins[o * 3 + 1],
        oz = origins[o * 3 + 2];
      // radial/axial relative to the field axis (tube and cone falloffs, vortices)
      const ex = x - e.px,
        ey = y - e.py,
        ez = z - e.pz;
      const axial = ex * e.ax + ey * e.ay + ez * e.az;
      const rx = ex - axial * e.ax,
        ry = ey - axial * e.ay,
        rz = ez - axial * e.az;
      const radial = Math.hypot(rx, ry, rz);
      const dx = x - ox,
        dy = y - oy,
        dz = z - oz;
      const dist = Math.hypot(dx, dy, dz);
      let fx = 0,
        fy = 0,
        fz = 0;
      switch (f.type) {
        case 'FORCE': {
          const fo = falloff(f, dist, radial, axial);
          if (dist > 1e-6 && fo) {
            fx = (dx / dist) * S * fo;
            fy = (dy / dist) * S * fo;
            fz = (dz / dist) * S * fo;
          }
          break;
        }
        case 'WIND': {
          // planar: distance measured along the field axis
          const fo = falloff(f, Math.abs(axial), radial, axial);
          fx = e.ax * S * fo;
          fy = e.ay * S * fo;
          fz = e.az * S * fo;
          break;
        }
        case 'VORTEX': {
          const fo = falloff(f, radial, radial, axial);
          if (radial > 1e-6 && fo) {
            // tangential direction: axis × radial, plus an optional pull towards the axis (inflow)
            const inflow = f.inflow ?? 0;
            fx = (((e.ay * rz - e.az * ry) - rx * inflow) / radial) * S * fo;
            fy = (((e.az * rx - e.ax * rz) - ry * inflow) / radial) * S * fo;
            fz = (((e.ax * ry - e.ay * rx) - rz * inflow) / radial) * S * fo;
          }
          break;
        }
        case 'MAGNET': {
          // perpendicular to both the velocity and the field axis
          const fo = falloff(f, dist, radial, axial);
          fx = (vy * e.az - vz * e.ay) * S * fo;
          fy = (vz * e.ax - vx * e.az) * S * fo;
          fz = (vx * e.ay - vy * e.ax) * S * fo;
          break;
        }
        case 'HARMONIC': {
          // a spring towards the field (with an optional rest length) and its damping
          const fo = falloff(f, dist, radial, axial);
          const rest = f.rest_length ?? 0;
          const stretch = dist - rest;
          if (dist > 1e-9) {
            fx = (-(dx / dist) * stretch * S) * fo;
            fy = (-(dy / dist) * stretch * S) * fo;
            fz = (-(dz / dist) * stretch * S) * fo;
          }
          const hd = (f.harmonic_damping ?? 1) * weight;
          fx -= vx * hd * fo;
          fy -= vy * hd * fo;
          fz -= vz * hd * fo;
          break;
        }
        case 'LENNARDJ': {
          // strong repulsion when closer than the size, weak attraction a little further out
          const fo = falloff(f, dist, radial, axial);
          const r0 = Math.max(1e-3, f.size ?? 1);
          const r = Math.max(dist, r0 * 0.4);
          const k6 = Math.pow(r0 / r, 6);
          const mag = S * (k6 * k6 - k6) * fo;
          if (dist > 1e-9) {
            fx = (dx / dist) * mag;
            fy = (dy / dist) * mag;
            fz = (dz / dist) * mag;
          }
          break;
        }
        case 'TURBULENCE': {
          const fo = falloff(f, dist, radial, axial);
          const size = Math.max(1e-3, f.size ?? 1);
          const seed = f.seed ?? 1;
          const t = time * 0.05;
          fx = valueNoise(x / size + t, y / size, z / size, seed, 0) * S * fo * 2;
          fy = valueNoise(x / size, y / size + t, z / size, seed, 1) * S * fo * 2;
          fz = valueNoise(x / size, y / size, z / size + t, seed, 2) * S * fo * 2;
          break;
        }
        case 'DRAG': {
          const fo = falloff(f, dist, radial, axial);
          const sp = Math.hypot(vx, vy, vz);
          const k = (f.strength + f.flow * sp) * fo * weight;
          out[0] -= vx * k;
          out[1] -= vy * k;
          out[2] -= vz * k;
          continue;
        }
        default:
          continue;
      }
      // noise amount (random variation of the force)
      if (f.noise && f.type !== 'TURBULENCE') {
        const nz = f.noise * Math.abs(S);
        const seed = f.seed ?? 1;
        fx += valueNoise(x * 2 + time * 0.3, y * 2, z * 2, seed, 3) * nz;
        fy += valueNoise(x * 2, y * 2 + time * 0.3, z * 2, seed, 4) * nz;
        fz += valueNoise(x * 2, y * 2, z * 2 + time * 0.3, seed, 5) * nz;
      }
      // surfaces (cloth) catch wind like a sail: only the normal component pushes
      if (normal && f.type === 'WIND') {
        const d = fx * normal[0] + fy * normal[1] + fz * normal[2];
        fx = normal[0] * d;
        fy = normal[1] * d;
        fz = normal[2] * d;
      }
      // flow: the field becomes a target air velocity instead of a constant force
      if (f.flow > 0 && (f.type === 'FORCE' || f.type === 'WIND' || f.type === 'VORTEX')) {
        fx = f.flow * (fx - vx);
        fy = f.flow * (fy - vy);
        fz = f.flow * (fz - vz);
      }
      out[0] += fx;
      out[1] += fy;
      out[2] += fz;
    }
  }
}
