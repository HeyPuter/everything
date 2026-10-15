// Per-pixel nodes: GLSL generators (the shader editor's NodeGen API) compiled into one fullscreen
// pass. Shader nodes shared with the compositor (Math, Map Range, Mix, Color Ramp, …) reuse the
// shader generators unchanged; compositor colour nodes register their own (ops/color.ts).
//
// Inputs that are images are realized on the operation domain and fetched per pixel; single
// values become uniforms (constants) or 1×1 textures (values computed on the GPU).
import type { SocketValue } from '../../data/types';
import {
  nodeGenerators,
  type NodeGen,
  type NodeGenerator,
  type GType as SGType,
  type UniformSpec,
  type UniformValue as SUniformValue,
  MATERIAL_CONTEXT,
  type ShadingContext,
} from '../../nodes/shader/codegen';
import { GLSL_LIB, collectLib, type GlslLib } from '../../nodes/shader/glsl/lib';
import { findSocket, inputValue, propValue } from '../../nodes/registry';
import type { Texture, UniformValue } from '../gpu/gpu';
import { COLOR_GLSL } from '../color/colorops';
import { CURVE_GLSL } from '../color/curvemap';
import { Result, asVec4, type Domain } from './result';
import { pack, readAs, type GType } from './convert';
import { dataTypeOf, type NodeCtx } from './evaluator';

/** Compositor-specific per-pixel generators (take precedence over shader generators). */
export const pixelGenerators: Record<string, NodeGenerator> = {};
export function registerPixel(idnames: string | string[], gen: NodeGenerator) {
  for (const id of Array.isArray(idnames) ? idnames : [idnames]) pixelGenerators[id] = gen;
}

export function pixelGeneratorFor(idname: string): NodeGenerator | undefined {
  return pixelGenerators[idname] ?? nodeGenerators[idname];
}

/** Compositor GLSL chunks usable through g.lib(). */
export const CMP_LIB: GlslLib = {
  ...COLOR_GLSL,
  cmp_curve: { code: CURVE_GLSL },
};

// shading-context expressions: the compositor has no geometry; coordinates are the normalized
// image position so texture-like generators still produce something sensible
const PIXEL_CONTEXT: ShadingContext = Object.fromEntries(Object.keys(MATERIAL_CONTEXT).map((k) => [k, 'vec3(0.0)'])) as unknown as ShadingContext;
Object.assign(PIXEL_CONTEXT, {
  uv: 'vec3(cmpUV, 0.0)',
  // procedural textures: centred coordinates with the larger image side spanning -1..1
  orco: 'vec3(cmpUniform, 0.0)',
  win: 'vec3(cmpUV, 0.0)',
  col: 'vec4(0.0)',
  back: '0.0',
  objIndex: '0.0',
  matIndex: '0.0',
  objRandom: '0.0',
  objColor: 'vec4(0.0)',
});

interface InputBinding {
  name: string;
  result: Result;
  /** uniform vec4 (constant) or sampler */
  uniform: boolean;
}

/** Run a per-pixel generator for the node in `x`. Outputs are written into x.outs. */
export function runPixelNode(x: NodeCtx, gen: NodeGenerator, opts: { domain?: Domain | null } = {}) {
  const domain = opts.domain !== undefined ? opts.domain : x.domain();
  const inputs = new Map<string, InputBinding>();
  const uniforms: {
    name: string;
    type: UniformSpec['type'];
    value: UniformValue;
  }[] = [];
  const lines: string[] = [];
  const libs = new Set<string>(['nd_math']);
  const outs: { id: string; expr: string; type: SGType }[] = [];
  let vars = 0;
  const errors: string[] = [];
  const luts: Texture[] = [];
  const nearestLuts = new Set<string>();

  const bind = (id: string): InputBinding => {
    let b = inputs.get(id);
    if (b) return b;
    const r = x.input(id);
    const uniform = !r.domain && !r.tex && r.value !== undefined;
    b = { name: `u_in${inputs.size}`, result: r, uniform };
    inputs.set(id, b);
    return b;
  };
  const declare = (type: string, expr: string) => {
    const v = `v${vars++}`;
    lines.push(`${type} ${v} = ${expr};`);
    return v;
  };
  const toG = (t: SGType): GType => (t === 'vec3' ? 'vec3' : t === 'vec4' ? 'vec4' : 'float');
  const inExpr = (id: string, type: SGType) => {
    if (type === 'NdClosure') throw new Error('Shader sockets are not supported in the compositor');
    const b = bind(id);
    const t = b.uniform ? b.name : `cmpPx(${b.name})`;
    return declare(type, readAs(t, b.result.type, toG(type)));
  };
  const g: NodeGen = {
    node: x.node,
    target: 'MATERIAL',
    ctx: PIXEL_CONTEXT,
    doc: x.env.doc,
    in: (id, type) => inExpr(id, type),
    inOr: (id, type, fallback) => (x.linked(id) ? inExpr(id, type) : fallback),
    linked: (id) => x.linked(id),
    value: (id) => {
      const s = findSocket(x.node, id, false, x.ctx);
      return s ? inputValue(x.node, s) : null;
    },
    prop: (id) => propValue(x.node, id),
    str: (id) => String(propValue(x.node, id) ?? ''),
    out: (id, type, expr) => {
      outs.push({ id, expr: declare(type, expr), type });
    },
    tmp: (type, expr) => declare(type, expr),
    stmt: (code) => lines.push(code),
    lib: (...names) => names.forEach((n) => libs.add(n)),
    uniform: (type, value) => {
      const name = `u_u${uniforms.length}`;
      if (typeof value === 'object' && !Array.isArray(value)) {
        if (value.kind === 'lut') {
          const t = x.ev.alloc(value.width, value.data.length / 4 / value.width, 'lut');
          x.gpu.gl.bindTexture(x.gpu.gl.TEXTURE_2D, t.tex);
          x.gpu.gl.texSubImage2D(x.gpu.gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, x.gpu.gl.RGBA, x.gpu.gl.FLOAT, value.data);
          luts.push(t);
          if (value.nearest) nearestLuts.add(name);
          uniforms.push({ name, type: 'sampler2D', value: t });
          return name;
        }
        throw new Error('Image textures are not supported in the compositor');
      }
      uniforms.push({ name, type, value: value as UniformValue });
      return name;
    },
    feature: () => {},
    error: (msg) => errors.push(msg),
  };
  gen(g);
  for (const e of errors) x.error(e);

  const outSockets = x.outputSockets();
  const sockOf = (id: string) => outSockets.find((s) => s.identifier === id);
  const produced = outs.filter((o) => sockOf(o.id));
  if (!produced.length) return;

  // GLSL assembly
  const ourLibs = [...libs].filter((n) => CMP_LIB[n]);
  const shaderLibs = [...libs].filter((n) => !CMP_LIB[n] && GLSL_LIB[n]);
  const decl: string[] = [];
  for (const b of inputs.values()) decl.push(b.uniform ? `uniform vec4 ${b.name};` : `uniform sampler2D ${b.name};`);
  for (const u of uniforms) decl.push(`uniform ${u.type} ${u.name};`);
  // shader-node LUT lookups use texture(); our LUT textures are NEAREST, so interpolate manually
  const usesLut = uniforms.some((u) => u.type === 'sampler2D');
  const body = lines.join('\n  ');
  const chunks = Math.ceil(produced.length / 4);
  const size = domain ? domain : { w: 1, h: 1 };
  const results = new Map<string, Result>();
  for (let c = 0; c < chunks; c++) {
    const part = produced.slice(c * 4, c * 4 + 4);
    const src = [
      shaderLibs.length ? collectLib(shaderLibs) : '',
      ourLibs.length ? collectLib(ourLibs, CMP_LIB) : '',
      usesLut ? LUT_TEXTURE_OVERRIDE : '',
      decl.join('\n'),
      part.map((_, i) => `layout(location = ${i}) out vec4 o${i};`).join('\n'),
      'void main() {',
      `  vec2 cmpUV = gl_FragCoord.xy / vec2(${size.w}.0, ${size.h}.0);`,
      `  vec2 cmpUniform = (gl_FragCoord.xy - vec2(${size.w}.0, ${size.h}.0) * 0.5) / (${Math.max(size.w, size.h)}.0 * 0.5);`,
      `  ${body}`,
      ...part.map((o, i) => `  o${i} = ${pack(o.expr, toG(o.type), dataTypeOf(sockOf(o.id)!.type))};`),
      '}',
    ].join('\n');
    const texs = part.map(() => x.alloc(size, x.node.type));
    const u: Record<string, UniformValue> = {};
    for (const b of inputs.values()) {
      if (b.uniform) u[b.name] = asVec4(b.result.type, b.result.value as SocketValue);
      else u[b.name] = b.result.domain && domain ? x.ev.realize(b.result, domain) : x.ev.tex(b.result);
    }
    for (const un of uniforms) u[un.name] = un.value as UniformValue;
    let code = src;
    // shader-node LUT lookups use texture(); our LUT textures are stored NEAREST
    for (const n of nearestLuts) code = code.replace(new RegExp(`\\btexture\\((${n})\\b`, 'g'), 'cmpLutNearest($1');
    if (usesLut) code = code.replace(/\btexture\(/g, 'cmpLutTexture(');
    x.pass(`px:${code}`, code, texs, u);
    part.forEach((o, i) => {
      const s = sockOf(o.id)!;
      const r = domain ? Result.image(dataTypeOf(s.type), texs[i], domain) : Object.assign(new Result(dataTypeOf(s.type)), { tex: texs[i] });
      results.set(o.id, r);
    });
  }
  for (const [id, r] of results) x.outs.set(id, r);
}

/** Bilinear lookup used in place of texture() for LUT samplers (stored NEAREST). */
const LUT_TEXTURE_OVERRIDE = /* glsl */ `
vec4 cmpLutTexture(sampler2D t, vec2 uv) {
  vec2 s = vec2(textureSize(t, 0));
  vec2 p = uv * s - 0.5;
  vec2 f = floor(p);
  vec2 w = p - f;
  ivec2 i = ivec2(f);
  ivec2 m = ivec2(s) - 1;
  vec4 a = texelFetch(t, clamp(i, ivec2(0), m), 0);
  vec4 b = texelFetch(t, clamp(i + ivec2(1, 0), ivec2(0), m), 0);
  vec4 c = texelFetch(t, clamp(i + ivec2(0, 1), ivec2(0), m), 0);
  vec4 d = texelFetch(t, clamp(i + ivec2(1, 1), ivec2(0), m), 0);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
vec4 cmpLutNearest(sampler2D t, vec2 uv) {
  ivec2 s = textureSize(t, 0);
  return texelFetch(t, clamp(ivec2(floor(uv * vec2(s))), ivec2(0), s - 1), 0);
}
`;

export type { SUniformValue };
