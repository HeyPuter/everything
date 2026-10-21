// Keyed particles: each particle travels over its lifetime from its emission point through the
// matching particles of target particle systems (optionally looping).
import type { DocumentData, ID } from '../data/types';
import { caches, type FrameCache } from './common';
import { particleCacheKey, systemOf } from './particles';

export interface KeyedTarget {
  object: ID | null;
  /** index of the particle system on the target object (1-based like the list shows) */
  system: number;
  /** keyed timing: frames after birth when the particle reaches this target, and how long it stays */
  time?: number;
  duration?: number;
  /** boids: how these boids treat the target system's boids */
  alliance?: 'FRIEND' | 'NEUTRAL' | 'ENEMY';
}

/** Targets of a particle system (older files kept them on the settings). */
export function psysTargets(ps: { targets?: KeyedTarget[] } | undefined, s: { keyed_targets?: KeyedTarget[] } | undefined): KeyedTarget[] {
  return ps?.targets ?? s?.keyed_targets ?? [];
}

/** Particle states (alive flags) and positions of a target system at a frame. */
export function targetParticles(doc: DocumentData, t: KeyedTarget, frame: number): { pos: Float32Array; alive: Uint8Array; settings: Record<string, unknown> | null } | null {
  const ob = t.object ? doc.objects[t.object] : undefined;
  if (!ob) return null;
  const ps = ob.particle_systems[Math.max(0, (t.system || 1) - 1)] as { id?: string; settings?: string } | undefined;
  const m = ps ? ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) === ps) : undefined;
  if (!m) return null;
  const c = caches.get(particleCacheKey(ob, m)) as FrameCache<{ pos: Float32Array; state: Uint8Array }> | undefined;
  const fr = c?.frames.get(frame) ?? c?.nearest(frame);
  if (!fr) return null;
  const alive = new Uint8Array(fr.state.length);
  for (let i = 0; i < alive.length; i++) alive[i] = fr.state[i] === 1 ? 1 : 0;
  return { pos: fr.pos, alive, settings: ps?.settings ? ((doc.particles[ps.settings] as unknown as Record<string, unknown>) ?? null) : null };
}

/**
 * Position at `age` frames after birth when the target keys have their own times: the particle
 * reaches key k at `times[k]` and stays there for `durations[k]` frames (key 0 is the start point).
 */
export function keyedPositionTimed(points: [number, number, number][], times: number[], durations: number[], age: number, out: number[]) {
  // build (time, point) samples: arrival and departure of each key
  const samples: { t: number; p: [number, number, number] }[] = [];
  for (let k = 0; k < points.length; k++) {
    const t0 = times[k],
      d = Math.max(0, durations[k] ?? 0);
    samples.push({ t: t0, p: points[k] });
    if (d > 0) samples.push({ t: t0 + d, p: points[k] });
  }
  samples.sort((a, b) => a.t - b.t);
  if (age <= samples[0].t) {
    out[0] = samples[0].p[0];
    out[1] = samples[0].p[1];
    out[2] = samples[0].p[2];
    return;
  }
  for (let q = 0; q + 1 < samples.length; q++) {
    const a = samples[q],
      b = samples[q + 1];
    if (age <= b.t) {
      const f = b.t > a.t ? (age - a.t) / (b.t - a.t) : 1;
      for (let c = 0; c < 3; c++) out[c] = a.p[c] + (b.p[c] - a.p[c]) * f;
      return;
    }
  }
  const last = samples[samples.length - 1].p;
  out[0] = last[0];
  out[1] = last[1];
  out[2] = last[2];
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
