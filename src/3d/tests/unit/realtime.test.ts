// @vitest-environment happy-dom
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

describe('shadows, materials and probes', async () => {
  const { diskSample, lightShadowMapSize, jitteredLightMatrix } = await import('../../src/render/realtime/shadows');
  const { renderMethod, blendForMethod, shadowMode } = await import('../../src/render/realtime/materialprops');
  const { defaultLightProbe, probeHelperSegments } = await import('../../src/render/realtime/probes/lightprobe');
  const { sphereInfluence, probePlane, volumeBox } = await import('../../src/render/realtime/probes/capture');
  const { Matrix4, Vector3 } = await import('three');

  it('jitter samples stay on the unit disk and move lights within their radius', () => {
    for (let i = 0; i < 64; i++) expect(Math.hypot(...diskSample(i))).toBeLessThanOrEqual(1);
    const base = new Matrix4().makeTranslation(0, 0, 5);
    const m = jitteredLightMatrix(base, 'point', 0.5, 0, 3, new Vector3());
    const p = new Vector3().setFromMatrixPosition(m);
    expect(p.z).toBeCloseTo(5);
    expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('point lights keep smaller shadow faces than spots and suns', () => {
    const q = { coverage: 10, unitCoverage: 2, limit: 0, absolute: false, budget: 2048, scale: 1 };
    expect(lightShadowMapSize({ ...q, kind: 'point' })).toBe(1024);
    expect(lightShadowMapSize({ ...q, kind: 'spot' })).toBe(2048);
    expect(lightShadowMapSize({ ...q, kind: 'sun' })).toBe(4096);
    // absolute limits use the size one unit from the light
    expect(lightShadowMapSize({ ...q, kind: 'spot', limit: 0.01, absolute: true })).toBe(256);
  });

  it('render method and shadow mode map onto the blend / shadow settings', () => {
    expect(renderMethod({ blend_method: 'OPAQUE' })).toBe('DITHERED');
    expect(renderMethod({ blend_method: 'BLEND' })).toBe('BLENDED');
    expect(blendForMethod({ blend_method: 'BLEND' }, 'DITHERED')).toBe('HASHED');
    expect(blendForMethod({ blend_method: 'CLIP' }, 'DITHERED')).toBe('CLIP');
    expect(blendForMethod({ blend_method: 'OPAQUE' }, 'BLENDED')).toBe('BLEND');
    expect(shadowMode({ shadow_method: 'CLIP' })).toBe('TRANSPARENT');
    expect(shadowMode({})).toBe('OPAQUE');
  });

  it('sphere probe influence fades over the falloff', () => {
    const p = { ...defaultLightProbe('SPHERE'), influence_distance: 2, falloff: 0.5 };
    const inv = new Matrix4();
    expect(sphereInfluence(p, inv, new Vector3(0, 0, 0.5))).toBe(1);
    expect(sphereInfluence(p, inv, new Vector3(1.5, 0, 0))).toBeCloseTo(0.5);
    expect(sphereInfluence(p, inv, new Vector3(2.5, 0, 0))).toBe(0);
    expect(sphereInfluence({ ...p, influence_type: 'BOX' }, inv, new Vector3(0.9, 0.9, 0.9))).toBe(1);
  });

  it('probe geometry: plane normal, volume box and helper lines', () => {
    const world = new Matrix4().makeRotationX(Math.PI / 2).setPosition(0, 0, 2);
    const { normal, origin } = probePlane(world);
    expect(normal.y).toBeCloseTo(-1);
    expect(origin.z).toBe(2);
    const b = volumeBox(new Matrix4().makeScale(2, 3, 4));
    expect(b.max.toArray()).toEqual([2, 3, 4]);
    for (const t of ['SPHERE', 'PLANE', 'VOLUME'] as const) expect(probeHelperSegments(defaultLightProbe(t)).length % 6).toBe(0);
  });
});

describe('ambient occlusion pass', async () => {
  const { ambientOcclusionPass } = await import('../../src/render/realtime/aopass');
  const { PerspectiveCamera } = await import('three');
  it('open surfaces are unoccluded, a crease darkens', () => {
    const cam = new PerspectiveCamera(60, 1, 0.1, 100);
    cam.updateMatrixWorld(true);
    const W = 32,
      H = 32;
    const flat = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) flat.set([0, 0, 1, 5], i * 4);
    const view = cam.matrixWorldInverse.elements;
    const a = ambientOcclusionPass(flat, W, H, cam.projectionMatrix.elements, cam.projectionMatrixInverse.elements, view, false, 1);
    expect(Math.min(...a)).toBeCloseTo(1);
    // right half is a wall standing closer, facing left: the floor next to it is occluded
    const crease = new Float32Array(flat);
    for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) crease.set([-1, 0, 0, 4.6], (y * W + x) * 4);
    const b = ambientOcclusionPass(crease, W, H, cam.projectionMatrix.elements, cam.projectionMatrixInverse.elements, view, false, 1);
    expect(b[(H / 2) * W + W / 2 - 1]).toBeLessThan(0.95);
    expect(b[(H / 2) * W + 1]).toBeGreaterThan(b[(H / 2) * W + W / 2 - 1]);
  });
});

describe('world sun extraction', async () => {
  const { extractSun } = await import('../../src/render/realtime/worldsun');
  const { texelDirection } = await import('../../src/render/final/environment');
  it('moves light above the threshold into a sun pointing at it', () => {
    const W = 64,
      H = 32;
    const data = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([0.5, 0.5, 0.5, 1], i * 4);
    // a bright texel up and towards +X
    const dir: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
    // the texel whose direction is closest
    let k = 0,
      best = -2;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const d = texelDirection((i + 0.5) / W, (j + 0.5) / H);
        const c = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
        if (c > best) [best, k] = [c, (j * W + i) * 4];
      }
    data.set([100, 100, 100, 1], k);
    const s = extractSun(data, W, H, 10)!;
    expect(s).not.toBeNull();
    expect(s.direction[0]).toBeGreaterThan(0.6);
    expect(s.direction[2]).toBeGreaterThan(0.6);
    expect(s.irradiance[0]).toBeGreaterThan(0);
    expect(s.data[k]).toBeCloseTo(10);
    expect(s.data[0]).toBe(0.5);
    expect(extractSun(data, W, H, 1000)).toBeNull();
  });
});

describe('shader AOVs', async () => {
  const { aovTree, uniqueAovName, aovPassName } = await import('../../src/render/realtime/aov');
  const { newMaterial } = await import('../../src/data/defaults');
  it('shades the AOV input as emission through a new active output', () => {
    const ma = newMaterial();
    const bsdf = ma.tree.nodes.find((n) => n.type === 'ShaderNodeBsdfPrincipled')!;
    ma.tree.nodes.push({ id: 'aov', type: 'ShaderNodeOutputAOV', name: 'AOV Output', location: [0, 0], inputs: { Color: [0, 0, 0, 1], Value: 0.5 }, props: { aov_name: 'm' } } as never);
    ma.tree.links.push({ id: 'l', from_node: bsdf.id, from_socket: 'BSDF', to_node: 'aov', to_socket: 'Color' } as never);
    expect(aovTree(ma.tree, 'nope', 'COLOR')).toBeNull();
    const t = aovTree(ma.tree, 'm', 'VALUE')!;
    const outs = t.nodes.filter((n) => n.type === 'ShaderNodeOutputMaterial');
    expect(outs.filter((n) => n.props.is_active_output)).toHaveLength(1);
    const emit = t.nodes.find((n) => n.type === 'ShaderNodeEmission')!;
    // the value is unlinked: it becomes the emission colour
    expect(emit.inputs.Color).toEqual([0.5, 0.5, 0.5, 1]);
    const c = aovTree(ma.tree, 'm', 'COLOR')!;
    expect(c.links.some((l) => l.to_node === c.nodes.find((n) => n.type === 'ShaderNodeEmission')!.id && l.from_node === bsdf.id)).toBe(true);
    // the material's own tree is untouched
    expect(ma.tree.nodes.some((n) => n.type === 'ShaderNodeEmission')).toBe(false);
  });
  it('names stay unique', () => {
    expect(uniqueAovName([])).toBe('AOV');
    expect(uniqueAovName([{ name: 'AOV' }, { name: 'AOV.001' }])).toBe('AOV.002');
    expect(aovPassName('x')).toBe('AOV:x');
  });
});
