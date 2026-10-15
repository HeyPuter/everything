// Curve Guide force fields: particles follow the guide curve over their lifetime, keeping (part of)
// their starting offset from the curve start, and are free again for the last part of their life.
import { Vector3 } from 'three';
import type { DocumentData } from '../data/types';
import { curvePath, pathPoint, type CurvePath } from '../eval/curvepath';
import type { Effector } from './fields';

export interface GuideState {
  /** per particle and guide: offset from the curve start at the time the particle was first guided */
  offsets: Map<string, Float32Array>;
  /** per particle and guide: whether the offset is set */
  set: Map<string, Uint8Array>;
}

export function newGuideState(): GuideState {
  return { offsets: new Map(), set: new Map() };
}

interface Guide {
  e: Effector;
  path: CurvePath;
}

export function guidesOf(doc: DocumentData, effs: Effector[]): Guide[] {
  const out: Guide[] = [];
  for (const e of effs) {
    if (e.field.type !== 'GUIDE') continue;
    const ob = doc.objects[e.id];
    const cu = ob?.type === 'CURVE' && ob.data ? doc.curves[ob.data] : undefined;
    const path = cu ? curvePath(cu) : null;
    if (path) out.push({ e, path });
  }
  return out;
}

const _g = new Vector3(),
  _g0 = new Vector3();

/**
 * Move alive particles along the guides at `time` (frames). Positions and velocities are updated in
 * place; `dt` (seconds per frame) turns the guided motion into velocity so particles carry on when free.
 */
export function applyGuides(guides: Guide[], st: GuideState, pos: Float32Array, vel: Float32Array, state: Uint8Array, birth: Float32Array, life: Float32Array, time: number, prevTime: number, dt: number) {
  if (!guides.length) return;
  const n = state.length;
  for (const { e, path } of guides) {
    const f = e.field;
    let offs = st.offsets.get(e.id),
      set = st.set.get(e.id);
    if (!offs || offs.length !== n * 3) {
      offs = new Float32Array(n * 3);
      set = new Uint8Array(n);
      st.offsets.set(e.id, offs);
      st.set.set(e.id, set);
    }
    const start = pathPoint(path, 0).point.applyMatrix4(e.world);
    const strength = Math.max(0, Math.min(1, f.strength));
    const free = Math.max(0, Math.min(0.99, f.guide_free ?? 0.1));
    const clump = Math.max(-1, Math.min(1, f.guide_clump_amount ?? 0));
    const minDist = Math.max(0, f.guide_minimum ?? 0);
    const power = f.falloff_power ?? 0;
    for (let i = 0; i < n; i++) {
      if (state[i] !== 1) continue;
      const age = (time - birth[i]) / Math.max(1e-6, life[i]);
      if (age >= 1 - free) continue;
      const t = Math.max(0, Math.min(1, age / (1 - free)));
      const j = i * 3;
      if (!set![i]) {
        offs[j] = pos[j] - start.x;
        offs[j + 1] = pos[j + 1] - start.y;
        offs[j + 2] = pos[j + 2] - start.z;
        set![i] = 1;
      }
      // particles far from the curve start are guided less (beyond the minimum distance)
      let w = strength;
      const d0 = Math.hypot(offs[j], offs[j + 1], offs[j + 2]);
      if (d0 > minDist && power > 0) w *= Math.pow(Math.max(minDist, 1e-3) / d0, power);
      if (w <= 0) continue;
      _g.copy(pathPoint(path, t).point).applyMatrix4(e.world);
      const keep = 1 - clump * t;
      let gx = _g.x + offs[j] * keep,
        gy = _g.y + offs[j + 1] * keep,
        gz = _g.z + offs[j + 2] * keep;
      if (f.use_guide_path_add) {
        // the guide motion is added to the simulated motion instead of replacing it
        const tp = Math.max(0, Math.min(1, ((prevTime - birth[i]) / Math.max(1e-6, life[i])) / (1 - free)));
        _g0.copy(pathPoint(path, tp).point).applyMatrix4(e.world);
        gx = pos[j] + (_g.x - _g0.x);
        gy = pos[j + 1] + (_g.y - _g0.y);
        gz = pos[j + 2] + (_g.z - _g0.z);
      }
      const nx = pos[j] + (gx - pos[j]) * w,
        ny = pos[j + 1] + (gy - pos[j + 1]) * w,
        nz = pos[j + 2] + (gz - pos[j + 2]) * w;
      if (dt > 0) {
        vel[j] = vel[j] * (1 - w) + ((nx - pos[j]) / dt) * w;
        vel[j + 1] = vel[j + 1] * (1 - w) + ((ny - pos[j + 1]) / dt) * w;
        vel[j + 2] = vel[j + 2] * (1 - w) + ((nz - pos[j + 2]) / dt) * w;
      }
      pos[j] = nx;
      pos[j + 1] = ny;
      pos[j + 2] = nz;
    }
  }
}
