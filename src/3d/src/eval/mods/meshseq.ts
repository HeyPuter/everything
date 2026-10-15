// Mesh Sequence Cache: vertex animation read from an Alembic archive (one mesh object of it),
// played back by scene time with optional interpolation between samples.
import type { ModifierBase } from '../../data/types';
import type { EvalMesh, ModifierContext, ModifierType } from '../types';
import { registerModifier } from '../modifiers';
import { bool, num, vgroupFactor } from './common';
import { AlembicArchive, findProp, type AbcObject } from '../../io/formats/alembic/archive';

export interface AbcMeshTrack {
  path: string;
  points: number;
  /** samples × points × 3, converted to Z-up */
  data: Float32Array;
  /** sample times in seconds */
  times: Float32Array;
}

/** Paths of the mesh objects in an Alembic archive. */
export function alembicMeshPaths(bytes: Uint8Array): { path: string; points: number; samples: number }[] {
  const abc = new AlembicArchive(bytes);
  const out: { path: string; points: number; samples: number }[] = [];
  const walk = (o: AbcObject) => {
    if (/AbcGeom_(PolyMesh|SubD)/.test(o.metadata.schema ?? '')) {
      const P = findProp(findProp(o.properties, '.geom'), 'P');
      const first = P ? (abc.sample(P, 0) as number[] | null) : null;
      if (P && first) out.push({ path: o.path, points: first.length / 3, samples: P.numSamples });
    }
    o.children.forEach(walk);
  };
  walk(abc.top);
  return out;
}

/** Read the positions of one mesh object over time. */
export function readAlembicTrack(bytes: Uint8Array, path: string): AbcMeshTrack | null {
  const abc = new AlembicArchive(bytes);
  let found: AbcObject | null = null;
  const walk = (o: AbcObject) => {
    if (!found && o.path === path) found = o;
    o.children.forEach(walk);
  };
  walk(abc.top);
  if (!found) return null;
  const P = findProp(findProp((found as AbcObject).properties, '.geom'), 'P');
  if (!P) return null;
  const first = abc.sample(P, 0) as number[] | null;
  if (!first) return null;
  const points = first.length / 3;
  const n = Math.max(1, P.numSamples);
  const data = new Float32Array(n * points * 3);
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = (abc.sample(P, i) as number[] | null) ?? first;
    times[i] = abc.sampleTime(P.timeSampling, i);
    for (let v = 0; v < points; v++) {
      // Y-up to Z-up
      data[(i * points + v) * 3] = s[v * 3];
      data[(i * points + v) * 3 + 1] = -s[v * 3 + 2];
      data[(i * points + v) * 3 + 2] = s[v * 3 + 1];
    }
  }
  return { path, points, data, times };
}

/** Fractional sample index at time t (seconds). */
export function sampleAt(times: ArrayLike<number>, t: number): number {
  const n = times.length;
  if (n <= 1 || t <= times[0]) return 0;
  for (let i = 1; i < n; i++) if (t <= times[i]) return i - 1 + (t - times[i - 1]) / (times[i] - times[i - 1] || 1);
  return n - 1;
}

function meshSeqMod(m: EvalMesh, mod: ModifierBase, ctx: ModifierContext): EvalMesh {
  const data = mod._seq_data as Float32Array | undefined,
    times = mod._seq_times as Float32Array | undefined;
  if (!data || !times) return m;
  const read = (mod.read_data as string[] | undefined) ?? ['VERT'];
  if (!read.includes('VERT')) return m;
  const nv = m.positions.length / 3;
  const points = num(mod, '_seq_points', 0);
  if (points !== nv) throw new Error(`Vertex count mismatch (cache has ${points})`);
  const fps = (ctx.doc?.scene.render.fps ?? 24) / (ctx.doc?.scene.render.fps_base || 1);
  const frame = bool(mod, 'override_frame') ? num(mod, 'frame', 1) : ctx.frame;
  const t = (frame - num(mod, 'frame_offset', 0)) / fps;
  const idx = sampleAt(times, t);
  const i0 = Math.floor(idx),
    i1 = Math.min(times.length - 1, i0 + 1);
  const f = bool(mod, 'use_vertex_interpolation', true) ? idx - i0 : 0;
  const w = vgroupFactor(m, mod);
  const out = new Float32Array(m.positions.length);
  for (let k = 0; k < out.length; k++) {
    const a = data[i0 * nv * 3 + k],
      b = data[i1 * nv * 3 + k];
    const v = a + (b - a) * f;
    const g = w ? w[(k / 3) | 0] : 1;
    out[k] = m.positions[k] + (v - m.positions[k]) * g;
  }
  return { ...m, positions: out };
}

export const meshSeqModifiers: ModifierType[] = [
  {
    type: 'MESH_SEQUENCE_CACHE',
    label: 'Mesh Sequence Cache',
    category: 'EDIT',
    icon: 'mod_meshcache',
    deformOnly: true,
    defaults: () => ({ filepath: '', object_path: '', read_data: ['VERT'], use_vertex_interpolation: true, frame_offset: 0, override_frame: false, frame: 1, vertex_group: '', invert_vertex_group: false }),
    timeDependent: (m) => !!m._seq_data && !m.override_frame,
    apply: meshSeqMod,
  },
];

for (const t of meshSeqModifiers) registerModifier(t);
