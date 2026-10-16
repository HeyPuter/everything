import { describe, expect, it } from 'vitest';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { patchPathTracingShader } from '../../src/render/final/pathtracer';
import { buildAtlas, patchVolumeShader, volumeMajorant } from '../../src/render/final/ptvolume';
import { defaultVolumeShader } from '../../src/volume/shader';

describe('path tracer volumes and subsurface scattering', () => {
  it('patches every hook point of the path tracing shader', () => {
    const m = new PhysicalPathTracingMaterial();
    const src = patchVolumeShader(m.fragmentShader)!;
    expect(src).toBeTruthy();
    for (const marker of ['ndTrack(', 'ndFogDistance( fogMaterial, ray', 'ndWorldDistance( ray', 'ndTraceShadow( ray, fogMaterial', 'ndHG( dot( - worldWo, worldWi )', 'ndSampleHG( - worldWo', '* ndDiffuseScale;', 'ndSubsurfaceWalk( surf.color', 'gl_FragColor.rgb += ndVolEmission'])
      expect(src).toContain(marker);
    // the film / clamp patch still applies on top
    expect(patchPathTracingShader(src)).toBeTruthy();
  });

  it('stacks volumes in a 3D atlas', () => {
    const mk = (nx: number, ny: number, nz: number, v: number) => ({ dims: [nx, ny, nz] as [number, number, number], transform: [], data: new Uint8Array(nx * ny * nz * 4).fill(v), scale: [1, 0, 0] as [number, number, number], maxDensity: 1 });
    const { tex, tiles } = buildAtlas([mk(4, 2, 3, 10), mk(2, 4, 2, 20)]);
    expect([tex.image.width, tex.image.height, tex.image.depth]).toEqual([4, 4, 7]);
    expect(tiles[0]).toEqual([1, 0.5, 0, 3 / 7]);
    expect(tiles[1]).toEqual([0.5, 1, 4 / 7, 2 / 7]);
    const d = tex.image.data as Uint8Array;
    expect(d[0]).toBe(10);
    // second volume starts after one empty slice
    expect(d[(3 * 16) * 4]).toBe(0);
    expect(d[(4 * 16) * 4]).toBe(20);
  });

  it('bounds extinction with a majorant (higher for emitters)', () => {
    const s = defaultVolumeShader();
    const packed = { dims: [1, 1, 1] as [number, number, number], transform: [], data: new Uint8Array(4), scale: [2, 0, 0] as [number, number, number], maxDensity: 2 };
    expect(volumeMajorant({ packed, shader: s, diagonal: 1 })).toBeCloseTo(2);
    expect(volumeMajorant({ packed, shader: { ...s, emission: [1, 0, 0] }, diagonal: 1 })).toBeGreaterThanOrEqual(48);
  });
});
