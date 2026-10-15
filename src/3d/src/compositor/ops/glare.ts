// Glare: highlights extraction (threshold with a soft knee, optional clamp), a glare generator
// (Bloom, Fog Glow, Streaks, Ghosts, Simple Star, Sun Beams) computed at the chosen quality,
// and the adjusted glare (strength, saturation, tint) added to the image.
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, type Domain } from '../eval/result';
import { menuValue } from '../nodes/defs';
import type { Texture } from '../gpu/gpu';
import { blurTexture } from './filter';

const HIGHLIGHTS = `
uniform sampler2D u_src;
uniform float u_threshold;
uniform float u_knee;
uniform int u_clamp;
uniform float u_max;
layout(location = 0) out vec4 o0;
void main() {
  vec4 c = cmpPx(u_src);
  float b = max(c.r, max(c.g, c.b));
  float soft = clamp(b - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-5);
  float contrib = max(soft, b - u_threshold) / max(b, 1e-5);
  vec3 h = c.rgb * max(contrib, 0.0);
  if (u_clamp == 1) { float m = max(h.r, max(h.g, h.b)); if (m > u_max) h *= u_max / m; }
  o0 = vec4(h, 1.0);
}`;

const RESAMPLE = `
uniform sampler2D u_src;
uniform vec2 u_scale;
layout(location = 0) out vec4 o0;
void main() {
  // box-filtered resample (averages the covered source pixels)
  vec2 p = gl_FragCoord.xy * u_scale;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++) acc += cmpBilinear(u_src, p + (vec2(i, j) - 1.5) * u_scale * 0.25, 1, 1);
  o0 = acc / 16.0;
}`;

function resample(x: NodeCtx, src: Texture, w: number, h: number): Texture {
  const t = x.ev.alloc(w, h, 'glare-resample');
  x.pass('glare-resample', RESAMPLE, t, {
    u_src: src,
    u_scale: [src.w / w, src.h / h],
  });
  return t;
}

// 2× box downsample (4 bilinear taps) and tent upsample-add for the bloom chain
const DOWN = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() {
  vec2 p = gl_FragCoord.xy * 2.0;
  o0 = 0.25 * (cmpBilinear(u_src, p + vec2(-0.5, -0.5), 1, 1) + cmpBilinear(u_src, p + vec2(0.5, -0.5), 1, 1) + cmpBilinear(u_src, p + vec2(-0.5, 0.5), 1, 1) + cmpBilinear(u_src, p + vec2(0.5, 0.5), 1, 1));
}`;
const UP = `
uniform sampler2D u_small;
uniform sampler2D u_big;
layout(location = 0) out vec4 o0;
void main() {
  vec2 s = vec2(textureSize(u_small, 0));
  vec2 b = vec2(textureSize(u_big, 0));
  vec2 p = gl_FragCoord.xy * s / b;
  vec4 acc = vec4(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) acc += cmpBilinear(u_small, p + vec2(i, j), 1, 1) * float((2 - abs(i)) * (2 - abs(j)));
  o0 = texelFetch(u_big, ivec2(gl_FragCoord.xy), 0) + acc / 16.0;
}`;

function bloom(x: NodeCtx, h: Texture, size: number): Texture {
  const levels = Math.max(1, Math.min(16, Math.round(size * Math.log2(Math.max(2, Math.min(h.w, h.h))) * 1.2)));
  const chain: Texture[] = [h];
  for (let i = 0; i < levels; i++) {
    const p = chain[chain.length - 1];
    if (p.w < 2 && p.h < 2) break;
    const t = x.ev.alloc(Math.max(1, Math.ceil(p.w / 2)), Math.max(1, Math.ceil(p.h / 2)), 'bloom-down');
    x.pass('bloom-down', DOWN, t, { u_src: p });
    chain.push(t);
  }
  let cur = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) {
    const t = x.ev.alloc(chain[i].w, chain[i].h, 'bloom-up');
    x.pass('bloom-up', UP, t, { u_small: cur, u_big: chain[i] });
    cur = t;
  }
  // normalize: each level adds the energy of the highlights once; keep part of the sharp core
  const spread = x.ev.alloc(h.w, h.h, 'bloom');
  x.pass('scale', SCALE, spread, { u_src: cur, u_k: 0.75 / chain.length });
  const out = x.ev.alloc(h.w, h.h, 'bloom');
  x.pass('mixadd', MIXADD, out, { u_a: spread, u_b: h, u_k: 0.25 });
  return out;
}

const SCALE = `
uniform sampler2D u_src;
uniform float u_k;
layout(location = 0) out vec4 o0;
void main() { o0 = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0) * u_k; }`;

// fog glow: a long-tailed kernel built from Gaussians at doubling radii with decaying weights
function fogGlow(x: NodeCtx, h: Texture, size: number): Texture {
  const maxR = size * Math.max(h.w, h.h) * 0.02;
  let acc = x.ev.alloc(h.w, h.h, 'fog');
  x.pass('scale', SCALE, acc, { u_src: h, u_k: 1 });
  let total = 1;
  for (let r = 1, w = 0.5; r <= maxR; r *= 2, w *= 0.5) {
    const b = blurTexture(x, h, 'Gaussian', r * 3, r * 3, true, 0);
    const n = x.ev.alloc(h.w, h.h, 'fog');
    x.pass('mixadd', MIXADD, n, { u_a: acc, u_b: b, u_k: w });
    acc = n;
    total += w;
  }
  const out = x.ev.alloc(h.w, h.h, 'fog');
  x.pass('scale', SCALE, out, { u_src: acc, u_k: 1 / total });
  return out;
}

const MIXADD = `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_k;
layout(location = 0) out vec4 o0;
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o0 = texelFetch(u_a, p, 0) + texelFetch(u_b, p, 0) * u_k; }`;

// streak iteration: accumulate 4 taps spaced by 4^n along a direction with fade and colour shift
const STREAK = `
uniform sampler2D u_src;
uniform vec2 u_dir;
uniform float u_spacing;
uniform float u_fade;
uniform float u_cmod;
uniform int u_iter;
layout(location = 0) out vec4 o0;
void main() {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    float w = pow(u_fade, u_spacing * float(k));
    vec4 s = cmpBilinear(u_src, gl_FragCoord.xy - u_dir * u_spacing * float(k), 0, 0);
    // colour modulation: shift the tint per tap like a dispersive lens
    float m = u_cmod * float(k) * 0.33 * float(u_iter + 1) * 0.5;
    vec3 tint = vec3(1.0 - m * 0.5, 1.0, 1.0 + m * 0.5) / (1.0 + m * 0.0);
    acc += vec4(s.rgb * tint, s.a) * w;
    wsum += w;
  }
  o0 = acc / wsum;
}`;

function streaks(x: NodeCtx, h: Texture, dirs: [number, number][], iterations: number, fade: number, cmod: number, gain: number): Texture {
  let total: Texture | null = null;
  for (const d of dirs) {
    let cur = h;
    for (let n = 0; n < iterations; n++) {
      const t = x.ev.alloc(h.w, h.h, 'streak');
      x.pass('streak', STREAK, t, {
        u_src: cur,
        u_dir: d,
        u_spacing: Math.pow(4, n),
        u_fade: fade,
        u_cmod: cmod,
        u_iter: n,
      });
      cur = t;
    }
    const n2 = x.ev.alloc(h.w, h.h, 'streaks');
    if (total) x.pass('mixadd', MIXADD, n2, { u_a: total, u_b: cur, u_k: 1 });
    else x.pass('scale', SCALE, n2, { u_src: cur, u_k: 1 });
    total = n2;
  }
  // a streak spreads the energy of each highlight along its length (scaled to match the other glare types)
  const out = x.ev.alloc(h.w, h.h, 'streaks');
  x.pass('scale', SCALE, out, {
    u_src: total!,
    u_k: gain / Math.max(1, dirs.length),
  });
  return out;
}

// ghosts: blurred highlights mirrored through the centre at several scales with tints
const GHOSTS = `
uniform sampler2D u_src;
uniform float u_cmod;
layout(location = 0) out vec4 o0;
void main() {
  vec2 s = vec2(textureSize(u_src, 0));
  vec2 c = s * 0.5;
  vec2 p = gl_FragCoord.xy - c;
  const float scales[6] = float[6](-4.0, -2.1, -1.1, -0.6, 2.2, 3.5);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 6; i++) {
    vec3 tint = mix(vec3(1.0), vec3(i % 3 == 0 ? 1.0 : 0.5, i % 3 == 1 ? 1.0 : 0.5, i % 3 == 2 ? 1.0 : 0.5), u_cmod);
    vec4 g = cmpBilinear(u_src, c + p / scales[i], 0, 0);
    acc += vec4(g.rgb * tint, 0.0) * 0.04;
  }
  o0 = vec4(acc.rgb, 1.0);
}`;

const SUNBEAMS = `
uniform sampler2D u_src;
uniform vec2 u_sun;
uniform float u_len;
uniform float u_jitter;
layout(location = 0) out vec4 o0;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 s = vec2(textureSize(u_src, 0));
  vec2 p = gl_FragCoord.xy;
  vec2 sun = u_sun * s;
  vec2 d = sun - p;
  float n = clamp(ceil(length(d) * u_len), 1.0, 256.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  float j = u_jitter * hash(p);
  for (int i = 0; i < 256; i++) {
    if (float(i) >= n) break;
    float t = (float(i) + j) / n * u_len;
    float w = 1.0 - t / max(u_len, 1e-6);
    acc += cmpBilinear(u_src, p + d * t, 0, 0) * w;
    wsum += w;
  }
  o0 = vec4((acc / max(wsum, 1e-6)).rgb * u_len * 1.75, 1.0);
}`;

const COMBINE = `
uniform sampler2D u_src;
uniform sampler2D u_glare;
uniform float u_strength;
uniform float u_sat;
uniform vec3 u_tint;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec4 c = cmpPx(u_src);
  vec2 s = vec2(textureSize(u_glare, 0));
  vec2 q = gl_FragCoord.xy / vec2(textureSize(u_src, 0)) * s;
  vec3 g = cmpBilinear(u_glare, q, 1, 1).rgb;
  float l = cmpLuma(g);
  g = mix(vec3(l), g, u_sat) * u_tint * u_strength;
  o0 = vec4(c.rgb + g, c.a);
  o1 = vec4(g, 1.0);
}`;

registerExec('CompositorNodeGlare', (x) => {
  const r = x.input('Image');
  if (!r.domain) {
    x.out('Image', r);
    return;
  }
  const d: Domain = r.domain;
  const type = menuValue(x.node, 'Type') || 'Streaks';
  const quality = menuValue(x.node, 'Quality') || 'Medium';
  const div = quality === 'High' ? 1 : quality === 'Medium' ? 2 : 4;
  const threshold = Math.max(0, x.num('Highlights Threshold', 1));
  const knee = Math.max(1e-4, threshold * Math.min(1, Math.max(0, x.num('Highlights Smoothness', 0.1))));
  // highlights at full resolution (an output), then at the processing resolution
  const hFull = x.alloc(d, 'highlights');
  x.pass('glare-highlights', HIGHLIGHTS, hFull, {
    u_src: r.tex!,
    u_threshold: threshold,
    u_knee: knee,
    u_clamp: x.bool('Clamp Highlights') ? 1 : 0,
    u_max: Math.max(0, x.num('Maximum Highlights', 10)),
  });
  const w = Math.max(1, Math.round(d.w / div)),
    hh = Math.max(1, Math.round(d.h / div));
  const h = div === 1 ? hFull : resample(x, hFull, w, hh);
  const size = Math.min(1, Math.max(0, x.num('Size', 0.5)));
  let glare: Texture;
  switch (type) {
    case 'Bloom':
      glare = bloom(x, h, size);
      break;
    case 'Fog Glow':
      glare = fogGlow(x, h, size);
      break;
    case 'Ghosts': {
      const b = blurTexture(x, h, 'Gaussian', Math.max(2, h.w * 0.02), Math.max(2, h.w * 0.02), true, 0);
      glare = x.ev.alloc(h.w, h.h, 'ghosts');
      x.pass('ghosts', GHOSTS, glare, {
        u_src: b,
        u_cmod: Math.min(1, Math.max(0, x.num('Color Modulation', 0.25))),
      });
      break;
    }
    case 'Sun Beams': {
      glare = x.ev.alloc(h.w, h.h, 'sunbeams');
      x.pass('sunbeams', SUNBEAMS, glare, {
        u_src: h,
        u_sun: x.vec('Sun Position', 2),
        u_len: size,
        u_jitter: Math.min(1, Math.max(0, x.num('Jitter'))),
      });
      break;
    }
    case 'Simple Star': {
      const diag = x.bool('Diagonal Star');
      const dirs: [number, number][] = diag
        ? [
            [1, 1],
            [-1, -1],
            [1, -1],
            [-1, 1],
          ]
        : [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
      glare = streaks(x, h, dirs, Math.max(2, Math.min(5, Math.round(x.num('Iterations', 3)))), Math.min(1, Math.max(0.75, x.num('Fade', 0.9))), 0, 2.6);
      break;
    }
    default: {
      const n = Math.max(1, Math.min(16, Math.round(x.num('Streaks', 4))));
      const a0 = x.num('Streaks Angle');
      const dirs: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i * 2 * Math.PI) / n;
        dirs.push([Math.cos(a), Math.sin(a)]);
      }
      glare = streaks(
        x,
        h,
        dirs,
        Math.max(2, Math.min(5, Math.round(x.num('Iterations', 3)))),
        Math.min(1, Math.max(0.75, x.num('Fade', 0.9))),
        Math.min(1, Math.max(0, x.num('Color Modulation', 0.25))),
        1.7,
      );
    }
  }
  const tint = x.vec('Tint', 3);
  const img = x.alloc(d),
    gout = x.alloc(d);
  x.pass('glare-combine', COMBINE, [img, gout], {
    u_src: r.tex!,
    u_glare: glare,
    u_strength: Math.max(0, x.num('Strength', 1)),
    u_sat: Math.max(0, x.num('Saturation', 1)),
    u_tint: tint,
  });
  x.out('Image', Result.image('RGBA', img, d));
  x.out('Glare', Result.image('RGBA', gout, d));
  x.out('Highlights', Result.image('RGBA', hFull, d));
});
