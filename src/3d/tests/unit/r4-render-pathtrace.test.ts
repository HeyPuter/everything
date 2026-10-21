// Path tracer options: adaptive sampling masks, integrator values, noise seeds, denoiser options
// and the shader patch that applies them.
import { describe, expect, it } from 'vitest';
import { PhysicalPathTracingMaterial } from 'three-gpu-pathtracer';
import { patchPathTracingShader, patchLightLinking } from '../../src/render/final/pathtracer';
import { patchVolumeShader } from '../../src/render/final/ptvolume';
import { patchIntegrator, seedOffset, integratorUniforms, applyIntegrator } from '../../src/render/final/ptintegrator';
import { adaptiveCheckpoints, adaptiveMinSamples, updateAdaptiveMask, pixelError, integratorValues, noiseSeed, denoiseOptions, ptSettings, defaultPathTraceSettings } from '../../src/render/final/ptsettings';
import { defaultRender } from '../../src/data/defaults';
import { denoiseSchedule } from '../../src/render/final/denoise';

describe('adaptive sampling', () => {
  it('tests at the minimum and every doubling below the maximum', () => {
    expect(adaptiveCheckpoints(16, 128)).toEqual([16, 32, 64]);
    expect(adaptiveCheckpoints(16, 16)).toEqual([]);
    // automatic minimum: more samples for tighter thresholds, within bounds
    expect(adaptiveMinSamples(0.1, 0)).toBe(16);
    expect(adaptiveMinSamples(0.001, 0)).toBeGreaterThan(adaptiveMinSamples(0.01, 0));
    expect(adaptiveMinSamples(0.01, 7)).toBe(7);
  });

  it('estimates noise relative to brightness', () => {
    const cur = new Float32Array([1, 1, 1, 1]);
    const half = new Float32Array([1.1, 1, 1, 1]);
    const e = pixelError(cur, half, 0);
    expect(e).toBeCloseTo((2 * 0.1) / Math.sqrt(3), 3);
    // the same absolute difference matters more in dark pixels
    expect(pixelError(new Float32Array([0.1, 0.1, 0.1, 1]), new Float32Array([0.2, 0.1, 0.1, 1]), 0)).toBeGreaterThan(e);
  });

  it('converges quiet pixels, keeps a margin around noisy ones and never reactivates', () => {
    const w = 12,
      h = 6;
    const cur = new Float32Array(w * h * 4).fill(0.5);
    const half = new Float32Array(cur);
    // one noisy pixel at (2, 2)
    half[(2 * w + 2) * 4] = 0.9;
    const mask = new Uint8Array(w * h);
    const active = updateAdaptiveMask(mask, cur, half, w, h, 0.01);
    // the 5×5 neighbourhood of the noisy pixel stays active
    expect(active).toBe(5 * 5);
    expect(mask[2 * w + 2]).toBe(0);
    expect(mask[2 * w + 4]).toBe(0);
    expect(mask[2 * w + 5]).toBe(255);
    // a later test with the noise gone frees the rest; converged pixels stay converged
    const again = updateAdaptiveMask(mask, cur, new Float32Array(cur), w, h, 0.01);
    expect(again).toBe(0);
    mask.fill(255);
    expect(updateAdaptiveMask(mask, cur, half, w, h, 0.01)).toBe(0);
  });
});

describe('integrator settings', () => {
  it('fills defaults and limits each bounce kind by the total', () => {
    const r = defaultRender();
    expect(r.cycles).toBeUndefined();
    const c = ptSettings(r);
    expect(c).toEqual(defaultPathTraceSettings());
    r.max_bounces = 6;
    r.transmission_bounces = 12;
    c.volume_bounces = 2;
    const v = integratorValues(r, false);
    expect(v.bounces).toEqual([4, 4, 6, 2]);
    expect(v.total).toBe(6);
    // alpha-transparent surfaces have their own (larger) budget
    expect(v.transmissive).toBe(8);
    expect(v.minBounces).toBe(3);
    c.min_light_bounces = 5;
    expect(integratorValues(r, false).minBounces).toBe(5);
  });

  it('switches fast GI bounces between viewport and render, and glass only with transparent film', () => {
    const r = defaultRender();
    const c = ptSettings(r);
    Object.assign(c, { use_fast_gi: true, ao_bounces: 2, ao_bounces_render: 4, ao_distance: 3, ao_factor: 0.5, fast_gi_method: 'ADD', film_transparent_glass: true });
    expect(integratorValues(r, true).fastGi).toEqual([1, 2, 3, 0.5]);
    expect(integratorValues(r, false).fastGi).toEqual([1, 4, 3, 0.5]);
    expect(integratorValues(r, false).fastGiAdd).toBe(true);
    expect(integratorValues(r, false).glass[0]).toBe(false);
    r.film_transparent = true;
    expect(integratorValues(r, false).glass[0]).toBe(true);
    const u = integratorUniforms();
    const key = applyIntegrator(u, integratorValues(r, false));
    expect(u.ptBounce.value).toEqual([4, 4, 8, 0]);
    expect(u.ptGlass.value.x).toBe(1);
    expect(u.ptGlass.value.z).toBe(1);
    c.caustics_refractive = false;
    expect(applyIntegrator(u, integratorValues(r, false))).not.toBe(key);
    expect(u.ptCaus.value.y).toBe(0);
  });

  it('derives noise seeds per frame only when animated', () => {
    const r = defaultRender();
    const c = ptSettings(r);
    c.seed = 7;
    expect(noiseSeed(r, 1)).toBe(7);
    expect(noiseSeed(r, 2)).toBe(7);
    c.use_animated_seed = true;
    expect(noiseSeed(r, 2)).not.toBe(noiseSeed(r, 1));
    expect(seedOffset(0)).toEqual([0, 0, 0, 0]);
    const o = seedOffset(7);
    expect(o.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(seedOffset(8)).not.toEqual(o);
  });

  it('maps denoiser options for viewport and final renders', () => {
    const r = defaultRender();
    expect(denoiseOptions(r, false)).toEqual({ albedo: true, normal: true, prefilter: 'ACCURATE', quality: 1 });
    expect(denoiseOptions(r, true)).toEqual({ albedo: true, normal: false, prefilter: 'FAST', quality: 0 });
    ptSettings(r).denoising_input_passes = 'RGB';
    expect(denoiseOptions(r, false).albedo).toBe(false);
    expect(denoiseSchedule(64).iterations).toBe(3);
  });
});

describe('integrator shader patch', () => {
  it('applies on top of the volume, film and light linking patches', () => {
    const m = new PhysicalPathTracingMaterial();
    let src = patchVolumeShader(m.fragmentShader)!;
    src = patchPathTracingShader(src)!;
    src = patchLightLinking(src)!;
    const out = patchIntegrator(src);
    expect(out).toBeTruthy();
    for (const marker of ['ptN[ ptKind ] ++', 'ptCaus.x < 0.5', 'ptFastGi.x > 0.5', 'state.transmissiveRay = false', 'uint( max( ptMinB, 0 ) )', 'fract( texture( stratifiedOffsetTexture, uv ) + ptSeedOff )'])
      expect(out).toContain(marker);
    // also on the stock shader
    expect(patchIntegrator(m.fragmentShader)).toBeTruthy();
  });
});

describe('numerically safe tracing shader', () => {
  it('replaces undefined pow / acos / sqrt uses that turned smooth glass black', () => {
    const m = new PhysicalPathTracingMaterial();
    const out = patchIntegrator(m.fragmentShader)!;
    expect(out).not.toContain('pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 )');
    expect(out).toContain('float ptR = ( 1.0 - eta ) / ( 1.0 + eta ); return ptR * ptR;');
    // the only plain acos is inside the clamped helper
    expect(out.match(/\bacos\(/g)).toHaveLength(1);
    expect(out).not.toMatch(/sqrt\( 1\.0 - (\w+) \* \1 \)/);
    expect(out).toContain('if ( attDist > 1e19 ) return vec3( 1.0 );');
    expect(out).toContain('if ( surf.sheen > 0.0 ) color += sheenColor');
  });
});
