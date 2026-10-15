// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { explodeFaces, instanceOnParticles } from '../../src/eval/mods/particles';
import type { EvalMesh } from '../../src/eval/types';

const mesh = (a: ReturnType<typeof prim.cube>) => newMeshData('m', a) as unknown as EvalMesh;
const opts = { unborn: true, alive: true, dead: true, useSize: false, protect: 0, weights: null };

describe('Explode', () => {
  const grid = mesh(prim.grid(2, 1, 2)); // two faces, centers at x = ±0.5
  const emit = Float32Array.from([-0.5, 0, 0, 0.5, 0, 0]);
  it('splits faces and moves them with their particles', () => {
    const pos = Float32Array.from([-0.5, 0, 1, 0.5, 0, 0]);
    const out = explodeFaces(grid, emit, pos, Uint8Array.from([1, 0]), Float32Array.from([1, 1]), opts);
    expect(out.positions.length / 3).toBe(8);
    expect(out.offsets.length - 1).toBe(2);
    // the first face rose by one, the second (unborn) stayed
    const z = (f: number) => out.positions[out.indices[out.offsets[f]] * 3 + 2];
    expect(z(0)).toBeCloseTo(1, 6);
    expect(z(1)).toBeCloseTo(0, 6);
  });

  it('hides unborn/dead faces on request and protects weighted faces', () => {
    const pos = Float32Array.from([-0.5, 0, 1, 0.5, 0, 3]);
    const hidden = explodeFaces(grid, emit, pos, Uint8Array.from([0, 2]), Float32Array.from([1, 1]), { ...opts, unborn: false, dead: false });
    expect(hidden.offsets.length - 1).toBe(0);
    const w = Float32Array.from({ length: 6 }, (_, v) => (grid.positions[v * 3] > 0.5 ? 1 : 0));
    const prot = explodeFaces(grid, emit, pos, Uint8Array.from([1, 1]), Float32Array.from([1, 1]), { ...opts, weights: w, protect: 0.4 });
    const zs = Array.from({ length: 2 }, (_, f) => prot.positions[prot.indices[prot.offsets[f]] * 3 + 2]);
    expect(zs).toContain(0);
    expect(zs).toContain(3);
  });
});

describe('Particle Instance', () => {
  it('places a copy at each selected particle', () => {
    const cube = mesh(prim.cube(0.2));
    const p = { pos: Float32Array.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 5, 5, 5]), state: Uint8Array.from([1, 1, 2, 0]), sizes: Float32Array.from([1, 2, 1, 1]) };
    const base = { unborn: false, alive: true, dead: true, useSize: false, amount: 1, offset: 0, axis: 2, rotation: 0, randomRotation: 0, toLocal: new Matrix4() };
    const out = instanceOnParticles(cube, p, base);
    expect(out.positions.length / 3).toBe(8 * 3);
    // the first copy is centred on the first particle
    let cx = 0;
    for (let v = 0; v < 8; v++) cx += out.positions[v * 3] / 8;
    expect(cx).toBeCloseTo(1, 6);
    expect(instanceOnParticles(cube, p, { ...base, amount: 0.5 }).positions.length / 3).toBe(16);
    const sized = instanceOnParticles(cube, p, { ...base, useSize: true, dead: false });
    let span = 0;
    for (let v = 8; v < 16; v++) span = Math.max(span, Math.abs(sized.positions[v * 3]));
    expect(span).toBeCloseTo(0.2, 6);
  });
});
