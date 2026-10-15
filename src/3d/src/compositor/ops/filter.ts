// Filter nodes: Blur (all filter types, separable or not, extend bounds), Bilateral Blur, Bokeh
// Blur, Defocus, Directional Blur, Filter (3×3 kernels), Dilate/Erode, Despeckle, Denoise,
// Anti-Aliasing, Pixelate, Kuwahara and the anti-aliased Depth Combine.
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, type Domain } from '../eval/result';
import { runPixelNode, pixelGeneratorFor } from '../eval/pixel';
import { menuValue } from '../nodes/defs';
import type { Texture } from '../gpu/gpu';
import { denoiseSchedule, ATROUS_TAPS } from '../../render/final/denoise';

// ---------------------------------------------------------------------------
// filter weights (t = |offset| / radius)

export type BlurType = 'Flat' | 'Tent' | 'Quadratic' | 'Cubic' | 'Gaussian' | 'Fast Gaussian' | 'Catrom' | 'Mitch';

export function filterWeight(type: BlurType, t: number): number {
  t = Math.abs(t);
  if (t > 1) return 0;
  const x = t * 1.6;
  switch (type) {
    case 'Flat':
      return 1;
    case 'Tent':
      return 1 - t;
    case 'Quadratic':
      return x <= 0.5 ? 0.75 - x * x : x < 1.5 ? 0.5 * (x - 1.5) * (x - 1.5) : 0;
    case 'Cubic':
      return x < 1 ? (3 * x * x * x - 6 * x * x + 4) / 6 : x < 2 ? Math.pow(2 - x, 3) / 6 : 0;
    case 'Catrom':
      return x < 1 ? 1.5 * x * x * x - 2.5 * x * x + 1 : x < 2 ? -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2 : 0;
    case 'Mitch':
      return x < 1 ? (7 * x * x * x - 12 * x * x + 16 / 3) / 6 : x < 2 ? ((-7 / 3) * x * x * x + 12 * x * x - 20 * x + 32 / 3) / 6 : 0;
    default:
      return Math.exp(-4.5 * t * t);
  }
}

/** Normalized 1D kernel for a radius (taps −r..r). */
export function blurKernel(type: BlurType, radius: number): Float32Array {
  const r = Math.max(0, Math.ceil(radius - 1e-6));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = radius > 0 ? filterWeight(type, i / radius) : i === 0 ? 1 : 0;
    k[i + r] = w;
    sum += w;
  }
  if (sum !== 0) for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

function kernelTexture(x: NodeCtx, k: Float32Array): Texture {
  const t = x.ev.alloc(k.length, 1, 'kernel');
  const data = new Float32Array(k.length * 4);
  for (let i = 0; i < k.length; i++) data[i * 4] = k[i];
  const gl = x.gpu.gl;
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, k.length, 1, gl.RGBA, gl.FLOAT, data);
  return t;
}

const BLUR_1D = `
uniform sampler2D u_src;
uniform sampler2D u_k;
uniform ivec2 u_dir;
uniform int u_ext;
layout(location = 0) out vec4 o0;
void main() {
  int n = textureSize(u_k, 0).x;
  int r = n / 2;
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < n; i++) {
    float w = texelFetch(u_k, ivec2(i, 0), 0).r;
    acc += w * cmpFetch(u_src, p + u_dir * (i - r), u_ext, u_ext);
  }
  o0 = acc;
}`;

const BLUR_2D = `
uniform sampler2D u_src;
uniform sampler2D u_kx;
uniform sampler2D u_ky;
uniform vec2 u_radius;
uniform int u_ext;
layout(location = 0) out vec4 o0;
void main() {
  int nx = textureSize(u_kx, 0).x, ny = textureSize(u_ky, 0).x;
  int rx = nx / 2, ry = ny / 2;
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < ny; j++)
    for (int i = 0; i < nx; i++) {
      vec2 o = vec2(float(i - rx), float(j - ry)) / max(u_radius, vec2(1e-6));
      // circular support (slightly beyond the radius so the axes keep their full extent)
      if (dot(o, o) > (1.0 + 0.5 / max(u_radius.x, 1.0)) * (1.0 + 0.5 / max(u_radius.y, 1.0))) continue;
      float w = texelFetch(u_kx, ivec2(i, 0), 0).r * texelFetch(u_ky, ivec2(j, 0), 0).r;
      acc += w * cmpFetch(u_src, p + ivec2(i - rx, j - ry), u_ext, u_ext);
      wsum += w;
    }
  o0 = wsum != 0.0 ? acc / wsum : acc;
}`;

/** Separable/non-separable blur of a texture (same size output). */
export function blurTexture(x: NodeCtx, src: Texture, type: BlurType, rx: number, ry: number, separable = true, ext = 0): Texture {
  const kx = blurKernel(type, rx),
    ky = blurKernel(type, ry);
  if (!separable) {
    const out = x.ev.alloc(src.w, src.h, 'blur');
    x.pass('blur-2d', BLUR_2D, out, {
      u_src: src,
      u_kx: kernelTexture(x, kx),
      u_ky: kernelTexture(x, ky),
      u_radius: [rx, ry],
      u_ext: ext,
    });
    return out;
  }
  let cur = src;
  if (kx.length > 1) {
    const t = x.ev.alloc(src.w, src.h, 'blur-x');
    x.pass('blur-1d', BLUR_1D, t, {
      u_src: cur,
      u_k: kernelTexture(x, kx),
      u_dir: [1, 0],
      u_ext: ext,
    });
    cur = t;
  }
  if (ky.length > 1) {
    const t = x.ev.alloc(src.w, src.h, 'blur-y');
    x.pass('blur-1d', BLUR_1D, t, {
      u_src: cur,
      u_k: kernelTexture(x, ky),
      u_dir: [0, 1],
      u_ext: ext,
    });
    cur = t;
  }
  return cur;
}

/** Domain grown by `gx`, `gy` pixels on each side (Extend Bounds), with the image centred. */
function grown(d: Domain, gx: number, gy: number): Domain {
  return { w: d.w + 2 * gx, h: d.h + 2 * gy, xf: d.xf };
}

registerExec('CompositorNodeBlur', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const [sx, sy] = x.vec('Size', 2).map((v) => Math.max(0, v));
  const type = (menuValue(x.node, 'Type') || 'Gaussian') as BlurType;
  if (sx <= 0 && sy <= 0) return x.out('Image', r);
  let d = r.domain;
  let src = r.tex!;
  if (x.bool('Extend Bounds')) {
    d = grown(r.domain, Math.ceil(sx), Math.ceil(sy));
    src = x.ev.realize(r.withDomain(r.domain, { interp: 0, extX: 0, extY: 0 }), d);
  }
  const out = blurTexture(x, src, type, sx, sy, x.bool('Separable'), 1);
  x.out('Image', Result.image('RGBA', out, d));
});

// ---------------------------------------------------------------------------
// Bilateral blur: neighbours whose determinator colour is within the threshold

const BILATERAL = `
uniform sampler2D u_src;
uniform sampler2D u_det;
uniform int u_radius;
uniform float u_threshold;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d0 = cmpPx(u_det);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = -u_radius; j <= u_radius; j++)
    for (int i = -u_radius; i <= u_radius; i++) {
      ivec2 q = p + ivec2(i, j);
      vec4 d = textureSize(u_det, 0).x > 1 ? cmpFetch(u_det, q, 1, 1) : d0;
      vec3 dd = abs(d.rgb - d0.rgb);
      if (dd.r + dd.g + dd.b > u_threshold) continue;
      acc += cmpFetch(u_src, q, 1, 1);
      wsum += 1.0;
    }
  o0 = wsum > 0.0 ? acc / wsum : cmpPx(u_src);
}`;

registerExec('CompositorNodeBilateralblur', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const radius = Math.max(0, Math.round(x.num('Size')));
  if (!radius) return x.out('Image', r);
  const t = x.alloc(r.domain);
  const det = x.input('Determinator');
  x.pass('bilateral', BILATERAL, t, {
    u_src: r.tex!,
    u_det: det.domain ? x.ev.realize(det, r.domain) : x.ev.tex(det),
    u_radius: radius,
    u_threshold: Math.max(0, x.num('Threshold')),
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Bokeh Blur: convolution with the bokeh image scaled to the blur radius (per channel weights);
// the mask scales the radius per pixel

const BOKEH = `
uniform sampler2D u_src;
uniform sampler2D u_bokeh;
uniform sampler2D u_mask;
uniform float u_radius;
uniform int u_ext;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float rad = u_radius * clamp(cmpPx(u_mask).r, 0.0, 1.0);
  int r = int(ceil(rad));
  if (r < 1) { o0 = cmpPx(u_src); return; }
  vec4 acc = vec4(0.0);
  vec4 wsum = vec4(0.0);
  for (int j = -r; j <= r; j++)
    for (int i = -r; i <= r; i++) {
      vec2 uv = (vec2(i, j) / rad) * 0.5 + 0.5;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
      vec4 w = cmpSampleUV(u_bokeh, uv);
      w.a = (w.r + w.g + w.b) / 3.0;
      if (w.a <= 0.0) continue;
      acc += w * cmpFetch(u_src, p + ivec2(i, j), u_ext, u_ext);
      wsum += w;
    }
  o0 = vec4(wsum.r > 0.0 ? acc.r / wsum.r : 0.0, wsum.g > 0.0 ? acc.g / wsum.g : 0.0, wsum.b > 0.0 ? acc.b / wsum.b : 0.0, wsum.a > 0.0 ? acc.a / wsum.a : 0.0);
}`;

registerExec('CompositorNodeBokehBlur', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const size = Math.max(0, x.num('Size'));
  if (size <= 0) return x.out('Image', r);
  let d = r.domain;
  let src = r.tex!;
  if (x.bool('Extend Bounds')) {
    d = grown(r.domain, Math.ceil(size), Math.ceil(size));
    src = x.ev.realize(r.withDomain(r.domain, { interp: 0, extX: 0, extY: 0 }), d);
  }
  const bokeh = x.input('Bokeh');
  const mask = x.input('Mask');
  const t = x.alloc(d);
  x.pass('bokeh-blur', BOKEH, t, {
    u_src: src,
    u_bokeh: bokeh.domain ? bokeh.tex! : x.ev.tex(bokeh),
    u_mask: mask.domain ? x.ev.realize(mask, d) : x.ev.tex(mask),
    u_radius: Math.min(size, 256),
    u_ext: 1,
  });
  x.out('Image', Result.image('RGBA', t, d));
});

// ---------------------------------------------------------------------------
// Defocus: variable-size polygonal bokeh driven by a depth (circle of confusion) or radius map

const DEFOCUS = `
uniform sampler2D u_src;
uniform sampler2D u_radius;
uniform float u_maxr;
uniform float u_flaps;
uniform float u_angle;
layout(location = 0) out vec4 o0;
const float PI = 3.14159265358979;
float inside(vec2 o, float r) {
  if (r <= 0.5) return dot(o, o) < 0.25 ? 1.0 : 0.0;
  float d = length(o) / r;
  if (u_flaps < 3.0) return clamp((1.0 - d) * r + 0.5, 0.0, 1.0);
  float seg = 2.0 * PI / u_flaps;
  float a = mod(atan(o.y, o.x) - u_angle, seg) - seg * 0.5;
  float edge = cos(seg * 0.5) / cos(a);
  return clamp((edge - d) * r + 0.5, 0.0, 1.0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int R = int(ceil(u_maxr));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  // gather: a neighbour contributes when the pixel lies inside its circle of confusion
  for (int j = -R; j <= R; j++)
    for (int i = -R; i <= R; i++) {
      ivec2 q = p + ivec2(i, j);
      ivec2 s = textureSize(u_src, 0);
      if (q.x < 0 || q.y < 0 || q.x >= s.x || q.y >= s.y) continue;
      float rq = min(texelFetch(u_radius, q, 0).r, u_maxr);
      float w = inside(vec2(-i, -j), rq) / max(rq * rq, 0.25);
      if (w <= 0.0) continue;
      acc += w * texelFetch(u_src, q, 0);
      wsum += w;
    }
  o0 = wsum > 0.0 ? acc / wsum : texelFetch(u_src, p, 0);
}`;

const COC = `
uniform sampler2D u_z;
uniform int u_zbuf;
uniform float u_scale;
uniform float u_focus;
uniform float u_aperture;
layout(location = 0) out vec4 o0;
void main() {
  float z = cmpPx(u_z).r;
  float r;
  if (u_zbuf == 1) {
    // thin lens: blur radius (pixels) from depth, focus distance and aperture
    r = z > 0.0 ? u_aperture * abs(z - u_focus) / z : 0.0;
  } else r = z * u_scale;
  o0 = vec4(vec3(max(r, 0.0)), 1.0);
}`;

const FLAPS: Record<string, number> = {
  OCTAGON: 8,
  HEPTAGON: 7,
  HEXAGON: 6,
  PENTAGON: 5,
  SQUARE: 4,
  TRIANGLE: 3,
  CIRCLE: 0,
};

registerExec('CompositorNodeDefocus', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const d = r.domain;
  const z = x.input('Z');
  const useZ = !!x.prop('use_zbuffer');
  const maxBlur = Math.min(Math.max(0, Number(x.prop('blur_max') ?? 16)), 128);
  // camera focus for the depth mode
  const doc = x.env.doc;
  const cam = doc.scene.camera ? doc.objects[doc.scene.camera] : undefined;
  const camData = cam?.data ? doc.cameras[cam.data] : undefined;
  const focus = (camData as { dof?: { focus_distance?: number } } | undefined)?.dof?.focus_distance ?? 10;
  const fstop = Math.max(0.1, Number(x.prop('f_stop') ?? 128));
  const lens = (camData as { lens?: number } | undefined)?.lens ?? 50;
  const sensor = (camData as { sensor_width?: number } | undefined)?.sensor_width ?? 36;
  // aperture diameter in pixels at the focus plane: focal length / f-stop, converted through the sensor
  const aperture = ((lens / fstop) * (d.w / sensor)) / 2;
  const coc = x.alloc(d, 'coc');
  x.pass('defocus-coc', COC, coc, {
    u_z: z.domain ? x.ev.realize(z, d) : x.ev.tex(z),
    u_zbuf: useZ ? 1 : 0,
    u_scale: Number(x.prop('z_scale') ?? 1),
    u_focus: focus,
    u_aperture: aperture,
  });
  const t = x.alloc(d);
  x.pass('defocus', DEFOCUS, t, {
    u_src: r.tex!,
    u_radius: coc,
    u_maxr: maxBlur,
    u_flaps: FLAPS[String(x.prop('bokeh') ?? 'CIRCLE')] ?? 0,
    u_angle: Number(x.prop('angle') ?? 0),
  });
  x.out('Image', Result.image('RGBA', t, d));
});

// ---------------------------------------------------------------------------
// Directional blur: average of the image under progressively applied scale/rotation/translation

const DBLUR = `
uniform sampler2D u_src;
uniform int u_samples;
uniform vec2 u_center;
uniform float u_rot;
uniform float u_scale;
uniform vec2 u_trans;
layout(location = 0) out vec4 o0;
void main() {
  vec2 size = vec2(textureSize(u_src, 0));
  vec2 c = u_center * size;
  vec2 p = gl_FragCoord.xy - c;
  vec4 acc = cmpBilinear(u_src, gl_FragCoord.xy, 0, 0);
  for (int i = 1; i <= u_samples; i++) {
    float t = float(i) / float(u_samples);
    float s = 1.0 + (u_scale - 1.0) * t;
    float a = u_rot * t;
    vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * (p / s) - u_trans * t;
    acc += cmpBilinear(u_src, q + c, 0, 0);
  }
  o0 = acc / float(u_samples + 1);
}`;

registerExec('CompositorNodeDBlur', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const samples = Math.max(1, Math.min(256, Math.round(x.num('Samples', 1))));
  const amount = x.num('Translation Amount'),
    dir = x.num('Translation Direction');
  const diag = Math.hypot(r.domain.w, r.domain.h);
  const t = x.alloc(r.domain);
  x.pass('dblur', DBLUR, t, {
    u_src: r.tex!,
    u_samples: samples,
    u_center: x.vec('Center', 2),
    u_rot: x.num('Rotation'),
    u_scale: Math.max(1e-4, x.num('Scale', 1)),
    u_trans: [Math.cos(dir) * amount * diag, Math.sin(dir) * amount * diag],
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Filter: 3×3 kernels; edge filters return the gradient magnitude

const KERNELS: Record<string, number[]> = {
  Soften: [1, 2, 1, 2, 4, 2, 1, 2, 1].map((v) => v / 16),
  'Box Sharpen': [-1, -1, -1, -1, 9, -1, -1, -1, -1],
  'Diamond Sharpen': [0, -1, 0, -1, 5, -1, 0, -1, 0],
  Laplace: [-1 / 8, -1 / 8, -1 / 8, -1 / 8, 1, -1 / 8, -1 / 8, -1 / 8, -1 / 8],
  Sobel: [1, 2, 1, 0, 0, 0, -1, -2, -1],
  Prewitt: [1, 1, 1, 0, 0, 0, -1, -1, -1],
  Kirsch: [5, 5, 5, -3, -3, -3, -2, -2, -2],
  Shadow: [1, 2, 1, 0, 1, 0, -1, -2, -1],
};
const EDGE = new Set(['Laplace', 'Sobel', 'Prewitt', 'Kirsch']);

const FILTER = `
uniform sampler2D u_src;
uniform sampler2D u_fac;
uniform float u_k[9];
uniform int u_edge;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec4 gx = vec4(0.0), gy = vec4(0.0);
  for (int j = 0; j < 3; j++)
    for (int i = 0; i < 3; i++) {
      vec4 s = cmpFetch(u_src, p + ivec2(i - 1, j - 1), 1, 1);
      gx += u_k[j * 3 + i] * s;
      gy += u_k[i * 3 + j] * s;
    }
  vec4 r = u_edge == 1 ? vec4(sqrt(gx.rgb * gx.rgb + gy.rgb * gy.rgb), c.a) : vec4(max(gx.rgb, vec3(0.0)), c.a);
  o0 = mix(c, r, cmpPx(u_fac).r);
}`;

registerExec('CompositorNodeFilter', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const type = menuValue(x.node, 'Type') || 'Soften';
  const t = x.alloc(r.domain);
  const fac = x.input('Fac');
  x.pass('filter', FILTER, t, {
    u_src: r.tex!,
    u_fac: fac.domain ? x.ev.realize(fac, r.domain) : x.ev.tex(fac),
    u_k: new Float32Array(KERNELS[type] ?? KERNELS.Soften),
    u_edge: EDGE.has(type) ? 1 : 0,
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Dilate/Erode

const MINMAX_1D = `
uniform sampler2D u_src;
uniform ivec2 u_dir;
uniform int u_r;
uniform int u_max;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = u_max == 1 ? -3.4e38 : 3.4e38;
  for (int i = -u_r; i <= u_r; i++) {
    float s = cmpFetch(u_src, p + u_dir * i, 1, 1).r;
    v = u_max == 1 ? max(v, s) : min(v, s);
  }
  o0 = vec4(vec3(v), 1.0);
}`;

const DISTANCE = `
uniform sampler2D u_src;
uniform int u_r;
uniform int u_max;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = u_max == 1 ? -3.4e38 : 3.4e38;
  float rr = float(u_r * u_r);
  for (int j = -u_r; j <= u_r; j++)
    for (int i = -u_r; i <= u_r; i++) {
      if (float(i * i + j * j) > rr) continue;
      float s = cmpFetch(u_src, p + ivec2(i, j), 1, 1).r;
      v = u_max == 1 ? max(v, s) : min(v, s);
    }
  o0 = vec4(vec3(v), 1.0);
}`;

// threshold: anti-aliased distance to the mask edge (inside/outside at 0.5)
const THRESHOLD = `
uniform sampler2D u_src;
uniform int u_r;
uniform float u_size;
uniform float u_falloff;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool dilate = u_size > 0.0;
  bool me = texelFetch(u_src, p, 0).r > 0.5;
  float best = 1e9;
  for (int j = -u_r; j <= u_r; j++)
    for (int i = -u_r; i <= u_r; i++) {
      bool s = cmpFetch(u_src, p + ivec2(i, j), 1, 1).r > 0.5;
      if (s != me) best = min(best, length(vec2(i, j)));
    }
  float size = abs(u_size);
  float v;
  if (dilate) v = me ? 1.0 : clamp((size - best) / max(u_falloff, 1e-6), 0.0, 1.0);
  else v = me ? 1.0 - clamp((size - best) / max(u_falloff, 1e-6), 0.0, 1.0) : 0.0;
  if (dilate && !me && best > size) v = 0.0;
  o0 = vec4(vec3(v), 1.0);
}`;

// feather: separable maximum with falloff weights
const FEATHER = `
uniform sampler2D u_src;
uniform sampler2D u_w;
uniform ivec2 u_dir;
uniform int u_invert;
layout(location = 0) out vec4 o0;
void main() {
  int n = textureSize(u_w, 0).x;
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = 0.0;
  for (int i = -(n - 1); i <= n - 1; i++) {
    float s = cmpFetch(u_src, p + u_dir * i, 1, 1).r;
    if (u_invert == 1) s = 1.0 - s;
    v = max(v, s * texelFetch(u_w, ivec2(abs(i), 0), 0).r);
  }
  if (u_invert == 2) v = 1.0 - v;
  o0 = vec4(vec3(v), 1.0);
}`;

const FALLOFF: Record<string, (t: number) => number> = {
  Smooth: (t) => t * t * (3 - 2 * t),
  Sphere: (t) => Math.sqrt(Math.max(0, 2 * t - t * t)),
  Root: (t) => Math.sqrt(t),
  'Inverse Square': (t) => t * (2 - t),
  Sharp: (t) => t * t,
  Linear: (t) => t,
};

registerExec('CompositorNodeDilateErode', (x) => {
  const r = x.input('Mask');
  if (!r.domain) return x.out('Mask', r);
  const size = Math.round(x.num('Size'));
  if (!size) return x.out('Mask', r);
  const type = menuValue(x.node, 'Type') || 'Steps';
  const d = r.domain;
  const R = Math.min(Math.abs(size), 512);
  const dilate = size > 0;
  let out: Texture;
  if (type === 'Steps') {
    const a = x.alloc(d),
      b = x.alloc(d);
    x.pass('minmax', MINMAX_1D, a, {
      u_src: r.tex!,
      u_dir: [1, 0],
      u_r: R,
      u_max: dilate ? 1 : 0,
    });
    x.pass('minmax', MINMAX_1D, b, {
      u_src: a,
      u_dir: [0, 1],
      u_r: R,
      u_max: dilate ? 1 : 0,
    });
    out = b;
  } else if (type === 'Distance') {
    out = x.alloc(d);
    x.pass('dist', DISTANCE, out, {
      u_src: r.tex!,
      u_r: Math.min(R, 128),
      u_max: dilate ? 1 : 0,
    });
  } else if (type === 'Threshold') {
    out = x.alloc(d);
    const falloff = Math.max(0, x.num('Falloff Size'));
    x.pass('threshold', THRESHOLD, out, {
      u_src: r.tex!,
      u_r: Math.min(R + Math.ceil(falloff) + 1, 128),
      u_size: size,
      u_falloff: falloff,
    });
  } else {
    const fn = FALLOFF[menuValue(x.node, 'Falloff')] ?? FALLOFF.Smooth;
    const w = new Float32Array((R + 1) * 4);
    for (let i = 0; i <= R; i++) w[i * 4] = fn(1 - i / (R + 1));
    const wt = x.ev.alloc(R + 1, 1, 'falloff');
    const gl = x.gpu.gl;
    gl.bindTexture(gl.TEXTURE_2D, wt.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, R + 1, 1, gl.RGBA, gl.FLOAT, w);
    const a = x.alloc(d),
      b = x.alloc(d);
    // erosion feathers the inverted mask
    x.pass('feather', FEATHER, a, {
      u_src: r.tex!,
      u_w: wt,
      u_dir: [1, 0],
      u_invert: dilate ? 0 : 1,
    });
    x.pass('feather', FEATHER, b, {
      u_src: a,
      u_w: wt,
      u_dir: [0, 1],
      u_invert: dilate ? 0 : 2,
    });
    out = b;
  }
  x.out('Mask', Result.image('FLOAT', out, d));
});

// ---------------------------------------------------------------------------
// Despeckle: replace isolated pixels that differ from most of their neighbours by their average

const DESPECKLE = `
uniform sampler2D u_src;
uniform sampler2D u_fac;
uniform float u_ct;
uniform float u_nt;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  vec4 sum = vec4(0.0);
  float wsum = 0.0, diff = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      float w = (i == 0 || j == 0) ? 1.0 : 0.70710678;
      vec4 s = cmpFetch(u_src, p + ivec2(i, j), 1, 1);
      sum += s * w;
      wsum += w;
      vec3 dd = abs(s.rgb - c.rgb);
      if (dd.r + dd.g + dd.b > u_ct) diff += w;
    }
  vec4 avg = sum / wsum;
  vec4 r = diff / wsum >= u_nt ? avg : c;
  o0 = mix(c, r, cmpPx(u_fac).r);
}`;

registerExec('CompositorNodeDespeckle', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const t = x.alloc(r.domain);
  const fac = x.input('Fac');
  x.pass('despeckle', DESPECKLE, t, {
    u_src: r.tex!,
    u_fac: fac.domain ? x.ev.realize(fac, r.domain) : x.ev.tex(fac),
    u_ct: x.num('Color Threshold', 0.5),
    u_nt: x.num('Neighbor Threshold', 0.5),
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Denoise: edge-avoiding À-trous wavelet filter guided by albedo and normal (same scheme as the
// path tracer's denoiser), HDR-compressed colour distances

const ATROUS = `
uniform sampler2D u_src;
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform int u_step;
uniform float u_sigma;
uniform int u_hdr;
uniform int u_guides;
uniform float u_taps[5];
layout(location = 0) out vec4 o0;
vec3 tm(vec3 c) { return u_hdr == 1 ? c / (1.0 + max(cmpLuma(c), 0.0)) : c; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c0 = texelFetch(u_src, p, 0);
  vec3 a0 = cmpFetch(u_albedo, p, 1, 1).rgb, n0 = cmpFetch(u_normal, p, 1, 1).xyz;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++)
    for (int i = -2; i <= 2; i++) {
      ivec2 q = p + ivec2(i, j) * u_step;
      vec4 c = cmpFetch(u_src, q, 1, 1);
      float w = u_taps[i + 2] * u_taps[j + 2];
      vec3 d = tm(c.rgb) - tm(c0.rgb);
      w *= exp(-dot(d, d) / (u_sigma * u_sigma + 1e-6));
      if (u_guides == 1) {
        vec3 da = cmpFetch(u_albedo, q, 1, 1).rgb - a0;
        w *= exp(-dot(da, da) / 0.02);
        vec3 n = cmpFetch(u_normal, q, 1, 1).xyz;
        if (dot(n0, n0) > 0.0 && dot(n, n) > 0.0) w *= pow(max(dot(normalize(n0), normalize(n)), 0.0), 32.0);
      }
      sum += c * w;
      wsum += w;
    }
  o0 = wsum > 0.0 ? sum / wsum : c0;
}`;

registerExec('CompositorNodeDenoise', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const d = r.domain;
  const albedo = x.input('Albedo'),
    normal = x.input('Normal');
  const guides = x.linked('Albedo') || x.linked('Normal');
  const quality = menuValue(x.node, 'Quality');
  const prefilter = menuValue(x.node, 'Prefilter');
  // quality maps to the strength of the wavelet schedule
  const { iterations, colorSigma } = denoiseSchedule(quality === 'Fast' ? 64 : quality === 'Balanced' ? 16 : 8);
  const at = albedo.domain ? x.ev.realize(albedo, d) : x.ev.tex(albedo);
  const nt = normal.domain ? x.ev.realize(normal, d) : x.ev.tex(normal);
  let cur = r.tex!;
  for (let i = 0; i < iterations; i++) {
    const t = x.alloc(d, 'denoise');
    x.pass('atrous', ATROUS, t, {
      u_src: cur,
      u_albedo: at,
      u_normal: nt,
      u_step: 1 << i,
      u_sigma: colorSigma * Math.pow(0.5, i * 0.5) * (prefilter === 'None' ? 1.5 : 1),
      u_hdr: x.bool('HDR') ? 1 : 0,
      u_guides: guides ? 1 : 0,
      u_taps: new Float32Array(ATROUS_TAPS),
    });
    cur = t;
  }
  x.out('Image', Result.image('RGBA', cur, d));
});

// ---------------------------------------------------------------------------
// Anti-Aliasing: luminance edge detection and blending along the edge direction

const ANTIALIAS = `
uniform sampler2D u_src;
uniform float u_threshold;
uniform float u_contrast;
uniform float u_round;
layout(location = 0) out vec4 o0;
float L(ivec2 p) { return cmpLuma(cmpFetch(u_src, p, 1, 1).rgb); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(u_src, p, 0);
  float lc = L(p), ln = L(p + ivec2(0, 1)), ls = L(p - ivec2(0, 1)), le = L(p + ivec2(1, 0)), lw = L(p - ivec2(1, 0));
  float mx = max(lc, max(max(ln, ls), max(le, lw))), mn = min(lc, min(min(ln, ls), min(le, lw)));
  float range = mx - mn;
  if (range < u_threshold * 0.5) { o0 = c; return; }
  float h = abs(ln + ls - 2.0 * lc), v = abs(le + lw - 2.0 * lc);
  bool horiz = h >= v;
  ivec2 o = horiz ? ivec2(0, 1) : ivec2(1, 0);
  float k = clamp(range / max(u_contrast * 0.25, 1e-3), 0.0, 1.0) * (0.25 + 0.25 * u_round);
  vec4 a = cmpFetch(u_src, p + o, 1, 1), b = cmpFetch(u_src, p - o, 1, 1);
  o0 = mix(c, (a + b) * 0.5, k);
}`;

registerExec('CompositorNodeAntiAliasing', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const t = x.alloc(r.domain);
  x.pass('antialias', ANTIALIAS, t, {
    u_src: r.tex!,
    u_threshold: x.num('Threshold', 0.2),
    u_contrast: x.num('Contrast Limit', 2),
    u_round: x.num('Corner Rounding', 0.25),
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Pixelate: blocks of Size × Size pixels take the colour of the block average

const PIXELATE = `
uniform sampler2D u_src;
uniform int u_size;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 s = textureSize(u_src, 0);
  ivec2 b = (ivec2(gl_FragCoord.xy) / u_size) * u_size;
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int j = 0; j < u_size; j++)
    for (int i = 0; i < u_size; i++) {
      ivec2 q = b + ivec2(i, j);
      if (q.x >= s.x || q.y >= s.y) continue;
      acc += texelFetch(u_src, q, 0);
      n += 1.0;
    }
  o0 = acc / max(n, 1.0);
}`;

registerExec('CompositorNodePixelate', (x) => {
  const r = x.input('Color');
  if (!r.domain) return x.out('Color', r);
  const size = Math.max(1, Math.min(256, Math.round(x.num('Size', 1))));
  if (size === 1) return x.out('Color', r);
  const t = x.alloc(r.domain);
  x.pass('pixelate', PIXELATE, t, { u_src: r.tex!, u_size: size });
  x.out('Color', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Kuwahara: classic (4 quadrants) and anisotropic (8 smooth sectors, generalized)

const KUWAHARA = `
uniform sampler2D u_src;
uniform int u_r;
uniform int u_sectors;
uniform float u_sharp;
layout(location = 0) out vec4 o0;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 best = texelFetch(u_src, p, 0);
  if (u_sectors == 4) {
    float bestVar = 3.4e38;
    for (int k = 0; k < 4; k++) {
      ivec2 sgn = ivec2(k % 2 == 0 ? -1 : 1, k < 2 ? -1 : 1);
      vec4 m = vec4(0.0); vec3 m2 = vec3(0.0); float n = 0.0;
      for (int j = 0; j <= u_r; j++)
        for (int i = 0; i <= u_r; i++) {
          vec4 c = cmpFetch(u_src, p + sgn * ivec2(i, j), 1, 1);
          m += c; m2 += c.rgb * c.rgb; n += 1.0;
        }
      m /= n;
      vec3 v = m2 / n - m.rgb * m.rgb;
      float var = v.r + v.g + v.b;
      if (var < bestVar) { bestVar = var; best = m; }
    }
    o0 = best;
    return;
  }
  // generalized: 8 overlapping sectors weighted by inverse variance
  vec4 sum = vec4(0.0); float wsum = 0.0;
  for (int k = 0; k < 8; k++) {
    float a0 = float(k) * 0.785398;
    vec4 m = vec4(0.0); vec3 m2 = vec3(0.0); float n = 0.0;
    for (int j = -u_r; j <= u_r; j++)
      for (int i = -u_r; i <= u_r; i++) {
        vec2 o = vec2(i, j);
        float d = length(o);
        if (d > float(u_r)) continue;
        float a = atan(o.y, o.x) - a0;
        a = mod(a + 3.14159265, 6.2831853) - 3.14159265;
        if (d > 0.0 && abs(a) > 0.5) continue;
        vec4 c = cmpFetch(u_src, p + ivec2(i, j), 1, 1);
        m += c; m2 += c.rgb * c.rgb; n += 1.0;
      }
    m /= max(n, 1.0);
    vec3 v = m2 / max(n, 1.0) - m.rgb * m.rgb;
    float w = 1.0 / (1.0 + pow(max(v.r + v.g + v.b, 0.0) * 255.0, 1.0 + 7.0 * u_sharp));
    sum += m * w; wsum += w;
  }
  o0 = sum / wsum;
}`;

registerExec('CompositorNodeKuwahara', (x) => {
  const r = x.input('Image');
  if (!r.domain) return x.out('Image', r);
  const radius = Math.max(0, Math.min(64, Math.round(x.num('Size', 6))));
  if (!radius) return x.out('Image', r);
  const classic = menuValue(x.node, 'Type') === 'Classic';
  const t = x.alloc(r.domain);
  x.pass('kuwahara', KUWAHARA, t, {
    u_src: r.tex!,
    u_r: radius,
    u_sectors: classic ? 4 : 8,
    u_sharp: x.num('Sharpness', 1),
  });
  x.out('Image', Result.image('RGBA', t, r.domain));
});

// ---------------------------------------------------------------------------
// Depth Combine with anti-aliased transitions

const ZMASK = `
uniform sampler2D u_za;
uniform sampler2D u_zb;
layout(location = 0) out vec4 o0;
void main() { float m = cmpPx(u_za).r < cmpPx(u_zb).r ? 1.0 : 0.0; o0 = vec4(vec3(m), 1.0); }`;

const ZMIX = `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_m;
uniform sampler2D u_za;
uniform sampler2D u_zb;
uniform int u_alpha;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec4 a = cmpPx(u_a), b = cmpPx(u_b);
  float m = cmpPx(u_m).r;
  vec4 front = mix(b, a, m), back = mix(a, b, m);
  o0 = u_alpha == 1 ? vec4(mix(back.rgb, front.rgb, front.a), max(front.a, back.a)) : front;
  float z = min(cmpPx(u_za).r, cmpPx(u_zb).r);
  o1 = vec4(vec3(z), 1.0);
}`;

registerExec('CompositorNodeZcombine', (x) => {
  const d = x.domain(['A', 'B', 'Depth A', 'Depth B']);
  if (!d || !x.bool('Anti-Alias')) return runPixelNode(x, pixelGeneratorFor('CompositorNodeZcombine')!);
  const za = x.realized('Depth A', d),
    zb = x.realized('Depth B', d);
  const m = x.alloc(d, 'zmask');
  x.pass('zmask', ZMASK, m, { u_za: za, u_zb: zb });
  const ms = blurTexture(x, m, 'Tent', 1.5, 1.5, true, 1);
  const out = x.alloc(d),
    depth = x.alloc(d);
  x.pass('zmix', ZMIX, [out, depth], {
    u_a: x.realized('A', d),
    u_b: x.realized('B', d),
    u_m: ms,
    u_za: za,
    u_zb: zb,
    u_alpha: x.bool('Use Alpha') ? 1 : 0,
  });
  x.out('Result', Result.image('RGBA', out, d));
  x.out('Depth', Result.image('FLOAT', depth, d));
});
