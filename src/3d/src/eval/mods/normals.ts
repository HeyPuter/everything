// Normal Edit: custom split normals pointing away from an ellipsoid center (radial) or towards a
// target (directional), mixed with the existing normals.
import { Vector3 } from 'three';
import type { MeshData, ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, objId, str, targetToLocal, vec, vgroupFactor } from './common';
import { cornerNormals, polyNormal } from '../../mesh/mesh';

/** The mesh's current shading normals per corner (custom normals when present). */
export function currentCornerNormals(m: EvalMesh): Float32Array {
  if (m.custom_normals && m.custom_normals.length === m.indices.length * 3) return m.custom_normals;
  return cornerNormals({ ...(m as unknown as MeshData), sharp: m.sharp }, m.positions);
}

function mixNormal(orig: Vector3, nw: Vector3, mode: string, factor: number, limit: number, out: Vector3) {
  switch (mode) {
    case 'ADD':
      nw.add(orig).normalize();
      break;
    case 'SUB':
      nw.multiplyScalar(-1).add(orig).normalize();
      break;
    case 'MUL':
      nw.multiply(orig).normalize();
      break;
  }
  out.copy(orig).lerp(nw, factor);
  if (out.lengthSq() < 1e-12) out.copy(orig);
  out.normalize();
  // never turn further than the angle limit away from the original normal
  if (limit < Math.PI) {
    const ang = orig.angleTo(out);
    if (ang > limit && ang > 1e-9) {
      const axis = new Vector3().crossVectors(orig, out);
      if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0).cross(orig);
      out.copy(orig).applyAxisAngle(axis.normalize(), limit);
    }
  }
}

export function normalEdit(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const P = m.positions,
    nv = P.length / 3,
    nc = m.indices.length;
  if (!nc) return m;
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], P[i]);
    hi[i % 3] = Math.max(hi[i % 3], P[i]);
  }
  const off = vec(mod, 'offset', [0, 0, 0]);
  const center = new Vector3((lo[0] + hi[0]) / 2 + off[0], (lo[1] + hi[1]) / 2 + off[1], (lo[2] + hi[2]) / 2 + off[2]);
  const tm = targetToLocal(ctx, objId(mod, 'target'));
  const target = tm ? new Vector3().setFromMatrixPosition(tm) : null;
  const radial = str(mod, 'mode', 'RADIAL') === 'RADIAL';
  const half = [0, 1, 2].map((k) => Math.max((hi[k] - lo[k]) / 2, 1e-6));
  // per-vertex new normal
  const vn = new Float32Array(nv * 3);
  const p = new Vector3(),
    d = new Vector3();
  for (let i = 0; i < nv; i++) {
    p.fromArray(P, i * 3);
    if (radial) {
      if (target) d.subVectors(p, target);
      else {
        d.subVectors(p, center);
        // points on an ellipsoid fitted to the bounds: the gradient divides by the squared radii
        d.set(d.x / (half[0] * half[0]), d.y / (half[1] * half[1]), d.z / (half[2] * half[2]));
      }
    } else {
      const t = target ?? new Vector3(0, 0, 1).add(center);
      if (bool(mod, 'use_direction_parallel')) d.subVectors(t, center);
      else d.subVectors(t, p).add(new Vector3().subVectors(t, center));
    }
    d.normalize();
    vn[i * 3] = d.x;
    vn[i * 3 + 1] = d.y;
    vn[i * 3 + 2] = d.z;
  }
  const orig = currentCornerNormals(m);
  const factor = num(mod, 'mix_factor', 1),
    limit = num(mod, 'mix_limit', Math.PI),
    mode = str(mod, 'mix_mode', 'COPY');
  const w = vgroupFactor(m, mod);
  const out = new Float32Array(nc * 3);
  const o = new Vector3(),
    n = new Vector3(),
    r = new Vector3();
  for (let c = 0; c < nc; c++) {
    const v = m.indices[c];
    o.fromArray(orig, c * 3);
    n.fromArray(vn, v * 3);
    mixNormal(o, n, mode, factor * (w ? w[v] : 1), limit, r);
    out[c * 3] = r.x;
    out[c * 3 + 1] = r.y;
    out[c * 3 + 2] = r.z;
  }
  let res: EvalMesh = { ...m, smooth: new Uint8Array(m.offsets.length - 1).fill(1), custom_normals: out };
  if (!bool(mod, 'no_polynors_fix')) res = flipToNormals(res);
  return res;
}

/** Reverse faces whose custom normals point against the face normal (keeping corner data aligned). */
function flipToNormals(m: EvalMesh): EvalMesh {
  const cn = m.custom_normals!;
  const nf = m.offsets.length - 1;
  const fn: [number, number, number] = [0, 0, 0];
  const flip: number[] = [];
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    polyNormal(m.positions, m.indices.subarray(s, e), fn);
    let dot = 0;
    for (let c = s; c < e; c++) dot += cn[c * 3] * fn[0] + cn[c * 3 + 1] * fn[1] + cn[c * 3 + 2] * fn[2];
    if (dot < 0) flip.push(f);
  }
  if (!flip.length) return m;
  const indices = new Uint32Array(m.indices),
    uvs = new Float32Array(m.uvs),
    normals = new Float32Array(cn);
  const colors = m.colors ? new Float32Array(m.colors) : undefined;
  const per = <T extends Float32Array | Uint32Array>(arr: T | undefined) => (arr ? (arr.slice() as T) : undefined);
  const seams = per(m.seams),
    sharp = per(m.sharp),
    creases = per(m.creases);
  for (const f of flip) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      k = e - s;
    // keep the first corner, reverse the rest: corner i ↔ (k - i) % k
    for (let i = 0; i < k; i++) {
      const src = s + ((k - i) % k),
        dst = s + i;
      indices[dst] = m.indices[src];
      uvs[dst * 2] = m.uvs[src * 2];
      uvs[dst * 2 + 1] = m.uvs[src * 2 + 1];
      for (let a = 0; a < 3; a++) normals[dst * 3 + a] = cn[src * 3 + a];
      if (colors) for (let a = 0; a < 4; a++) colors[dst * 4 + a] = m.colors![src * 4 + a];
      // the edge starting at the new corner i was the edge ending at the old corner
      const edgeSrc = s + ((k - i - 1 + k) % k);
      if (seams) seams[dst] = m.seams![edgeSrc];
      if (sharp) sharp[dst] = m.sharp![edgeSrc];
      if (creases) creases[dst] = m.creases![edgeSrc];
    }
  }
  return { ...m, indices, uvs, custom_normals: normals, colors, seams, sharp, creases };
}

export const normalModifiers: ModifierType[] = [
  {
    type: 'NORMAL_EDIT',
    label: 'Normal Edit',
    category: 'NORMALS',
    icon: 'mod_normaledit_radial',
    defaults: () => ({ mode: 'RADIAL', target: null, offset: [0, 0, 0], use_direction_parallel: false, mix_mode: 'COPY', mix_factor: 1, mix_limit: Math.PI, no_polynors_fix: false, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.target as string],
    supportsEditMode: true,
    apply: normalEdit,
  },
];

for (const t of normalModifiers) registerModifier(t);
