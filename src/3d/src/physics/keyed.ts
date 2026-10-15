// Keyed particles: each particle travels over its lifetime from its emission point through the
// matching particles of target particle systems (optionally looping).
import type { DocumentData, ID } from '../data/types';
import { caches, type FrameCache } from './common';
import { particleCacheKey, systemOf } from './particles';

export interface KeyedTarget {
  object: ID | null;
  /** index of the particle system on the target object (1-based like the list shows) */
  system: number;
}

/** Positions (world) of the target systems' particles at a frame, one array per target. */
export function keyedTargetPositions(doc: DocumentData, targets: KeyedTarget[], frame: number): (Float32Array | null)[] {
  return targets.map((t) => {
    const ob = t.object ? doc.objects[t.object] : undefined;
    if (!ob) return null;
    const ps = ob.particle_systems[Math.max(0, (t.system || 1) - 1)] as { id?: string } | undefined;
    const m = ps ? ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) === ps) : undefined;
    if (!m) return null;
    const c = caches.get(particleCacheKey(ob, m)) as FrameCache<{ pos: Float32Array }> | undefined;
    const fr = c?.frames.get(frame) ?? c?.nearest(frame);
    return fr ? fr.pos : null;
  });
}

/** Position along the keyed path at life fraction t (0..1) for particle i. */
export function keyedPosition(start: [number, number, number], targets: (Float32Array | null)[], i: number, t: number, loops: number, out: number[]) {
  const pts: [number, number, number][] = [start];
  for (const T of targets) {
    if (!T || !T.length) continue;
    const k = (i % (T.length / 3)) * 3;
    pts.push([T[k], T[k + 1], T[k + 2]]);
  }
  if (pts.length < 2) {
    out[0] = start[0];
    out[1] = start[1];
    out[2] = start[2];
    return;
  }
  const L = Math.max(1, Math.round(loops));
  let u = Math.max(0, Math.min(1, t)) * L;
  u -= Math.floor(u === L ? u - 1e-9 : u);
  const segs = pts.length - 1;
  const x = u * segs;
  const a = Math.min(segs - 1, Math.floor(x));
  const f = x - a;
  for (let c = 0; c < 3; c++) out[c] = pts[a][c] + (pts[a + 1][c] - pts[a][c]) * f;
}
