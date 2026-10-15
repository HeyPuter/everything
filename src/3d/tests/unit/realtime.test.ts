import { describe, it, expect } from 'vitest';
import { ShaderChunk } from 'three';
import { startupDocument } from '../../src/data/defaults';
import { traceSettings, raytracingEnabled, fastGiEnabled, lightRange, shadowMapSize, bloomOptions, shadowSettings } from '../../src/render/realtime/settings';
import { packedLightOrder, influenceArrays, lightKind } from '../../src/render/realtime/lightinfluence';
import { patchLightsBegin, patchTransmissionPars, fxUniforms } from '../../src/render/realtime/fxshader';
import type { RenderSettings } from '../../src/data/types';

const render = (over: Partial<RenderSettings> = {}): RenderSettings => ({ ...startupDocument().scene.render, ...over });

describe('realtime settings', () => {
  it('raytracing is off by default and follows its toggle', () => {
    expect(raytracingEnabled(render())).toBe(false);
    const t = traceSettings(render({ use_ssr: true }));
    expect(t.reflections).toBe(true);
    expect(t.fastGi).toBe(false);
    expect(traceSettings(render({ use_ssr: true, ray_tracing_method: 'PROBE' })).reflections).toBe(false);
  });

  it('documents with the older Ambient Occlusion toggle keep occlusion through Fast GI', () => {
    const r = render({ use_gtao: true, gtao_distance: 0.7 });
    expect(raytracingEnabled(r)).toBe(true);
    expect(fastGiEnabled(r)).toBe(true);
    const t = traceSettings(r);
    expect(t.reflections).toBe(false);
    expect(t.fastGi).toBe(true);
    expect(t.giBounce).toBe(false);
    expect(t.giDistance).toBeCloseTo(0.7);
    // an explicit Fast GI choice wins over the old toggle
    expect(fastGiEnabled(render({ use_gtao: true, use_fast_gi: false }))).toBe(false);
  });

  it('precision maps to more tracing steps; the finer of both resolutions is traced', () => {
    const lo = traceSettings(render({ use_ssr: true, screen_trace_quality: 0 }));
    const hi = traceSettings(render({ use_ssr: true, screen_trace_quality: 1 }));
    expect(hi.steps).toBeGreaterThan(lo.steps);
    expect(traceSettings(render({ use_ssr: true, use_fast_gi: true, ray_tracing_resolution: '4', fast_gi_resolution: '1' })).resolution).toBe(1);
    expect(traceSettings(render({ use_ssr: true, ray_tracing_resolution: '4' })).resolution).toBe(4);
  });

  it('light range follows the light threshold', () => {
    expect(lightRange(100, 0.01)).toBeCloseTo(100);
    expect(lightRange(100, 0)).toBe(0);
    expect(lightRange(400, 0.01)).toBeCloseTo(2 * lightRange(100, 0.01));
  });

  it('shadow map size honours the texel limit, the budget and the scale', () => {
    // 10 m covered at 1 cm per texel wants 1000 px → 1024
    expect(shadowMapSize(10, 0.01, 4096, 1)).toBe(1024);
    // a tiny limit is capped by the budget
    expect(shadowMapSize(10, 0.0001, 2048, 1)).toBe(2048);
    expect(shadowMapSize(10, 0.0001, 2048, 0.5)).toBe(1024);
    // no limit: the whole budget
    expect(shadowMapSize(10, 0, 1024, 1)).toBe(1024);
    expect(shadowSettings(render()).enabled).toBe(true);
  });

  it('bloom maps onto the compositor glare terms', () => {
    const b = bloomOptions(render({ bloom_intensity: 0.05, bloom_radius: 6.5, bloom_threshold: 0.8 }));
    expect(b.strength).toBeCloseTo(1);
    expect(b.size).toBeCloseTo(0.65);
    expect(b.threshold).toBeCloseTo(0.8);
  });
});

describe('light influence', () => {
  const L = (kind: string, castShadow: boolean, f?: [number, number]) => ({
    visible: true,
    castShadow,
    [`is${kind}`]: true,
    userData: { influence: f },
  });

  it('orders lights like the renderer: shadow casters first, stable otherwise', () => {
    const a = L('PointLight', false, [1, 0]),
      b = L('PointLight', true, [0.5, 1]),
      c = L('PointLight', false, [0, 0]);
    expect(packedLightOrder([a, b, c])).toEqual([b, a, c]);
  });

  it('writes (1 - diffuse, 1 - glossy) per light and type', () => {
    const arrays = influenceArrays([L('PointLight', false, [1, 0]), L('SpotLight', false, [0.25, 1]), L('PointLight', true, [0.5, 1])]);
    // the shadow caster is packed first
    expect([...arrays.point.slice(0, 4)]).toEqual([0.5, 0, 0, 1]);
    expect([...arrays.spot.slice(0, 2)]).toEqual([0.75, 0]);
    expect(arrays.point).toBe(fxUniforms.ndLiPoint.value);
    expect(lightKind({ visible: true, isRectAreaLight: true, userData: {} })).toBe('rect');
  });
});

describe('shader patches', () => {
  it('wraps every direct light evaluation with its influence factors', () => {
    const out = patchLightsBegin(ShaderChunk.lights_fragment_begin);
    for (const arr of ['ndLiPoint', 'ndLiSpot', 'ndLiDir', 'ndLiRect', 'ndLiSun']) expect(out).toContain(`${arr}[ i ]`);
    // still one direct light call per loop
    expect(out.match(/RE_Direct\(/g)?.length).toBe(ShaderChunk.lights_fragment_begin.match(/RE_Direct\(/g)?.length);
    expect(out).toContain('ndGridWeight');
    // the loops still unroll: the influence lookup sits inside the loop body
    const loop = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*0\s*;\s*i\s*<\s*NUM_POINT_LIGHTS\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/.exec(out);
    expect(loop?.[1]).toContain('ndLiPoint[ i ]');
  });

  it('routes refraction lookups through the probe-aware sampler', () => {
    const out = patchTransmissionPars(ShaderChunk.transmission_pars_fragment);
    expect(out).not.toMatch(/getTransmissionSample\( refractionCoords/);
    expect(out.indexOf('vec4 ndRefractSample')).toBeLessThan(out.indexOf('vec4 getIBLVolumeRefraction('));
    expect(out.indexOf('vec4 ndRefractSample')).toBeGreaterThan(out.indexOf('vec4 getTransmissionSample('));
  });
});
