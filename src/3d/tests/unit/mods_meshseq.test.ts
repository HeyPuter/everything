import { describe, expect, it } from 'vitest';
import { fixture } from '../fixtures/formats/helpers';
import { alembicMeshPaths, readAlembicTrack, sampleAt } from '../../src/eval/mods/meshseq';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

describe('Mesh Sequence Cache', () => {
  it('lists mesh objects and reads animated positions from an Alembic archive', () => {
    const bytes = fixture('ref_scene.abc');
    const paths = alembicMeshPaths(bytes);
    const skinned = paths.find((p) => p.path.endsWith('Cylinder'))!;
    expect(skinned.samples).toBe(24);
    const track = readAlembicTrack(bytes, skinned.path)!;
    expect(track.times.length).toBe(24);
    expect(track.data.length).toBe(24 * track.points * 3);
    expect(sampleAt(track.times, track.times[3])).toBeCloseTo(3, 6);

    const t = modifierTypes.MESH_SEQUENCE_CACHE;
    const base = { positions: new Float32Array(track.points * 3), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
    const mod = { ...t.defaults(), _seq_data: track.data, _seq_times: track.times, _seq_points: track.points } as never;
    const ctx = (frame: number) => ({ frame, doc: { scene: { render: { fps: 24, fps_base: 1 } } } }) as unknown as ModifierContext;
    const f1 = t.apply(base, mod, ctx(1)).positions;
    const f20 = t.apply(base, mod, ctx(20)).positions;
    expect(Array.from(f1)).not.toEqual(Array.from(f20));
    // a frame lands on its sample (times are frame / fps)
    const i = Math.round(track.times[0] * 24);
    expect(Array.from(t.apply(base, mod, ctx(i)).positions.slice(0, 3))).toEqual(Array.from(track.data.slice(0, 3)));
    expect(() => t.apply({ ...base, positions: new Float32Array(3) }, mod, ctx(1))).toThrow(/count/);
  });
});
