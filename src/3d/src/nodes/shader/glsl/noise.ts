// GLSL library: gradient noise (1–4D), fractal variants, Noise / White Noise / Wave / Magic / Gabor
// textures. Mirrors the CPU versions in nodes/cpu/ (noise.ts, textures.ts) operation by operation,
// so materials and geometry nodes give the same values.
import type { GlslLib } from './lib';

const FRACTAL_TYPES = ['float', 'vec2', 'vec3', 'vec4'];

export const NOISE: GlslLib = {
  nd_perlin: {
    deps: ['nd_hash'],
    code: `
float nd_fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float nd_g1(uint h, float x) { float g = float(h & 7u) + 1.0; return ((h & 8u) == 0u ? g : -g) * x; }
float nd_g2(uint h, vec2 p) { uint k = h & 7u; float u = k < 4u ? p.x : p.y, v = 2.0 * (k < 4u ? p.y : p.x); return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v); }
float nd_g3(uint h, vec3 p) { uint k = h & 15u; float u = k < 8u ? p.x : p.y; float v = k < 4u ? p.y : ((k == 12u || k == 14u) ? p.x : p.z); return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v); }
float nd_g4(uint h, vec4 p) { uint k = h & 31u; float u = k < 24u ? p.x : p.y, v = k < 16u ? p.y : p.z, w = k < 8u ? p.z : p.w; return ((k & 1u) == 0u ? u : -u) + ((k & 2u) == 0u ? v : -v) + ((k & 4u) == 0u ? w : -w); }
// very large coordinates lose precision: wrap them first
float nd_nwrap(float p) { return abs(p) >= 1000000.0 ? mod(p, 100000.0) + 0.5 : p; }
float nd_snoise(float p) {
  p = nd_nwrap(p);
  float i = floor(p), f = p - i; int x = int(i);
  float a = nd_g1(nd_hash_u(uint(x)), f), b = nd_g1(nd_hash_u(uint(x + 1)), f - 1.0);
  return 0.25 * mix(a, b, nd_fade(f));
}
float nd_snoise(vec2 p) {
  p = vec2(nd_nwrap(p.x), nd_nwrap(p.y));
  vec2 i = floor(p), f = p - i; ivec2 c = ivec2(i);
  float a = nd_g2(nd_hash_u(uint(c.x), uint(c.y)), f), b = nd_g2(nd_hash_u(uint(c.x + 1), uint(c.y)), f - vec2(1.0, 0.0));
  float d = nd_g2(nd_hash_u(uint(c.x), uint(c.y + 1)), f - vec2(0.0, 1.0)), e = nd_g2(nd_hash_u(uint(c.x + 1), uint(c.y + 1)), f - vec2(1.0));
  vec2 u = vec2(nd_fade(f.x), nd_fade(f.y));
  return 0.6616 * mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float nd_snoise(vec3 p) {
  p = vec3(nd_nwrap(p.x), nd_nwrap(p.y), nd_nwrap(p.z));
  vec3 i = floor(p), f = p - i; ivec3 c = ivec3(i);
  vec3 u = vec3(nd_fade(f.x), nd_fade(f.y), nd_fade(f.z));
  float n000 = nd_g3(nd_hash_u(uint(c.x), uint(c.y), uint(c.z)), f);
  float n100 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y), uint(c.z)), f - vec3(1, 0, 0));
  float n010 = nd_g3(nd_hash_u(uint(c.x), uint(c.y + 1), uint(c.z)), f - vec3(0, 1, 0));
  float n110 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y + 1), uint(c.z)), f - vec3(1, 1, 0));
  float n001 = nd_g3(nd_hash_u(uint(c.x), uint(c.y), uint(c.z + 1)), f - vec3(0, 0, 1));
  float n101 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y), uint(c.z + 1)), f - vec3(1, 0, 1));
  float n011 = nd_g3(nd_hash_u(uint(c.x), uint(c.y + 1), uint(c.z + 1)), f - vec3(0, 1, 1));
  float n111 = nd_g3(nd_hash_u(uint(c.x + 1), uint(c.y + 1), uint(c.z + 1)), f - vec3(1, 1, 1));
  return 0.982 * mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float nd_snoise(vec4 p) {
  p = vec4(nd_nwrap(p.x), nd_nwrap(p.y), nd_nwrap(p.z), nd_nwrap(p.w));
  vec4 i = floor(p), f = p - i; ivec4 c = ivec4(i);
  vec4 u = vec4(nd_fade(f.x), nd_fade(f.y), nd_fade(f.z), nd_fade(f.w));
  float r[2];
  for (int w = 0; w < 2; w++) {
    float n[8];
    for (int k = 0; k < 8; k++) {
      ivec4 o = ivec4(k & 1, (k >> 1) & 1, (k >> 2) & 1, w);
      n[k] = nd_g4(nd_hash_u(uint(c.x + o.x), uint(c.y + o.y), uint(c.z + o.z), uint(c.w + o.w)), f - vec4(o));
    }
    r[w] = mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y), mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
  }
  return 0.8344 * mix(r[0], r[1], u.w);
}
`,
  },
  nd_fractal: {
    deps: ['nd_perlin'],
    // instantiated per coordinate type
    code: FRACTAL_TYPES.map(
      (T) => `
float nd_fbm(${T} p, float detail, float rough, float lac, bool norm) {
  float fs = 1.0, amp = 1.0, mx = 0.0, sum = 0.0;
  for (int i = 0; i <= 15; i++) { if (float(i) > floor(detail)) break; sum += nd_snoise(fs * p) * amp; mx += amp; amp *= rough; fs *= lac; }
  float rmd = detail - floor(detail);
  if (rmd != 0.0) {
    float sum2 = sum + nd_snoise(fs * p) * amp;
    return norm ? mix(0.5 * sum / mx + 0.5, 0.5 * sum2 / (mx + amp) + 0.5, rmd) : mix(sum, sum2, rmd);
  }
  return norm ? 0.5 * sum / mx + 0.5 : sum;
}
float nd_multifractal(${T} p, float detail, float rough, float lac) {
  float v = 1.0, pwr = 1.0, fs = 1.0;
  for (int i = 0; i <= 15; i++) { if (float(i) > floor(detail)) break; v *= pwr * nd_snoise(fs * p) + 1.0; pwr *= rough; fs *= lac; }
  float rmd = detail - floor(detail); if (rmd != 0.0) v *= rmd * pwr * nd_snoise(fs * p) + 1.0;
  return v;
}
float nd_hetero(${T} p, float detail, float rough, float lac, float offset) {
  float pwr = rough, fs = lac;
  float v = offset + nd_snoise(p);
  for (int i = 1; i <= 15; i++) { if (float(i) > floor(detail)) break; v += (nd_snoise(fs * p) + offset) * pwr * v; pwr *= rough; fs *= lac; }
  float rmd = detail - floor(detail); if (rmd != 0.0) v += rmd * ((nd_snoise(fs * p) + offset) * pwr * v);
  return v;
}
float nd_hybrid(${T} p, float detail, float rough, float lac, float offset, float gain) {
  float pwr = 1.0, v = 0.0, weight = 1.0, fs = 1.0;
  for (int i = 0; i <= 15; i++) {
    if (float(i) > floor(detail) || weight <= 0.001) break;
    weight = min(weight, 1.0);
    float signal = (nd_snoise(fs * p) + offset) * pwr;
    pwr *= rough; v += weight * signal; weight *= gain * signal; fs *= lac;
  }
  float rmd = detail - floor(detail);
  if (rmd != 0.0 && weight > 0.001) { weight = min(weight, 1.0); v += rmd * weight * ((nd_snoise(fs * p) + offset) * pwr); }
  return v;
}
float nd_ridged(${T} p, float detail, float rough, float lac, float offset, float gain) {
  float pwr = rough, fs = 1.0;
  float s = offset - abs(nd_snoise(p)); s *= s; float v = s;
  for (int i = 1; i <= 15; i++) {
    if (float(i) > floor(detail)) break;
    fs *= lac; float w = clamp(s * gain, 0.0, 1.0);
    s = offset - abs(nd_snoise(fs * p)); s *= s; s *= w; v += s * pwr; pwr *= rough;
  }
  return v;
}
float nd_noise_fractal(int type, ${T} p, float detail, float rough, float lac, float offset, float gain, bool norm) {
  detail = clamp(detail, 0.0, 15.0); rough = max(rough, 0.0);
  if (type == 0) return nd_multifractal(p, detail, rough, lac);
  if (type == 1) return nd_ridged(p, detail, rough, lac, offset, gain);
  if (type == 2) return nd_hybrid(p, detail, rough, lac, offset, gain);
  if (type == 3) return nd_fbm(p, detail, rough, lac, norm);
  return nd_hetero(p, detail, rough, lac, offset);
}`,
    ).join('\n'),
  },
  nd_noise_tex: {
    deps: ['nd_fractal'],
    code: `
vec2 nd_off2(float s) { return vec2(nd_offn(s, 0.0), nd_offn(s, 1.0)); }
vec3 nd_off3(float s) { return vec3(nd_offn(s, 0.0), nd_offn(s, 1.0), nd_offn(s, 2.0)); }
vec4 nd_off4(float s) { return vec4(nd_offn(s, 0.0), nd_offn(s, 1.0), nd_offn(s, 2.0), nd_offn(s, 3.0)); }
// returns (fac, r, g, b)
vec4 nd_noise_tex1(float p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += nd_snoise(p + nd_off1(0.0)) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + nd_off1(1.0), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + nd_off1(2.0), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex2(vec2 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec2(nd_snoise(p + nd_off2(0.0)), nd_snoise(p + nd_off2(1.0))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + nd_off2(2.0), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + nd_off2(3.0), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex3(vec3 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec3(nd_snoise(p + nd_off3(0.0)), nd_snoise(p + nd_off3(1.0)), nd_snoise(p + nd_off3(2.0))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + nd_off3(3.0), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + nd_off3(4.0), detail, rough, lac, offset, gain, norm));
}
vec4 nd_noise_tex4(vec4 p, float detail, float rough, float lac, float offset, float gain, float dist, int type, bool norm) {
  if (dist != 0.0) p += vec4(nd_snoise(p + nd_off4(0.0)), nd_snoise(p + nd_off4(1.0)), nd_snoise(p + nd_off4(2.0)), nd_snoise(p + nd_off4(3.0))) * dist;
  float f = nd_noise_fractal(type, p, detail, rough, lac, offset, gain, norm);
  return vec4(f, f, nd_noise_fractal(type, p + nd_off4(4.0), detail, rough, lac, offset, gain, norm), nd_noise_fractal(type, p + nd_off4(5.0), detail, rough, lac, offset, gain, norm));
}
`,
  },
  nd_white_noise: {
    deps: ['nd_hash'],
    code: `
vec4 nd_white1(float p) { return vec4(nd_hash_f(p), nd_hash3_f(p)); }
vec4 nd_white2(vec2 p) { return vec4(nd_hash_f(p), nd_hash3_f(p)); }
vec4 nd_white3(vec3 p) { return vec4(nd_hash_f(p), nd_hash3_f(p)); }
vec4 nd_white4(vec4 p) { return vec4(nd_hash_f(p), nd_hash3_f(p)); }
`,
  },
  nd_wave: {
    deps: ['nd_fractal'],
    code: `
float nd_wave(vec3 p, int type, int bdir, int rdir, int profile, float dist, float detail, float dscale, float drough, float phase) {
  p = (p + 0.000001) * 0.999999;
  float n;
  if (type == 0) {
    if (bdir == 0) n = p.x * 20.0; else if (bdir == 1) n = p.y * 20.0; else if (bdir == 2) n = p.z * 20.0; else n = (p.x + p.y + p.z) * 10.0;
  } else {
    vec3 r = p;
    if (rdir == 0) r.x = 0.0; else if (rdir == 1) r.y = 0.0; else if (rdir == 2) r.z = 0.0;
    n = length(r) * 20.0;
  }
  n += phase;
  if (dist != 0.0) n += dist * (nd_fbm(p * dscale, clamp(detail, 0.0, 15.0), max(drough, 0.0), 2.0, true) * 2.0 - 1.0);
  if (profile == 0) return 0.5 + 0.5 * sin(n - 1.5707963267948966);
  n /= 6.283185307179586;
  if (profile == 1) return n - floor(n);
  return abs(n - floor(n + 0.5)) * 2.0;
}
`,
  },
  nd_magic: {
    code: `
// layered trigonometric turbulence; returns (r, g, b, fac)
vec4 nd_magic(vec3 p, int depth, float d) {
  float x = sin((p.x + p.y + p.z) * 5.0), y = cos((-p.x + p.y - p.z) * 5.0), z = -cos((-p.x - p.y + p.z) * 5.0);
  if (depth > 0) {
    x *= d; y *= d; z *= d;
    y = -cos(x - y + z) * d;
    if (depth > 1) { x = cos(x - y - z) * d;
    if (depth > 2) { z = sin(-x - y - z) * d;
    if (depth > 3) { x = -cos(-x + y - z) * d;
    if (depth > 4) { y = -sin(-x + y + z) * d;
    if (depth > 5) { y = -cos(-x + y + z) * d;
    if (depth > 6) { x = cos(x + y + z) * d;
    if (depth > 7) { z = sin(x + y - z) * d;
    if (depth > 8) { x = -cos(-x - y + z) * d;
    if (depth > 9) { y = -sin(x - y + z) * d; } } } } } } } } }
  }
  if (d != 0.0) { float s = 2.0 * d; x /= s; y /= s; z /= s; }
  vec3 col = vec3(0.5 - x, 0.5 - y, 0.5 - z);
  return vec4(col, (col.r + col.g + col.b) / 3.0);
}
`,
  },
  nd_gabor: {
    deps: ['nd_hash'],
    code: `
// sparse convolution of windowed sinusoid kernels, 8 impulses per cell; returns (value, phase, intensity)
vec2 nd_gabor2(vec2 p, float freq, float iso, float orient) {
  vec2 cell = floor(p), l = p - cell;
  vec2 sum = vec2(0.0);
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = cell + vec2(i, j), q = l - vec2(i, j);
      for (int k = 0; k < 8; k++) {
        float fk = float(k * 3);
        float o = orient + (nd_hash_f(vec3(g, fk)) - 0.5) * 3.141592653589793 * iso;
        vec2 kc = vec2(nd_hash_f(vec3(g, fk + 1.0)), nd_hash_f(vec3(fk + 1.0, g)));
        vec2 r = q - kc;
        float d2 = dot(r, r);
        if (d2 >= 1.0) continue;
        float w = nd_hash_f(vec3(g, fk + 2.0)) < 0.5 ? -1.0 : 1.0;
        float env = exp(-3.141592653589793 * d2) * (0.5 + 0.5 * cos(3.141592653589793 * d2));
        float a = 6.283185307179586 * freq * dot(r, vec2(cos(o), sin(o)));
        sum += w * env * vec2(cos(a), sin(a));
      }
    }
  return sum;
}
vec3 nd_gabor_dir(vec3 o, float iso, vec4 seed) {
  if (iso == 0.0) return o;
  float incl = acos(clamp(o.z, -1.0, 1.0));
  float lxy = length(o.xy);
  float az = sign(o.y) * acos(lxy > 0.0 ? clamp(o.x / lxy, -1.0, 1.0) : 1.0);
  vec2 rnd = (vec2(nd_hash_f(seed), nd_hash_f(seed.zxwy)) * 2.0 - 1.0) * 3.141592653589793;
  incl += rnd.x * iso; az += rnd.y * iso;
  return vec3(sin(incl) * cos(az), sin(incl) * sin(az), cos(incl));
}
vec2 nd_gabor3(vec3 p, float freq, float iso, vec3 orient) {
  vec3 cell = floor(p), l = p - cell;
  vec2 sum = vec2(0.0);
  for (int kk = -1; kk <= 1; kk++)
    for (int j = -1; j <= 1; j++)
      for (int i = -1; i <= 1; i++) {
        vec3 g = cell + vec3(i, j, kk), q = l - vec3(i, j, kk);
        for (int k = 0; k < 8; k++) {
          float fk = float(k * 3);
          vec3 o = nd_gabor_dir(orient, iso, vec4(g, fk));
          vec3 r = q - nd_hash3_f(vec4(g, fk + 1.0));
          float d2 = dot(r, r);
          if (d2 >= 1.0) continue;
          float w = nd_hash_f(vec4(g, fk + 2.0)) < 0.5 ? -1.0 : 1.0;
          float env = exp(-3.141592653589793 * d2) * (0.5 + 0.5 * cos(3.141592653589793 * d2));
          float a = 6.283185307179586 * freq * dot(r, o);
          sum += w * env * vec2(cos(a), sin(a));
        }
      }
  return sum;
}
vec3 nd_gabor(vec3 p, float scale, float freq, float aniso, float orient2, vec3 orient3, bool is3d) {
  float iso = 1.0 - clamp(aniso, 0.0, 1.0);
  freq = max(0.001, freq);
  vec2 ph;
  float sd;
  if (is3d) {
    float l = length(orient3);
    ph = nd_gabor3(p * scale, freq, iso, l > 0.0 ? orient3 / l : vec3(0.0));
    sd = sqrt(8.0 * 0.5 * (1.0 / (4.0 * sqrt(2.0))));
  } else {
    ph = nd_gabor2(p.xy * scale, freq, iso, orient2);
    sd = sqrt(8.0 * 0.5 * 0.25);
  }
  float nrm = 6.0 * sd;
  return vec3(ph.y / nrm * 0.5 + 0.5, (atan(ph.y, ph.x) + 3.141592653589793) / 6.283185307179586, length(ph) / nrm);
}
`,
  },
};
