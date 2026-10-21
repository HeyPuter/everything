// GLSL library: hashing, math helpers, colour conversion, closures. Independent implementations.
import type { GlslLib } from './lib';

export const COMMON: GlslLib = {
  nd_hash: {
    // lookup3 integer mixing of lattice coordinates / float bit patterns (matches nodes/cpu/hash.ts)
    code: `
uint nd_rot(uint x, uint k) { return (x << k) | (x >> (32u - k)); }
uint nd_final(uint a, uint b, uint c) {
  c ^= b; c -= nd_rot(b, 14u); a ^= c; a -= nd_rot(c, 11u); b ^= a; b -= nd_rot(a, 25u);
  c ^= b; c -= nd_rot(b, 16u); a ^= c; a -= nd_rot(c, 4u); b ^= a; b -= nd_rot(a, 14u);
  c ^= b; c -= nd_rot(b, 24u);
  return c;
}
uint nd_hash_u(uint a) { uint s = 0xdeadbeefu + 17u; return nd_final(s + a, s, s); }
uint nd_hash_u(uint a, uint b) { uint s = 0xdeadbeefu + 21u; return nd_final(s + a, s + b, s); }
uint nd_hash_u(uint a, uint b, uint c) { uint s = 0xdeadbeefu + 25u; return nd_final(s + a, s + b, s + c); }
uint nd_hash_u(uint x, uint y, uint z, uint w) {
  uint s = 0xdeadbeefu + 29u;
  uint a = s + x, b = s + y, c = s + z;
  a -= c; a ^= nd_rot(c, 4u); c += b;
  b -= a; b ^= nd_rot(a, 6u); a += c;
  c -= b; c ^= nd_rot(b, 8u); b += a;
  a -= c; a ^= nd_rot(c, 16u); c += b;
  b -= a; b ^= nd_rot(a, 19u); a += c;
  c -= b; c ^= nd_rot(b, 4u); b += a;
  return nd_final(a + w, b, c);
}
float nd_u2f(uint h) { return float(h) / 4294967295.0; }
float nd_hash_i(int a) { return nd_u2f(nd_hash_u(uint(a))); }
float nd_hash_i(ivec2 p) { return nd_u2f(nd_hash_u(uint(p.x), uint(p.y))); }
float nd_hash_i(ivec3 p) { return nd_u2f(nd_hash_u(uint(p.x), uint(p.y), uint(p.z))); }
float nd_hash_i(ivec4 p) { return nd_u2f(nd_hash_u(uint(p.x), uint(p.y), uint(p.z), uint(p.w))); }
float nd_hash_f(float x) { return nd_u2f(nd_hash_u(floatBitsToUint(x))); }
float nd_hash_f(vec2 p) { return nd_u2f(nd_hash_u(floatBitsToUint(p.x), floatBitsToUint(p.y))); }
float nd_hash_f(vec3 p) { return nd_u2f(nd_hash_u(floatBitsToUint(p.x), floatBitsToUint(p.y), floatBitsToUint(p.z))); }
float nd_hash_f(vec4 p) { return nd_u2f(nd_hash_u(floatBitsToUint(p.x), floatBitsToUint(p.y), floatBitsToUint(p.z), floatBitsToUint(p.w))); }
vec3 nd_hash3_f(float a) { return vec3(nd_hash_f(a), nd_hash_f(vec2(a, 1.0)), nd_hash_f(vec2(a, 2.0))); }
vec3 nd_hash3_f(vec2 p) { return vec3(nd_hash_f(p), nd_hash_f(vec3(p, 1.0)), nd_hash_f(vec3(p, 2.0))); }
vec3 nd_hash3_f(vec3 p) { return vec3(nd_hash_f(p), nd_hash_f(vec4(p, 1.0)), nd_hash_f(vec4(p, 2.0))); }
vec3 nd_hash3_f(vec4 p) { return vec3(nd_hash_f(p), nd_hash_f(p.zxwy), nd_hash_f(p.wzyx)); }
// legacy helpers kept for other chunks
vec3 nd_hash3_i(ivec2 p) { return nd_hash3_f(vec2(p)); }
vec3 nd_hash3_i(ivec3 p) { return nd_hash3_f(vec3(p)); }
vec4 nd_hash4_i(ivec4 p) { vec4 q = vec4(p); return vec4(nd_hash_f(q), nd_hash_f(q.zxwy), nd_hash_f(q.wzyx), nd_hash_f(q.yxzw)); }
// offsets in [100, 200) that decorrelate noise channels
float nd_off1(float seed) { return 100.0 + nd_hash_f(seed) * 100.0; }
float nd_offn(float seed, float i) { return 100.0 + nd_hash_f(vec2(seed, i)) * 100.0; }
// signed-integer PCG hashes of cells (cellular textures)
uint nd_ash16(uint v) { return v ^ uint(int(v) >> 16); }
vec2 nd_pcg2(ivec2 c) {
  uvec2 v = uvec2(c) * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v.x = nd_ash16(v.x); v.y = nd_ash16(v.y);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  return vec2(v & 0x7fffffffu) / 2147483647.0;
}
vec3 nd_pcg3(ivec3 c) {
  uvec3 v = uvec3(c) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v.x = nd_ash16(v.x); v.y = nd_ash16(v.y); v.z = nd_ash16(v.z);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3(v & 0x7fffffffu) / 2147483647.0;
}
vec4 nd_pcg4(ivec4 c) {
  uvec4 v = uvec4(c) * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v.x = nd_ash16(v.x); v.y = nd_ash16(v.y); v.z = nd_ash16(v.z); v.w = nd_ash16(v.w);
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return vec4(v & 0x7fffffffu) / 2147483647.0;
}
`,
  },
  nd_math: {
    code: `
float nd_safe_div(float a, float b) { return b != 0.0 ? a / b : 0.0; }
vec3 nd_safe_div(vec3 a, vec3 b) { return vec3(nd_safe_div(a.x, b.x), nd_safe_div(a.y, b.y), nd_safe_div(a.z, b.z)); }
float nd_safe_pow(float a, float b) { if (a < 0.0 && b != floor(b)) return 0.0; return a == 0.0 && b <= 0.0 ? 0.0 : (a < 0.0 ? (mod(b, 2.0) == 0.0 ? pow(-a, b) : -pow(-a, b)) : pow(a, b)); }
vec3 nd_safe_pow(vec3 a, vec3 b) { return vec3(nd_safe_pow(a.x, b.x), nd_safe_pow(a.y, b.y), nd_safe_pow(a.z, b.z)); }
float nd_safe_log(float a, float b) { return (a > 0.0 && b > 0.0 && b != 1.0) ? log(a) / log(b) : 0.0; }
float nd_safe_sqrt(float a) { return a > 0.0 ? sqrt(a) : 0.0; }
float nd_safe_isqrt(float a) { return a > 0.0 ? inversesqrt(a) : 0.0; }
float nd_fmod(float a, float b) { return b != 0.0 ? a - b * trunc(a / b) : 0.0; }
vec3 nd_fmod(vec3 a, vec3 b) { return vec3(nd_fmod(a.x, b.x), nd_fmod(a.y, b.y), nd_fmod(a.z, b.z)); }
float nd_floored_mod(float a, float b) { return b != 0.0 ? a - b * floor(a / b) : 0.0; }
float nd_wrap(float v, float mx, float mn) { float r = mx - mn; return r != 0.0 ? v - r * floor((v - mn) / r) : mn; }
vec3 nd_wrap(vec3 v, vec3 mx, vec3 mn) { return vec3(nd_wrap(v.x, mx.x, mn.x), nd_wrap(v.y, mx.y, mn.y), nd_wrap(v.z, mx.z, mn.z)); }
float nd_snap(float a, float b) { return b != 0.0 ? floor(a / b) * b : 0.0; }
vec3 nd_snap(vec3 a, vec3 b) { return vec3(nd_snap(a.x, b.x), nd_snap(a.y, b.y), nd_snap(a.z, b.z)); }
float nd_pingpong(float a, float b) { return b != 0.0 ? abs(fract((a - b) / (b * 2.0)) * b * 2.0 - b) : 0.0; }
float nd_smoothmin(float a, float b, float k) { if (k <= 0.0) return min(a, b); float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * h * k * (1.0 / 6.0); }
float nd_compare(float a, float b, float eps) { return abs(a - b) <= max(eps, 1e-5) ? 1.0 : 0.0; }
float nd_round(float a) { return floor(a + 0.5); }
vec3 nd_safe_normalize(vec3 v) { float l = length(v); return l > 0.0 ? v / l : vec3(0.0); }
vec3 nd_project(vec3 a, vec3 b) { float d = dot(b, b); return d > 0.0 ? b * (dot(a, b) / d) : vec3(0.0); }
float nd_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float nd_smootherstep(float e0, float e1, float x) { float t = clamp(nd_safe_div(x - e0, e1 - e0), 0.0, 1.0); return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
mat3 nd_euler_xyz(vec3 r) {
  float cx = cos(r.x), sx = sin(r.x), cy = cos(r.y), sy = sin(r.y), cz = cos(r.z), sz = sin(r.z);
  mat3 X = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  mat3 Y = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 Z = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  return Z * Y * X;
}
vec3 nd_axis_angle(vec3 v, vec3 axis, float ang) {
  vec3 a = nd_safe_normalize(axis);
  float c = cos(ang), s = sin(ang);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}
`,
  },
  nd_color: {
    deps: ['nd_math'],
    code: `
vec3 nd_rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  float h = 0.0;
  if (d > 0.0) {
    if (mx == c.r) h = mod((c.g - c.b) / d + 6.0, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, mx > 0.0 ? d / mx : 0.0, mx);
}
vec3 nd_hsv2rgb(vec3 c) {
  float h = fract(c.x) * 6.0, s = c.y, v = c.z;
  float f = fract(h); int i = int(floor(h));
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (i == 0) return vec3(v, t, p);
  if (i == 1) return vec3(q, v, p);
  if (i == 2) return vec3(p, v, t);
  if (i == 3) return vec3(p, q, v);
  if (i == 4) return vec3(t, p, v);
  return vec3(v, p, q);
}
vec3 nd_rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, d = mx - mn, h = 0.0, s = 0.0;
  if (d > 0.0) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = mod((c.g - c.b) / d + 6.0, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float nd_hue2c(float p, float q, float t) {
  t = fract(t);
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 nd_hsl2rgb(vec3 c) {
  if (c.y == 0.0) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y, p = 2.0 * c.z - q;
  return vec3(nd_hue2c(p, q, c.x + 1.0 / 3.0), nd_hue2c(p, q, c.x), nd_hue2c(p, q, c.x - 1.0 / 3.0));
}
`,
  },
  nd_mix_blend: {
    deps: ['nd_color'],
    code: `
vec3 nd_blend(int mode, float f, vec3 a, vec3 b) {
  vec3 r = a;
  if (mode == 0) r = mix(a, b, f);
  else if (mode == 1) r = mix(a, min(a, b), f);
  else if (mode == 2) r = mix(a, a * b, f);
  else if (mode == 3) { vec3 t = vec3(1.0 - f) + f * b; r = vec3(t.r <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - a.r) / t.r, 0.0, 1.0), t.g <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - a.g) / t.g, 0.0, 1.0), t.b <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - a.b) / t.b, 0.0, 1.0)); }
  else if (mode == 4) r = mix(a, max(a, b), f);
  else if (mode == 5) r = mix(a, vec3(1.0) - (vec3(1.0) - a) * (vec3(1.0) - b), f);
  else if (mode == 6) { vec3 t = vec3(1.0) - f * b; r = vec3(a.r == 0.0 ? 0.0 : (t.r <= 0.0 ? 1.0 : min(a.r / t.r, 1.0)), a.g == 0.0 ? 0.0 : (t.g <= 0.0 ? 1.0 : min(a.g / t.g, 1.0)), a.b == 0.0 ? 0.0 : (t.b <= 0.0 ? 1.0 : min(a.b / t.b, 1.0))); }
  else if (mode == 7) r = a + f * b;
  else if (mode == 8) { vec3 t = mix(2.0 * a * b, vec3(1.0) - 2.0 * (vec3(1.0) - a) * (vec3(1.0) - b), step(vec3(0.5), a)); r = mix(a, t, f); }
  else if (mode == 9) { vec3 scr = vec3(1.0) - (vec3(1.0) - b) * (vec3(1.0) - a); r = mix(a, (vec3(1.0) - a) * b * a + a * scr, f); }
  else if (mode == 10) r = a + f * (2.0 * b - vec3(1.0));
  else if (mode == 11) r = mix(a, abs(a - b), f);
  else if (mode == 12) r = mix(a, a + b - 2.0 * a * b, f);
  else if (mode == 13) r = a - f * b;
  else if (mode == 14) r = mix(a, nd_safe_div(a, b), f);
  else if (mode == 15) { vec3 hb = nd_rgb2hsv(b); if (hb.y != 0.0) { vec3 ha = nd_rgb2hsv(a); ha.x = hb.x; r = mix(a, nd_hsv2rgb(ha), f); } }
  else if (mode == 16) { vec3 ha = nd_rgb2hsv(a); if (ha.y != 0.0) { vec3 hb = nd_rgb2hsv(b); ha.y = hb.y; r = mix(a, nd_hsv2rgb(ha), f); } }
  else if (mode == 17) { vec3 hb = nd_rgb2hsv(b); if (hb.y != 0.0) { vec3 ha = nd_rgb2hsv(a); ha.x = hb.x; ha.y = hb.y; r = mix(a, nd_hsv2rgb(ha), f); } }
  else if (mode == 18) { vec3 ha = nd_rgb2hsv(a); vec3 hb = nd_rgb2hsv(b); ha.z = hb.z; r = mix(a, nd_hsv2rgb(ha), f); }
  return r;
}
`,
  },
  nd_wavelength: {
    code: `
vec3 nd_cie(float l) {
  float t1 = (l - 599.8) / (l < 599.8 ? 37.9 : 31.0), t2 = (l - 442.0) / (l < 442.0 ? 16.0 : 26.7), t3 = (l - 501.1) / (l < 501.1 ? 20.4 : 26.2);
  float x = 1.056 * exp(-0.5 * t1 * t1) + 0.362 * exp(-0.5 * t2 * t2) - 0.065 * exp(-0.5 * t3 * t3);
  float u1 = (l - 568.8) / (l < 568.8 ? 46.9 : 40.5), u2 = (l - 530.9) / (l < 530.9 ? 16.3 : 31.1);
  float y = 0.821 * exp(-0.5 * u1 * u1) + 0.286 * exp(-0.5 * u2 * u2);
  float v1 = (l - 437.0) / (l < 437.0 ? 11.8 : 36.0), v2 = (l - 459.0) / (l < 459.0 ? 26.0 : 13.8);
  float z = 1.217 * exp(-0.5 * v1 * v1) + 0.681 * exp(-0.5 * v2 * v2);
  return vec3(x, y, z);
}
vec3 nd_xyz2rgb(vec3 c) {
  return vec3(3.2404542 * c.x - 1.5371385 * c.y - 0.4985314 * c.z, -0.969266 * c.x + 1.8760108 * c.y + 0.041556 * c.z, 0.0556434 * c.x - 0.2040259 * c.y + 1.0572252 * c.z);
}
vec4 nd_wavelength(float l) { return vec4(max(nd_xyz2rgb(nd_cie(l)), vec3(0.0)), 1.0); }
vec4 nd_blackbody(float T) {
  T = clamp(T, 800.0, 12000.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 48; i++) {
    float l = 362.0 + float(i) * 10.0;
    float lm = l * 1e-9;
    float planck = 1.0 / (pow(lm * 1e6, 5.0) * (exp(0.014387769 / (lm * T)) - 1.0));
    acc += nd_cie(l) * planck;
  }
  // unit luminance; negative components clipped
  return vec4(max(nd_xyz2rgb(acc / max(acc.y, 1e-12)), vec3(0.0)), 1.0);
}
`,
  },
  nd_fresnel: {
    code: `
float nd_fresnel_dielectric(float cosi, float eta) {
  float c = abs(cosi);
  float g = eta * eta - 1.0 + c * c;
  if (g > 0.0) {
    g = sqrt(g);
    float A = (g - c) / (g + c);
    float B = (c * (g + c) - 1.0) / (c * (g - c) + 1.0);
    return 0.5 * A * A * (1.0 + B * B);
  }
  return 1.0;
}
`,
  },
  nd_bump: {
    code: `
vec3 nd_bump(vec3 P, vec3 N, float h, float strength, float dist, bool invert) {
  vec3 dPdx = dFdx(P), dPdy = dFdy(P);
  float hx = dFdx(h), hy = dFdy(h);
  vec3 Rx = cross(dPdy, N), Ry = cross(N, dPdx);
  float det = dot(dPdx, Rx);
  vec3 grad = sign(det) * (hx * Rx + hy * Ry);
  float d = dist * (invert ? -1.0 : 1.0);
  vec3 Nb = normalize(abs(det) * N - d * grad + 1e-9 * N);
  return normalize(mix(N, Nb, max(strength, 0.0)));
}
`,
  },
  nd_closure: {
    code: `
struct NdClosure {
  vec3 base; float metallic; float roughness; float ior; float specular; vec3 specTint;
  float transmission; vec3 emission; float alpha; float weight;
  float coat; float coatRough; float coatIor; vec3 coatTint; vec3 coatN;
  float sheen; float sheenRough; vec3 sheenTint; vec3 N; float aniso; float anisoRot;
  float thinFilm; float thinFilmIor;
};
NdClosure nd_cl_empty(vec3 N) {
  return NdClosure(vec3(0.0), 0.0, 0.5, 1.5, 0.5, vec3(1.0), 0.0, vec3(0.0), 1.0, 0.0, 0.0, 0.03, 1.5, vec3(1.0), N, 0.0, 0.5, vec3(1.0), N, 0.0, 0.0, 0.0, 1.33);
}
NdClosure nd_cl_emission(vec3 e, vec3 N) { NdClosure c = nd_cl_empty(N); c.emission = e; return c; }
NdClosure nd_cl_bsdf(vec3 base, float metallic, float rough, float ior, float spec, vec3 N) {
  NdClosure c = nd_cl_empty(N); c.base = base; c.metallic = metallic; c.roughness = rough; c.ior = ior; c.specular = spec; c.weight = 1.0; return c;
}
NdClosure nd_cl_mix(NdClosure a, NdClosure b, float f) {
  f = clamp(f, 0.0, 1.0);
  float wa = (1.0 - f) * a.weight, wb = f * b.weight, W = wa + wb;
  float t = W > 1e-6 ? wb / W : f;
  NdClosure r;
  r.base = mix(a.base, b.base, t); r.metallic = mix(a.metallic, b.metallic, t); r.roughness = mix(a.roughness, b.roughness, t);
  r.ior = mix(a.ior, b.ior, t); r.specular = mix(a.specular, b.specular, t); r.specTint = mix(a.specTint, b.specTint, t);
  r.transmission = mix(a.transmission, b.transmission, t);
  r.coat = mix(a.coat, b.coat, t); r.coatRough = mix(a.coatRough, b.coatRough, t); r.coatIor = mix(a.coatIor, b.coatIor, t); r.coatTint = mix(a.coatTint, b.coatTint, t);
  r.coatN = normalize(mix(a.coatN, b.coatN, t) + 1e-6);
  r.sheen = mix(a.sheen, b.sheen, t); r.sheenRough = mix(a.sheenRough, b.sheenRough, t); r.sheenTint = mix(a.sheenTint, b.sheenTint, t);
  r.N = normalize(mix(a.N, b.N, t) + 1e-6); r.aniso = mix(a.aniso, b.aniso, t); r.anisoRot = mix(a.anisoRot, b.anisoRot, t);
  r.thinFilm = mix(a.thinFilm, b.thinFilm, t); r.thinFilmIor = mix(a.thinFilmIor, b.thinFilmIor, t);
  r.emission = mix(a.emission, b.emission, f); r.alpha = mix(a.alpha, b.alpha, f); r.weight = mix(a.weight, b.weight, f);
  return r;
}
NdClosure nd_cl_add(NdClosure a, NdClosure b) {
  float W = a.weight + b.weight;
  NdClosure r = nd_cl_mix(a, b, W > 1e-6 ? b.weight / W : 0.5);
  r.emission = a.emission + b.emission; r.alpha = clamp(a.alpha + b.alpha, 0.0, 1.0); r.weight = a.weight + b.weight;
  return r;
}
`,
  },
};
