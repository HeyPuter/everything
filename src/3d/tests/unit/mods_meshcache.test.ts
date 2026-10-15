// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { parseMDD, parsePC2, writeMDD, writePC2, cacheIndex, axisMatrix } from '../../src/eval/mods/meshcache';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';
import { Vector3 } from 'three';

const cube = () => newMeshData('c', prim.cube(2)) as unknown as EvalMesh;
const frames = (m: EvalMesh) => [0, 1, 2].map((f) => Float32Array.from(m.positions, (x, i) => (i % 3 === 2 ? x + f : x)));

describe('Mesh Cache', () => {
  it('reads MDD and PC2 files', () => {
    const m = cube();
    const fr = frames(m);
    const mdd = parseMDD(writeMDD(8, fr));
    expect([mdd.frames, mdd.points]).toEqual([3, 8]);
    expect(mdd.data[2 * 24 + 2]).toBeCloseTo(fr[2][2], 6);
    const pc2 = parsePC2(writePC2(8, fr, 10, 2));
    expect([pc2.frames, pc2.points, pc2.start, pc2.rate]).toEqual([3, 8, 10, 2]);
    expect(() => parsePC2(new ArrayBuffer(40))).toThrow();
  });

  it('maps scene frames, times and factors to samples', () => {
    const c = parsePC2(writePC2(8, frames(cube()), 10, 2));
    const mod = (p: Record<string, unknown>) => ({ ...modifierTypes.MESH_CACHE.defaults(), ...p }) as never;
    expect(cacheIndex(c, mod({}), 12, 24)).toBe(1);
    expect(cacheIndex(c, mod({ frame_start: 1 }), 12, 24)).toBe(0.5);
    expect(cacheIndex(c, mod({ time_mode: 'FACTOR', play_mode: 'CUSTOM', eval_factor: 0.5 }), 0, 24)).toBe(1);
    const mdd = parseMDD(writeMDD(8, frames(cube()), 24));
    expect(cacheIndex(mdd, mod({ time_mode: 'TIME', play_mode: 'CUSTOM', eval_time: 1.5 / 24 }), 0, 24)).toBeCloseTo(1.5, 5);
  });

  it('plays back positions with interpolation, integration and axis conversion', () => {
    const m = cube();
    const c = parseMDD(writeMDD(8, frames(m)));
    const t = modifierTypes.MESH_CACHE;
    const mod = (p: Record<string, unknown> = {}) => ({ ...t.defaults(), _cache_data: c.data, _cache_points: 8, _cache_frames: 3, _cache_times: c.times, ...p }) as never;
    const ctx = (frame: number) => ({ frame, doc: { scene: { render: { fps: 24, fps_base: 1 } } } }) as unknown as ModifierContext;
    expect(t.apply(m, mod(), ctx(1.5)).positions[2]).toBeCloseTo(m.positions[2] + 1.5, 5);
    expect(t.apply(m, mod({ interpolation: 'NONE' }), ctx(1.5)).positions[2]).toBeCloseTo(m.positions[2] + 1, 5);
    const lifted = { ...m, positions: Float32Array.from(m.positions, (x, i) => (i % 3 === 0 ? x + 5 : x)) };
    const integ = t.apply(lifted, mod({ deform_mode: 'INTEGRATE' }), ctx(2));
    expect(integ.positions[0]).toBeCloseTo(lifted.positions[0], 5);
    expect(integ.positions[2]).toBeCloseTo(lifted.positions[2] + 2, 5);
    expect(() => t.apply(newMeshData('g', prim.grid(2, 2)) as unknown as EvalMesh, mod(), ctx(1))).toThrow(/count/);
    // a Y-up cache: its +Y becomes our +Z
    const r = axisMatrix('NEG_Z', 'POS_Y')!;
    const v = new Vector3(0, 1, 0).applyMatrix4(r);
    expect([v.x, v.y, v.z].map((x) => Math.round(x))).toEqual([0, 0, 1]);
  });
});
