// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { bakeOcean, oceanField, oceanParams } from '../../src/eval/mods/ocean';
import { explodeFaces } from '../../src/eval/mods/particles';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh } from '../../src/eval/types';

const mesh = (a: ReturnType<typeof prim.cube>) => newMeshData('m', a) as unknown as EvalMesh;
const opts = { unborn: true, alive: true, dead: true, useSize: false, protect: 0, weights: null };

describe('Ocean', () => {
  const defaults = () => modifierTypes.OCEAN.defaults() as Record<string, unknown>;
  it('spray vectors point where the surface is pushed together', () => {
    const p = oceanParams({ ...defaults(), use_spray: true, choppiness: 2, wind_velocity: 40 } as never, false);
    const f = oceanField(p);
    expect(f.spray).toBeTruthy();
    expect(f.spray!.length).toBe(f.n * f.n * 2);
    let nonzero = 0;
    for (let i = 0; i < f.spray!.length; i++) if (Math.abs(f.spray![i]) > 1e-6) nonzero++;
    expect(nonzero).toBeGreaterThan(f.n);
    const inv = oceanField({ ...p, invertSpray: true });
    expect(inv.spray![0]).toBeCloseTo(-f.spray![0], 6);
  });

  it('a bake keeps foam that fades over time', () => {
    const base = oceanParams({ ...defaults(), use_foam: true, choppiness: 2, wind_velocity: 40 } as never, false);
    const live = bakeOcean((f) => ({ ...base, time: f / 24 }), 1, 6, 0, 'k');
    const kept = bakeOcean((f) => ({ ...base, time: f / 24 }), 1, 6, 0.95, 'k');
    expect(kept.frames.size).toBe(6);
    const sum = (a: Float64Array) => a.reduce((t, x) => t + x, 0);
    // with fading foam the last frame holds at least the foam of the plain field
    expect(sum(kept.frames.get(6)!.foam!)).toBeGreaterThan(sum(live.frames.get(6)!.foam!));
  });
});

describe('Explode cut edges', () => {
  it('splits a face whose corners belong to different particles', () => {
    // one quad from x = -1 to 1; particles at its left and right edges
    const quad = mesh(prim.grid(1, 1, 2));
    const emit = Float32Array.from([-1, 0, 0, 1, 0, 0]);
    const pos = Float32Array.from([-1, 0, 2, 1, 0, 0]);
    const whole = explodeFaces(quad, emit, pos, Uint8Array.from([1, 1]), Float32Array.from([1, 1]), opts);
    expect(whole.offsets.length - 1).toBe(1);
    const cut = explodeFaces(quad, emit, pos, Uint8Array.from([1, 1]), Float32Array.from([1, 1]), { ...opts, cutEdges: true });
    // a piece per corner; the left pieces rose with their particle
    expect(cut.offsets.length - 1).toBe(4);
    let up = 0;
    for (let f = 0; f < 4; f++) if (cut.positions[cut.indices[cut.offsets[f]] * 3 + 2] > 1) up++;
    expect(up).toBe(2);
  });

  it('writes the particle age to the UVs', () => {
    const quad = mesh(prim.grid(1, 1, 2));
    const out = explodeFaces(quad, Float32Array.from([0, 0, 0]), Float32Array.from([0, 0, 1]), Uint8Array.from([1]), Float32Array.from([1]), { ...opts, ages: Float32Array.from([0.25]) });
    expect(out.uvs[0]).toBeCloseTo(0.25, 6);
    expect(out.uvs[1]).toBeCloseTo(0.5, 6);
  });
});

describe('Dynamic Paint image sequences', () => {
  it('texel samples cover the UV islands and interpolate vertex values', async () => {
    const { texelSamples, interpolate, outputPixels, surfaceOutputs } = await import('../../src/physics/dpimage');
    // one quad covering the lower-left quarter of the UV square
    const quad = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), offsets: new Uint32Array([0, 4]), indices: new Uint32Array([0, 1, 2, 3]), uvs: new Float32Array([0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5]) };
    const t = texelSamples(quad, 16)!;
    expect(t.pix.length).toBe(64);
    // positions follow the UVs: texel (7, 7) sits near the far corner
    const P = interpolate(t, quad.positions, 3);
    const i = Array.from(t.pix).indexOf(7 * 16 + 7);
    expect(P[i * 3]).toBeCloseTo(15 / 16, 5);
    // grid neighbours, borders at the island edge
    expect(t.border[Array.from(t.pix).indexOf(3 * 16 + 3)]).toBe(0);
    expect(t.border[Array.from(t.pix).indexOf(0)]).toBe(1);
    // paint state → pixels, with padding around the island
    const st = new Float32Array(64 * 5);
    for (let k = 0; k < 64; k++) st.set([1, 0, 0, 1, 0.5], k * 5);
    const px = outputPixels(t, st, 'paintmap');
    expect(px[(3 * 16 + 3) * 4]).toBe(255);
    expect(px[(3 * 16 + 9) * 4]).toBe(255);
    expect(px[(3 * 16 + 12) * 4]).toBe(0);
    const wet = outputPixels(t, st, 'wetmap');
    expect(wet[(3 * 16 + 3) * 4]).toBe(128);
    expect(surfaceOutputs({ name: 'S', surface_type: 'PAINT', use_output_a: true, use_output_b: false, output_name_a: '', output_name_b: '' }).map((o) => o.name)).toEqual(['dp_paintmap']);
  });
});
