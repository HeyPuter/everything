// UV modifiers: UV Project (projection from objects/cameras) and UV Warp (2D transform of the
// UV map, optionally driven by two objects).
import { Matrix4, Vector3 } from 'three';
import type { CameraData, ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { num, objId, str, vec, vgroupFactor, worldOf } from './common';
import { polyNormal } from '../../mesh/mesh';

export interface Projector {
  /** world → projector local */
  inv: Matrix4;
  /** world-space viewing direction (projector -Z) */
  dir: Vector3;
  camera?: CameraData;
}

/** UV of a world-space point seen from a projector (camera frustum or object XY square). */
export function projectPoint(pr: Projector, p: Vector3, aspX: number, aspY: number, scaleX: number, scaleY: number, out: [number, number]) {
  const q = p.clone().applyMatrix4(pr.inv);
  const cam = pr.camera;
  if (!cam) {
    out[0] = q.x * 0.5 + 0.5;
    out[1] = q.y * 0.5 + 0.5;
    return;
  }
  let x: number, y: number;
  if (cam.type === 'ORTHO') {
    const s = cam.ortho_scale || 1;
    x = q.x / s;
    y = q.y / s;
  } else {
    const sensor = cam.sensor_fit === 'VERTICAL' ? cam.sensor_height : cam.sensor_width;
    const d = -q.z;
    const hw = (Math.abs(d) < 1e-9 ? 1e-9 : d) * sensor / (cam.lens || 50);
    x = q.x / hw;
    y = q.y / hw;
  }
  // non-square projections: stretch the shorter side
  if (aspX > aspY) y *= aspX / aspY;
  else if (aspY > aspX) x *= aspY / aspX;
  out[0] = 0.5 + x / (scaleX || 1) - (cam.shift_x ?? 0);
  out[1] = 0.5 + y / (scaleY || 1) - (cam.shift_y ?? 0);
}

function uvProject(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const ids = ((mod.projectors as (string | null)[] | undefined) ?? []).slice(0, Math.max(1, Math.round(num(mod, 'projector_count', 1))));
  const projectors: Projector[] = [];
  for (const id of ids) {
    const ev = id ? ctx.graph?.get(id) : undefined;
    if (!ev) continue;
    const cam = ev.ob.type === 'CAMERA' && ev.ob.data ? ctx.doc.cameras[ev.ob.data] : undefined;
    const dir = new Vector3(0, 0, -1).transformDirection(ev.world);
    projectors.push({ inv: ev.world.clone().invert(), dir, camera: cam });
  }
  if (!projectors.length) return m;
  const own = worldOf(ctx);
  const nrm = new Matrix4().copy(own).invert().transpose();
  const aspX = num(mod, 'aspect_x', 1),
    aspY = num(mod, 'aspect_y', 1),
    sx = num(mod, 'scale_x', 1),
    sy = num(mod, 'scale_y', 1);
  const P = m.positions;
  const W = new Float32Array(P.length);
  const v = new Vector3();
  for (let i = 0; i < P.length; i += 3) {
    v.fromArray(P, i).applyMatrix4(own);
    W[i] = v.x;
    W[i + 1] = v.y;
    W[i + 2] = v.z;
  }
  const uvs = new Float32Array(m.uvs);
  const n: [number, number, number] = [0, 0, 0];
  const fn = new Vector3();
  const uv: [number, number] = [0, 0];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    let pr = projectors[0];
    if (projectors.length > 1) {
      // the projector that looks most directly at the face
      polyNormal(P, m.indices.subarray(s, e), n);
      fn.set(n[0], n[1], n[2]).applyMatrix4(nrm).normalize();
      let best = -Infinity;
      for (const q of projectors) {
        const d = -q.dir.dot(fn);
        if (d > best) {
          best = d;
          pr = q;
        }
      }
    }
    for (let c = s; c < e; c++) {
      v.fromArray(W, m.indices[c] * 3);
      projectPoint(pr, v, aspX, aspY, sx, sy, uv);
      uvs[c * 2] = uv[0];
      uvs[c * 2 + 1] = uv[1];
    }
  }
  return { ...m, uvs };
}

/** The 3D transform UV Warp derives from its two objects (identity when either is missing). */
function warpObjectMatrix(mod: ModifierBase, ctx: ModifierContext): Matrix4 | null {
  const a = objId(mod, 'object_from'),
    b = objId(mod, 'object_to');
  const ea = a ? ctx.graph?.get(a) : undefined,
    eb = b ? ctx.graph?.get(b) : undefined;
  if (!ea || !eb) return null;
  const fromM = ea.world.clone(),
    toM = eb.world.clone();
  const bf = typeof mod.bone_from === 'string' && mod.bone_from ? ea.pose?.bones.get(mod.bone_from) : undefined;
  if (bf) fromM.multiply(bf.pose);
  const bt = typeof mod.bone_to === 'string' && mod.bone_to ? eb.pose?.bones.get(mod.bone_to) : undefined;
  if (bt) toM.multiply(bt.pose);
  return toM.invert().multiply(fromM);
}

export function uvWarpMatrix(mod: ModifierBase, ctx: ModifierContext) {
  const off = vec(mod, 'offset', [0, 0]),
    sc = vec(mod, 'scale', [1, 1]);
  const rot = num(mod, 'rotation', 0);
  const c = Math.cos(rot),
    s = Math.sin(rot);
  const obj = warpObjectMatrix(mod, ctx);
  const au = ['X', 'Y', 'Z'].indexOf(str(mod, 'axis_u', 'X')),
    av = ['X', 'Y', 'Z'].indexOf(str(mod, 'axis_v', 'Y'));
  return (u: number, v: number, out: [number, number]) => {
    const x = u + off[0],
      y = v + off[1];
    const rx = (c * x - s * y) * sc[0],
      ry = (s * x + c * y) * sc[1];
    if (!obj) {
      out[0] = rx;
      out[1] = ry;
      return;
    }
    const p = [0, 0, 0];
    p[au] = rx;
    if (av !== au) p[av] = ry;
    const q = new Vector3(p[0], p[1], p[2]).applyMatrix4(obj);
    const arr = [q.x, q.y, q.z];
    out[0] = arr[au];
    out[1] = arr[av];
  };
}

function uvWarp(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const center = vec(mod, 'center', [0.5, 0.5]);
  const fn = uvWarpMatrix(mod, ctx);
  const w = vgroupFactor(m, mod);
  const uvs = new Float32Array(m.uvs);
  const o: [number, number] = [0, 0];
  for (let c = 0; c < m.indices.length; c++) {
    const u = m.uvs[c * 2],
      v = m.uvs[c * 2 + 1];
    fn(u - center[0], v - center[1], o);
    const nu = o[0] + center[0],
      nv = o[1] + center[1];
    const k = w ? w[m.indices[c]] : 1;
    uvs[c * 2] = u + (nu - u) * k;
    uvs[c * 2 + 1] = v + (nv - v) * k;
  }
  return { ...m, uvs };
}

export const uvModifiers: ModifierType[] = [
  {
    type: 'UV_PROJECT',
    label: 'UV Project',
    category: 'EDIT',
    icon: 'mod_uvproject',
    defaults: () => ({ uv_layer: '', projector_count: 1, projectors: [null], aspect_x: 1, aspect_y: 1, scale_x: 1, scale_y: 1 }),
    deps: (m) => ((m.projectors as (string | null)[] | undefined) ?? []).slice(0, Math.max(1, Math.round((m.projector_count as number) ?? 1))),
    signature: (m, c) => {
      // camera lens/shift changes do not touch the projector's transform
      const ids = ((m.projectors as (string | null)[] | undefined) ?? []).filter(Boolean) as string[];
      return ids.map((id) => {
        const ob = c.doc.objects[id];
        return ob?.type === 'CAMERA' && ob.data ? JSON.stringify(c.doc.cameras[ob.data]) : '';
      }).join('|');
    },
    supportsEditMode: true,
    apply: uvProject,
  },
  {
    type: 'UV_WARP',
    label: 'UV Warp',
    category: 'EDIT',
    icon: 'mod_uvwarp',
    defaults: () => ({ uv_layer: '', center: [0.5, 0.5], axis_u: 'X', axis_v: 'Y', object_from: null, bone_from: '', object_to: null, bone_to: '', offset: [0, 0], scale: [1, 1], rotation: 0, vertex_group: '', invert_vertex_group: false }),
    deps: (m) => [m.object_from as string, m.object_to as string],
    supportsEditMode: true,
    apply: uvWarp,
  },
];

for (const t of uvModifiers) registerModifier(t);
