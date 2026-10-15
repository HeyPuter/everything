// Mesh Cache: plays back vertex animation from MDD or PC2 point cache files (loaded into the
// modifier), with frame/time/factor timing, axis conversion and blending.
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, str, vgroupFactor } from './common';

export interface PointCache {
  format: 'MDD' | 'PC2';
  points: number;
  frames: number;
  /** frames × points × 3 */
  data: Float32Array;
  /** MDD: sample times in seconds */
  times?: Float32Array;
  /** PC2: first frame and frames per sample */
  start?: number;
  rate?: number;
}

/** Parse an MDD file (big endian: frame count, point count, times, positions). */
export function parseMDD(buf: ArrayBuffer): PointCache {
  const dv = new DataView(buf);
  const frames = dv.getInt32(0, false),
    points = dv.getInt32(4, false);
  if (frames <= 0 || points <= 0 || 8 + frames * 4 + frames * points * 12 > buf.byteLength) throw new Error('Not a valid MDD file');
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = dv.getFloat32(8 + i * 4, false);
  const data = new Float32Array(frames * points * 3);
  let o = 8 + frames * 4;
  for (let i = 0; i < data.length; i++, o += 4) data[i] = dv.getFloat32(o, false);
  return { format: 'MDD', points, frames, data, times };
}

/** Parse a PC2 file (little endian header "POINTCACHE2", version, points, start, rate, samples). */
export function parsePC2(buf: ArrayBuffer): PointCache {
  const dv = new DataView(buf);
  const sig = String.fromCharCode(...new Uint8Array(buf, 0, 11));
  if (sig !== 'POINTCACHE2') throw new Error('Not a valid PC2 file');
  const points = dv.getInt32(16, true);
  const start = dv.getFloat32(20, true),
    rate = dv.getFloat32(24, true);
  const frames = dv.getInt32(28, true);
  if (points <= 0 || frames <= 0 || 32 + frames * points * 12 > buf.byteLength) throw new Error('Not a valid PC2 file');
  const data = new Float32Array(frames * points * 3);
  for (let i = 0, o = 32; i < data.length; i++, o += 4) data[i] = dv.getFloat32(o, true);
  return { format: 'PC2', points, frames, data, start, rate: rate || 1 };
}

/** Write an MDD file (for round trips and tests). */
export function writeMDD(points: number, frames: Float32Array[], fps = 24): ArrayBuffer {
  const buf = new ArrayBuffer(8 + frames.length * 4 + frames.length * points * 12);
  const dv = new DataView(buf);
  dv.setInt32(0, frames.length, false);
  dv.setInt32(4, points, false);
  frames.forEach((_, i) => dv.setFloat32(8 + i * 4, i / fps, false));
  let o = 8 + frames.length * 4;
  for (const f of frames) for (let i = 0; i < points * 3; i++, o += 4) dv.setFloat32(o, f[i], false);
  return buf;
}

export function writePC2(points: number, frames: Float32Array[], start = 0, rate = 1): ArrayBuffer {
  const buf = new ArrayBuffer(32 + frames.length * points * 12);
  const dv = new DataView(buf);
  'POINTCACHE2'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setInt32(12, 1, true);
  dv.setInt32(16, points, true);
  dv.setFloat32(20, start, true);
  dv.setFloat32(24, rate, true);
  dv.setInt32(28, frames.length, true);
  let o = 32;
  for (const f of frames) for (let i = 0; i < points * 3; i++, o += 4) dv.setFloat32(o, f[i], true);
  return buf;
}

export function cacheFromModifier(mod: ModifierBase): PointCache | null {
  const data = mod._cache_data as Float32Array | undefined;
  if (!data) return null;
  return {
    format: mod._cache_format === 'PC2' ? 'PC2' : 'MDD',
    points: num(mod, '_cache_points', 0),
    frames: num(mod, '_cache_frames', 0),
    data,
    times: mod._cache_times as Float32Array | undefined,
    start: num(mod, '_cache_start', 0),
    rate: num(mod, '_cache_rate', 1),
  };
}

/** Fractional sample index for the modifier's timing settings. */
export function cacheIndex(c: PointCache, mod: ModifierBase, frame: number, fps: number): number {
  const mode = str(mod, 'time_mode', 'FRAME');
  const custom = str(mod, 'play_mode', 'SCENE') === 'CUSTOM';
  const f = custom ? num(mod, 'eval_frame', 0) : (frame - num(mod, 'frame_start', 0)) * num(mod, 'frame_scale', 1);
  const toIndexFromTime = (t: number) => {
    if (c.times && c.times.length > 1) {
      const T = c.times;
      if (t <= T[0]) return 0;
      for (let i = 1; i < T.length; i++) if (t <= T[i]) return i - 1 + (t - T[i - 1]) / (T[i] - T[i - 1] || 1);
      return T.length - 1;
    }
    return t * fps;
  };
  let idx: number;
  if (mode === 'FACTOR') idx = (custom ? num(mod, 'eval_factor', 0) : f / Math.max(1, c.frames - 1)) * (c.frames - 1);
  else if (mode === 'TIME') idx = toIndexFromTime(custom ? num(mod, 'eval_time', 0) : f / fps);
  else if (c.format === 'PC2') idx = (f - (c.start ?? 0)) / (c.rate || 1);
  else idx = f;
  return Math.max(0, Math.min(c.frames - 1, idx));
}

const AXES: Record<string, [number, number, number]> = { POS_X: [1, 0, 0], POS_Y: [0, 1, 0], POS_Z: [0, 0, 1], NEG_X: [-1, 0, 0], NEG_Y: [0, -1, 0], NEG_Z: [0, 0, -1] };

/** Rotation taking the cache's forward/up axes to our +Y forward / +Z up. */
export function axisMatrix(forward: string, up: string): Matrix4 | null {
  if (forward === 'POS_Y' && up === 'POS_Z') return null;
  const f = new Vector3(...(AXES[forward] ?? AXES.POS_Y)),
    u = new Vector3(...(AXES[up] ?? AXES.POS_Z));
  if (Math.abs(f.dot(u)) > 0.5) return null;
  const r = new Vector3().crossVectors(f, u);
  // rows: where each of our axes reads from the cache's axes
  return new Matrix4().set(r.x, r.y, r.z, 0, f.x, f.y, f.z, 0, u.x, u.y, u.z, 0, 0, 0, 0, 1);
}

function meshCacheMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const c = cacheFromModifier(mod);
  if (!c) return m;
  const nv = m.positions.length / 3;
  if (c.points !== nv) throw new Error(`Vertex count mismatch (cache has ${c.points})`);
  const fps = (ctx.doc?.scene.render.fps ?? 24) / (ctx.doc?.scene.render.fps_base || 1);
  const idx = cacheIndex(c, mod, ctx.frame, fps);
  const i0 = Math.floor(idx),
    i1 = Math.min(c.frames - 1, i0 + 1);
  const t = str(mod, 'interpolation', 'LINEAR') === 'LINEAR' ? idx - i0 : 0;
  const A = c.data.subarray(i0 * nv * 3, (i0 + 1) * nv * 3),
    B = c.data.subarray(i1 * nv * 3, (i1 + 1) * nv * 3);
  const rot = axisMatrix(str(mod, 'forward_axis', 'POS_Y'), str(mod, 'up_axis', 'POS_Z'));
  const flip = (mod.flip_axis as boolean[] | undefined) ?? [false, false, false];
  const integrate = str(mod, 'deform_mode', 'OVERWRITE') === 'INTEGRATE';
  const first = c.data.subarray(0, nv * 3);
  const factor = num(mod, 'factor', 1);
  const w = vgroupFactor(m, mod);
  const P = m.positions;
  const out = new Float32Array(P.length);
  const v = new Vector3(),
    v0 = new Vector3();
  for (let i = 0; i < nv; i++) {
    v.set(A[i * 3] + (B[i * 3] - A[i * 3]) * t, A[i * 3 + 1] + (B[i * 3 + 1] - A[i * 3 + 1]) * t, A[i * 3 + 2] + (B[i * 3 + 2] - A[i * 3 + 2]) * t);
    if (rot) v.applyMatrix4(rot);
    if (flip[0]) v.x = -v.x;
    if (flip[1]) v.y = -v.y;
    if (flip[2]) v.z = -v.z;
    if (integrate) {
      v0.fromArray(first, i * 3);
      if (rot) v0.applyMatrix4(rot);
      if (flip[0]) v0.x = -v0.x;
      if (flip[1]) v0.y = -v0.y;
      if (flip[2]) v0.z = -v0.z;
      v.sub(v0).add(new Vector3().fromArray(P, i * 3));
    }
    const k = factor * (w ? w[i] : 1);
    out[i * 3] = P[i * 3] + (v.x - P[i * 3]) * k;
    out[i * 3 + 1] = P[i * 3 + 1] + (v.y - P[i * 3 + 1]) * k;
    out[i * 3 + 2] = P[i * 3 + 2] + (v.z - P[i * 3 + 2]) * k;
  }
  return { ...m, positions: out };
}

export const meshCacheModifiers: ModifierType[] = [
  {
    type: 'MESH_CACHE',
    label: 'Mesh Cache',
    category: 'EDIT',
    icon: 'mod_meshcache',
    deformOnly: true,
    defaults: () => ({
      cache_format: 'MDD',
      filepath: '',
      interpolation: 'LINEAR',
      time_mode: 'FRAME',
      play_mode: 'SCENE',
      frame_start: 0,
      frame_scale: 1,
      eval_frame: 0,
      eval_time: 0,
      eval_factor: 0,
      deform_mode: 'OVERWRITE',
      factor: 1,
      forward_axis: 'POS_Y',
      up_axis: 'POS_Z',
      flip_axis: [false, false, false],
      vertex_group: '',
      invert_vertex_group: false,
    }),
    timeDependent: (m) => m.play_mode !== 'CUSTOM' && !!m._cache_data,
    apply: meshCacheMod,
  },
];

for (const t of meshCacheModifiers) registerModifier(t);

void bool;
