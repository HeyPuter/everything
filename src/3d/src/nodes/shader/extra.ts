// Shader nodes beyond the first batch: hair and portal BSDFs, curves/particle/point/volume info,
// volume coefficients, radial tiling and the IES texture. Interface data comes from
// extra.gen.ts; the GLSL generators approximate each closure with the shared NdClosure model.
import type { DocumentData, NodeData } from '../../data/types';
import './extradefs';
import { registerGenerator, type NodeGen } from './codegen';
import { GLSL_LIB } from './glsl/lib';
import { RADIAL_GLSL } from './radial';
import { iesGrid, parseIes, type IesData } from './ies';

// ---------------------------------------------------------------------------
// GLSL library

Object.assign(GLSL_LIB, {
  nd_hair: {
    code: `
float nd_hair_f(float b) { return 5.969 - 0.215 * b + 2.532 * b * b - 10.73 * b * b * b + 5.574 * b * b * b * b + 0.245 * b * b * b * b * b; }
vec3 nd_hair_sigma(vec3 c, float b) { vec3 l = log(max(c, vec3(1e-4))) / nd_hair_f(b); return l * l; }
vec3 nd_hair_color(vec3 s, float b) { return exp(-sqrt(max(s, vec3(0.0))) * nd_hair_f(b)); }
vec3 nd_hair_melanin(float m, float red, float b) {
  float q = -log(max(1.0 - clamp(m, 0.0, 1.0), 1e-4));
  float r = clamp(red, 0.0, 1.0);
  return q * (1.0 - r) * vec3(0.419, 0.697, 1.37) + q * r * vec3(0.187, 0.4, 1.05);
}
`,
  },
  nd_radial: { code: RADIAL_GLSL },
  nd_ies: {
    code: `
float nd_ies(sampler2D t, vec3 v) {
  float l = length(v);
  if (l <= 0.0) return 0.0;
  v /= l;
  float va = acos(clamp(-v.z, -1.0, 1.0)) / 3.141592653589793;
  float ha = atan(v.x, -v.y);
  if (ha < 0.0) ha += 6.283185307179586;
  ha /= 6.283185307179586;
  vec2 size = vec2(textureSize(t, 0));
  vec2 uv = (vec2(va, ha) * (size - 1.0) + 0.5) / size;
  return texture(t, uv).r;
}
`,
  },
});

// ---------------------------------------------------------------------------
// Shader

registerGenerator('ShaderNodeBsdfHair', (g) => {
  const col = g.in('Color', 'vec3');
  const ru = g.tmp('float', `clamp(${g.in('RoughnessU', 'float')}, 0.0, 1.0)`);
  const rv = g.tmp('float', `clamp(${g.in('RoughnessV', 'float')}, 0.0, 1.0)`);
  if (g.str('component') === 'Transmission') {
    g.out('BSDF', 'NdClosure', `nd_cl_bsdf(${col} * 0.5, 0.0, 1.0, 1.5, 0.0, ${g.ctx.N})`);
    return;
  }
  // glossy reflection stretched along the strand direction
  g.feature('anisotropy');
  const c = g.tmp('NdClosure', `nd_cl_bsdf(${col}, 1.0, ${ru}, 1.5, 0.5, ${g.ctx.N})`);
  g.stmt(`${c}.aniso = clamp((${rv} - ${ru}) / max(${rv} + ${ru}, 1e-4), 0.0, 1.0); ${c}.anisoRot = ${g.in('Offset', 'float')} / 6.2831853;`);
  g.out('BSDF', 'NdClosure', c);
});

/** Visible strand color of the principled hair node (CPU mirror of the GLSL, used for the path tracer). */
export function hairColor(par: string, inputs: { color: number[]; melanin: number; redness: number; tint: number[]; absorption: number[]; radial: number }): [number, number, number] {
  const f = (b: number) => 5.969 - 0.215 * b + 2.532 * b * b - 10.73 * b ** 3 + 5.574 * b ** 4 + 0.245 * b ** 5;
  const b = inputs.radial;
  if (par === 'COLOR') return [inputs.color[0], inputs.color[1], inputs.color[2]];
  let s: number[];
  if (par === 'ABSORPTION') s = inputs.absorption.slice(0, 3);
  else {
    const q = -Math.log(Math.max(1 - Math.min(1, Math.max(0, inputs.melanin)), 1e-4));
    const r = Math.min(1, Math.max(0, inputs.redness));
    const eu = [0.419, 0.697, 1.37],
      ph = [0.187, 0.4, 1.05];
    s = [0, 1, 2].map((i) => q * (1 - r) * eu[i] + q * r * ph[i] + (Math.log(Math.max(inputs.tint[i], 1e-4)) / f(b)) ** 2);
  }
  return [0, 1, 2].map((i) => Math.exp(-Math.sqrt(Math.max(s[i], 0)) * f(b))) as [number, number, number];
}

registerGenerator('ShaderNodeBsdfHairPrincipled', (g) => {
  g.lib('nd_hair');
  const huang = g.str('model') === 'HUANG';
  const beta = g.tmp('float', huang ? `clamp(${g.in('Roughness', 'float')}, 0.0, 1.0)` : `clamp(${g.in('Radial Roughness', 'float')}, 0.0, 1.0)`);
  const par = g.str('parametrization') || 'COLOR';
  let col: string;
  if (par === 'COLOR') col = g.in('Color', 'vec3');
  else if (par === 'ABSORPTION') col = `nd_hair_color(${g.in('Absorption Coefficient', 'vec3')}, ${beta})`;
  else {
    g.feature('objectInfo');
    const rnd = g.tmp('float', g.inOr('Random', 'float', g.ctx.objRandom));
    const m = g.tmp('float', `${g.in('Melanin', 'float')} * (1.0 + ${g.in('Random Color', 'float')} * (2.0 * ${rnd} - 1.0))`);
    col = `nd_hair_color(nd_hair_melanin(${m}, ${g.in('Melanin Redness', 'float')}, ${beta}) + nd_hair_sigma(${g.in('Tint', 'vec3')}, ${beta}), ${beta})`;
  }
  const rough = g.tmp('float', `clamp(${g.in('Roughness', 'float')}, 0.0, 1.0)`);
  g.out('BSDF', 'NdClosure', `nd_cl_bsdf(${col}, 0.0, ${rough}, max(${g.in('IOR', 'float')}, 1.0), 0.5, ${g.ctx.N})`);
});

registerGenerator('ShaderNodeBsdfRayPortal', (g) => {
  // seen from the camera a portal with its default position and direction passes rays straight
  // through, like a transparent surface tinted by its color
  g.feature('alpha');
  const c = g.tmp('NdClosure', `nd_cl_empty(${g.ctx.N})`);
  g.stmt(`${c}.alpha = clamp(1.0 - nd_luma(${g.in('Color', 'vec3')}), 0.0, 1.0);`);
  g.out('BSDF', 'NdClosure', c);
});

registerGenerator('ShaderNodeVolumeCoefficients', (g) => {
  g.feature('alpha');
  const ab = g.tmp('vec3', `max(${g.in('Absorption Coefficients', 'vec3')}, vec3(0.0))`);
  const sc = g.tmp('vec3', `max(${g.in('Scatter Coefficients', 'vec3')}, vec3(0.0))`);
  const ext = g.tmp('vec3', `${ab} + ${sc}`);
  const dens = g.tmp('float', `1.0 - exp(-dot(${ext}, vec3(1.0 / 3.0)) * 0.7)`);
  const c = g.tmp('NdClosure', `nd_cl_empty(${g.ctx.N})`);
  g.stmt(
    `${c}.base = ${sc} / max(${ext}, vec3(1e-6)); ${c}.alpha = ${dens}; ${c}.weight = ${dens}; ${c}.roughness = 1.0; ${c}.specular = 0.0; ${c}.emission = max(${g.in('Emission Coefficients', 'vec3')}, vec3(0.0));`,
  );
  g.out('Volume', 'NdClosure', c);
});

// ---------------------------------------------------------------------------
// Input: attributes of geometry types other than meshes. Surfaces rendered from meshes have no
// strands, particles, points or volume grids, so these read as zero (like any renderer does).

registerGenerator(['ShaderNodeHairInfo', 'ShaderNodeParticleInfo', 'ShaderNodePointInfo'], () => {
  // every output keeps its zero default
});
registerGenerator('ShaderNodeVolumeInfo', (g) => {
  g.out('Color', 'vec4', 'vec4(0.0, 0.0, 0.0, 1.0)');
});

// ---------------------------------------------------------------------------
// Vector: Radial Tiling

registerGenerator('ShaderNodeRadialTiling', (g) => {
  g.lib('nd_radial');
  const co = g.tmp('vec3', 'vec3(0.0)'),
    id = g.tmp('float', '0.0'),
    w = g.tmp('float', '0.0'),
    rot = g.tmp('float', '0.0');
  g.stmt(`nd_radial_tiling(${g.in('Vector', 'vec3')}, ${g.in('Sides', 'float')}, ${g.in('Roundness', 'float')}, ${g.prop('normalize') ? 'true' : 'false'}, ${co}, ${id}, ${w}, ${rot});`);
  g.out('Segment Coordinates', 'vec3', co);
  g.out('Segment ID', 'float', id);
  g.out('Segment Width', 'float', w);
  g.out('Segment Rotation', 'float', rot);
});

// ---------------------------------------------------------------------------
// Texture: IES

const iesCache = new Map<string, IesData | null>();
/** Parsed IES data of a node's text data-block (cached by content). */
export function nodeIes(doc: DocumentData, n: NodeData): IesData | null {
  const id = n.props.ies as string | null | undefined;
  const text = id ? doc.texts[id] : undefined;
  if (!text) return null;
  const key = text.body;
  if (!iesCache.has(key)) {
    if (iesCache.size > 16) iesCache.clear();
    iesCache.set(key, parseIes(text.body));
  }
  return iesCache.get(key) ?? null;
}

registerGenerator('ShaderNodeTexIES', (g) => {
  const data = nodeIes(g.doc, g.node);
  if (!data) {
    if (g.node.props.ies) g.error('The IES text is not a valid photometric file');
    g.out('Fac', 'float', '0.0');
    return;
  }
  g.lib('nd_ies');
  const grid = iesGrid(data);
  const t = g.uniform('sampler2D', { kind: 'lut', data: grid.data, width: grid.width });
  const v = g.inOr('Vector', 'vec3', g.ctx.N);
  g.out('Fac', 'float', `nd_ies(${t}, ${v}) * ${g.in('Strength', 'float')}`);
});
