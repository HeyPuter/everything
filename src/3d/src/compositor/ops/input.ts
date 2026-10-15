// Input nodes: Render Layers, Image, Color, Value, Bokeh Image, Scene Time, Time Curve.
import type { SocketValue } from '../../data/types';
import { registerExec, type NodeCtx, type PassName } from '../eval/evaluator';
import { Result, IDENTITY, type Domain, type Xform } from '../eval/result';
import { cachedTexture, imageKey, imageSource } from '../eval/cache';
import { nodeCurves } from '../color/curvemap';
import type { Texture } from '../gpu/gpu';

const ident = (): Xform => [...IDENTITY] as Xform;

// ---------------------------------------------------------------------------
// Render Layers

/** Upload a top-down render pass as a bottom-up RGBA texture in the compositor's storage format. */
function passTexture(x: NodeCtx, pass: PassName): Texture | null {
  const L = x.env.layers;
  const src = L?.passes[pass];
  if (!L || !src) return null;
  return cachedTexture(`rl|${L.version}|${pass}`, () => {
    const { width: W, height: H } = L;
    const out = new Float32Array(W * H * 4);
    const ch = src.length >= W * H * 4 ? 4 : 1;
    for (let y = 0; y < H; y++) {
      const sy = H - 1 - y;
      if (ch === 4) {
        out.set(src.subarray(sy * W * 4, (sy + 1) * W * 4), y * W * 4);
        if (pass === 'Normal') for (let i = y * W * 4 + 3; i < (y + 1) * W * 4; i += 4) out[i] = 0;
      } else
        for (let i = 0; i < W; i++) {
          const v = src[sy * W + i];
          const k = (y * W + i) * 4;
          out[k] = out[k + 1] = out[k + 2] = v;
          out[k + 3] = 1;
        }
    }
    return x.gpu.upload(out, W, H, `pass:${pass}`);
  });
}

const ALPHA_PASS = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() { float a = cmpPx(u_src).a; o0 = vec4(vec3(a), 1.0); }`;

registerExec('CompositorNodeRLayers', (x) => {
  const L = x.env.layers;
  if (!L) {
    // no render yet: transparent images (single values fill the canvas)
    x.outs.set('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.outs.set('Alpha', Result.single('FLOAT', 0));
    x.outs.set('Depth', Result.single('FLOAT', 0));
    x.outs.set('Normal', Result.single('VECTOR', [0, 0, 0]));
    x.outs.set('Mist', Result.single('FLOAT', 0));
    return;
  }
  const d: Domain = { w: L.width, h: L.height, xf: ident() };
  const combined = passTexture(x, 'Combined');
  if (combined) {
    x.outs.set('Image', Result.image('RGBA', combined, d));
    const a = cachedTexture(`rl|${L.version}|Alpha`, () => {
      const t = x.gpu.alloc(d.w, d.h, 'pass:Alpha');
      x.ev.pass('rl-alpha', ALPHA_PASS, t, { u_src: combined });
      return t;
    });
    x.outs.set('Alpha', Result.image('FLOAT', a, d));
  }
  const depth = passTexture(x, 'Depth');
  if (depth) x.outs.set('Depth', Result.image('FLOAT', depth, d));
  const normal = passTexture(x, 'Normal');
  if (normal) x.outs.set('Normal', Result.image('VECTOR', normal, d));
  const mist = passTexture(x, 'Mist');
  if (mist) x.outs.set('Mist', Result.image('FLOAT', mist, d));
  // index, cryptomatte and AOV passes (outputs named after the passes)
  for (const s of x.outputSockets()) {
    if (x.outs.has(s.identifier) || !(s.identifier in L.passes)) continue;
    const t = passTexture(x, s.identifier);
    if (t) x.outs.set(s.identifier, Result.image(s.type === 'RGBA' ? 'RGBA' : 'FLOAT', t, d));
  }
});

// ---------------------------------------------------------------------------
// Image

const DECODE_PASS = `
uniform sampler2D u_src;
uniform int u_srgb;
uniform int u_alpha; // 0 straight, 1 premultiplied, 2 ignore
layout(location = 0) out vec4 o0;
vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
  vec4 c = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0);
  vec3 rgb = u_srgb == 1 ? srgbToLinear(c.rgb) : c.rgb;
  float a = u_alpha == 2 ? 1.0 : c.a;
  o0 = u_alpha == 1 ? vec4(rgb, a) : vec4(rgb * a, a);
}`;

registerExec('CompositorNodeImage', (x) => {
  const id = x.prop('image') as string | null;
  const img = id ? x.env.doc.images[id] : undefined;
  if (!img) {
    x.outs.set('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.outs.set('Alpha', Result.single('FLOAT', 0));
    return;
  }
  const src = imageSource(img);
  if (!src) {
    x.error('Loading image…');
    x.outs.set('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.outs.set('Alpha', Result.single('FLOAT', 0));
    return;
  }
  const key = `img|${imageKey(img)}|${src.w}x${src.h}`;
  const tex = cachedTexture(key, () => {
    const gl = x.gpu.gl;
    const raw = x.gpu.uploadSource(src.src, src.w, src.h);
    const t = x.gpu.alloc(src.w, src.h, `image:${img.name}`);
    x.ev.pass('image-decode', DECODE_PASS, t, {
      u_src: x.gpu.wrap(raw, src.w, src.h),
      u_srgb: img.colorspace === 'sRGB' ? 1 : 0,
      u_alpha: img.alpha_mode === 'PREMUL' ? 1 : img.alpha_mode === 'NONE' ? 2 : 0,
    });
    gl.deleteTexture(raw);
    return t;
  });
  const d: Domain = { w: src.w, h: src.h, xf: ident() };
  x.outs.set('Image', Result.image('RGBA', tex, d));
  const a = cachedTexture(`${key}|alpha`, () => {
    const t = x.gpu.alloc(d.w, d.h, 'image:alpha');
    x.ev.pass('rl-alpha', ALPHA_PASS, t, { u_src: tex });
    return t;
  });
  x.outs.set('Alpha', Result.image('FLOAT', a, d));
});

// ---------------------------------------------------------------------------
// Constants and scene values

registerExec('CompositorNodeRGB', (x) => {
  const c = (x.prop('outputs.Color') as number[] | null) ?? [0.5, 0.5, 0.5, 1];
  x.outs.set('Color', Result.single('RGBA', [c[0], c[1], c[2], c[3] ?? 1]));
});

registerExec('ShaderNodeValue', (x) => {
  const v = x.prop('outputs.Value');
  x.outs.set('Value', Result.single('FLOAT', typeof v === 'number' ? v : 0.5));
});

registerExec('CompositorNodeSceneTime', (x) => {
  x.outs.set('Frame', Result.single('FLOAT', x.env.frame));
  x.outs.set('Seconds', Result.single('FLOAT', x.env.frame / (x.env.fps || 24)));
});

registerExec('CompositorNodeTime', (x) => {
  const s = x.num('Start Frame', 1),
    e = x.num('End Frame', 250);
  const t = e !== s ? Math.min(1, Math.max(0, (x.env.frame - s) / (e - s))) : 0;
  const [curve] = nodeCurves(x.node.props, 1);
  x.outs.set('Fac', Result.single('FLOAT', Math.min(1, Math.max(0, curve(t)))));
});

// ---------------------------------------------------------------------------
// Bokeh Image (512 × 512 aperture shape)

const BOKEH_SIZE = 512;
const BOKEH_PASS = `
uniform float u_flaps;
uniform float u_angle;
uniform float u_round;
uniform float u_cata;
uniform float u_shift;
layout(location = 0) out vec4 o0;
const float PI = 3.14159265358979;
// signed inside-ness of the aperture (1 inside, 0 outside) at radius scale k
float aperture(vec2 p, float k) {
  float r = length(p) / k;
  float th = atan(p.y, p.x) - u_angle;
  float seg = 2.0 * PI / u_flaps;
  float a = mod(th, seg) - seg * 0.5;
  float poly = cos(seg * 0.5) / cos(a);
  float edge = mix(poly, 1.0, u_round);
  float aa = 2.0 / ${BOKEH_SIZE}.0 / k;
  float outer = 1.0 - smoothstep(edge - aa, edge + aa, r);
  float inner = u_cata > 0.0 ? smoothstep(u_cata * edge - aa, u_cata * edge + aa, r) : 1.0;
  return outer * inner;
}
void main() {
  vec2 p = (gl_FragCoord.xy / ${BOKEH_SIZE}.0) * 2.0 - 1.0;
  p /= 0.9;
  // chromatic aberration: red and blue apertures scaled in opposite directions
  float s = u_shift * 0.1;
  vec3 c = vec3(aperture(p, 1.0 + s), aperture(p, 1.0), aperture(p, 1.0 - s));
  o0 = vec4(c, max(c.r, max(c.g, c.b)));
}`;

registerExec('CompositorNodeBokehImage', (x) => {
  const flaps = Math.max(3, Math.min(24, Math.round(x.num('Flaps', 5)))),
    angle = x.num('Angle', 0),
    round = Math.min(1, Math.max(0, x.num('Roundness', 0))),
    cata = Math.min(1, Math.max(0, x.num('Catadioptric Size', 0))),
    shift = Math.min(1, Math.max(-1, x.num('Color Shift', 0)));
  const tex = cachedTexture(`bokeh|${flaps}|${angle}|${round}|${cata}|${shift}`, () => {
    const t = x.gpu.alloc(BOKEH_SIZE, BOKEH_SIZE, 'bokeh');
    x.ev.pass('bokeh-image', BOKEH_PASS, t, {
      u_flaps: flaps,
      u_angle: angle,
      u_round: round,
      u_cata: cata,
      u_shift: shift,
    });
    return t;
  });
  x.outs.set('Image', Result.image('RGBA', tex, { w: BOKEH_SIZE, h: BOKEH_SIZE, xf: ident() }));
});

export function singleNumber(v: SocketValue, d = 0) {
  return typeof v === 'number' ? v : d;
}
