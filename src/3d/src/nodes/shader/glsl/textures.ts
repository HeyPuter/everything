// GLSL library: Checker, Brick, Gradient, image / environment sampling and an analytic sky
// (Preetham et al. 1999 daylight model, used to approximate every sky type). Independent code.
import type { GlslLib } from './lib';

export const TEXTURES: GlslLib = {
  nd_checker: {
    code: `
float nd_checker(vec3 p, float scale) {
  p = (p * scale + 0.000001) * 0.999999;
  ivec3 i = ivec3(floor(p));
  return ((i.x + i.y + i.z) & 1) == 1 ? 1.0 : 0.0;
}
`,
  },
  nd_brick: {
    deps: ['nd_hash'],
    code: `
// returns (tint, mortar)
vec2 nd_brick(vec3 p, float msize, float msmooth, float bias, float bw, float rh, float offamt, float offfreq, float sqamt, float sqfreq) {
  float row = floor(p.y / rh);
  float offset = 0.0;
  if (offfreq > 0.0 && sqfreq > 0.0) {
    if (mod(row, offfreq) < 0.5) offset = bw * offamt;
    if (mod(row, sqfreq) < 0.5) bw *= sqamt;
  }
  float brick = floor((p.x + offset) / bw);
  float x = (p.x + offset) - bw * brick, y = p.y - rh * row;
  float tint = clamp(nd_hash_i(ivec2(int(row), int(brick))) + bias, 0.0, 1.0);
  float md = min(min(x, y), min(bw - x, rh - y));
  float mortar;
  if (md >= msize) mortar = 0.0;
  else if (msmooth == 0.0) mortar = 1.0;
  else { md = 1.0 - md / msize; mortar = md < msmooth ? smoothstep(0.0, msmooth, md) : 1.0; }
  return vec2(tint, mortar);
}
`,
  },
  nd_gradient: {
    code: `
float nd_gradient(vec3 p, int type) {
  if (type == 0) return p.x;
  if (type == 1) { float r = max(p.x, 0.0); return r * r; }
  if (type == 2) { float r = clamp(p.x, 0.0, 1.0); return r * r * (3.0 - 2.0 * r); }
  if (type == 3) return (p.x + p.y) * 0.5;
  if (type == 4) return max(1.0 - length(p), 0.0);
  if (type == 5) { float r = max(1.0 - length(p), 0.0); return r * r; }
  return atan(p.y, p.x) / 6.2831853 + 0.5;
}
`,
  },
  nd_image: {
    code: `
vec4 nd_cubic_w(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x, w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}
vec4 nd_tex_cubic(sampler2D t, vec2 uv) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 inv = 1.0 / size;
  uv = uv * size - 0.5;
  vec2 f = fract(uv); uv -= f;
  vec4 xc = nd_cubic_w(f.x), yc = nd_cubic_w(f.y);
  vec4 c = uv.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = c + vec4(xc.yw, yc.yw) / s;
  off *= inv.xxyy;
  vec4 a = textureLod(t, off.xz, 0.0), b = textureLod(t, off.yz, 0.0), d = textureLod(t, off.xw, 0.0), e = textureLod(t, off.yw, 0.0);
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(e, d, sx), mix(b, a, sx), sy);
}
// interp: 0 linear, 1 closest, 2 cubic/smart; ext: 0 repeat, 1 extend, 2 clip, 3 mirror
vec4 nd_tex_sample(sampler2D t, vec2 uv, int interp, int ext) {
#ifdef ND_NO_DERIV
  vec2 dx = vec2(0.0), dy = vec2(0.0);
#else
  vec2 dx = dFdx(uv), dy = dFdy(uv);
#endif
  if (ext == 2 && (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0)) return vec4(0.0);
  vec2 size = vec2(textureSize(t, 0));
  if (ext == 0) uv = fract(uv);
  else if (ext == 3) uv = 1.0 - abs(mod(uv, 2.0) - 1.0);
  if (ext != 0) uv = clamp(uv, 0.5 / size, 1.0 - 0.5 / size);
  if (interp == 1) return texelFetch(t, clamp(ivec2(floor(uv * size)), ivec2(0), ivec2(size) - 1), 0);
  if (interp == 2) return nd_tex_cubic(t, uv);
  return textureGrad(t, uv, dx, dy);
}
// UDIM: the tiles sit in an atlas of grid.x × grid.y cells, cell (c, r) holding UV square (c, r)
vec4 nd_tex_udim(sampler2D t, vec2 uv, vec2 grid, int interp) {
  vec2 cell = floor(uv);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= grid.x || cell.y >= grid.y) return vec4(0.0);
  vec2 size = vec2(textureSize(t, 0)) / grid;
  vec2 f = clamp(uv - cell, 0.5 / size, 1.0 - 0.5 / size);
  vec2 a = (cell + f) / grid;
  if (interp == 1) return texelFetch(t, ivec2(floor(a * vec2(textureSize(t, 0)))), 0);
#ifdef ND_NO_DERIV
  return textureLod(t, a, 0.0);
#else
  return textureGrad(t, a, dFdx(uv) / grid, dFdy(uv) / grid);
#endif
}
vec2 nd_sphere_uv(vec3 v) { v = v * 2.0 - 1.0; return vec2(atan(v.y, v.x) / 6.2831853 + 0.5, atan(v.z, length(v.xy)) / 3.14159265 + 0.5); }
vec2 nd_tube_uv(vec3 v) { v = v * 2.0 - 1.0; return vec2(atan(v.y, v.x) / 6.2831853 + 0.5, (v.z + 1.0) * 0.5); }
vec4 nd_tex_box(sampler2D t, vec3 p, vec3 n, float blend, int interp, int ext) {
  vec3 w = abs(n);
  w = pow(w, vec3(mix(32.0, 1.0, clamp(blend, 0.0, 1.0))));
  w /= max(w.x + w.y + w.z, 1e-6);
  vec4 c = vec4(0.0);
  if (w.x > 0.001) c += w.x * nd_tex_sample(t, p.yz, interp, ext);
  if (w.y > 0.001) c += w.y * nd_tex_sample(t, p.xz, interp, ext);
  if (w.z > 0.001) c += w.z * nd_tex_sample(t, p.xy, interp, ext);
  return c;
}
vec2 nd_equirect_uv(vec3 d) { d = normalize(d); return vec2(-atan(d.y, d.x) / 6.2831853 + 0.5, atan(d.z, length(d.xy)) / 3.14159265 + 0.5); }
vec2 nd_mirrorball_uv(vec3 d) { d = normalize(d); vec3 h = normalize(d + vec3(0.0, -1.0, 0.0)); return vec2(0.5 - 0.5 * h.x, 0.5 + 0.5 * h.z); }
`,
  },
  nd_sky: {
    code: `
vec3 nd_perez(float cosT, float g, float cosG, vec3 A, vec3 B, vec3 C, vec3 D, vec3 E) {
  return (1.0 + A * exp(B / max(cosT, 0.01))) * (1.0 + C * exp(D * g) + E * cosG * cosG);
}
// sun: direction; T: turbidity; disc: >0 draws the sun with angular radius r and intensity k
vec3 nd_sky(vec3 dir, vec3 sun, float T, float disc, float r, float k, float albedo, float texel) {
  dir = normalize(dir); sun = normalize(sun);
  float thS = acos(clamp(sun.z, -1.0, 1.0));
  vec3 A = vec3(0.1787 * T - 1.4630, -0.0193 * T - 0.2592, -0.0167 * T - 0.2608);
  vec3 B = vec3(-0.3554 * T + 0.4275, -0.0665 * T + 0.0008, -0.0950 * T + 0.0092);
  vec3 C = vec3(-0.0227 * T + 5.3251, -0.0004 * T + 0.2125, -0.0079 * T + 0.2102);
  vec3 D = vec3(0.1206 * T - 2.5771, -0.0641 * T - 0.8989, -0.0441 * T - 1.6537);
  vec3 E = vec3(-0.0670 * T + 0.3703, -0.0033 * T + 0.0452, -0.0109 * T + 0.0529);
  float th = min(thS, 1.55);
  float chi = (4.0 / 9.0 - T / 120.0) * (3.14159265 - 2.0 * th);
  float Yz = max((4.0453 * T - 4.9710) * tan(chi) - 0.2155 * T + 2.4192, 0.0);
  float t2 = th * th, t3 = t2 * th, TT = T * T;
  float xz = TT * (0.00166 * t3 - 0.00375 * t2 + 0.00209 * th) + T * (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * th + 0.00394) + (0.11693 * t3 - 0.21196 * t2 + 0.06052 * th + 0.25886);
  float yz = TT * (0.00275 * t3 - 0.00610 * t2 + 0.00317 * th) + T * (-0.04214 * t3 + 0.08970 * t2 - 0.04153 * th + 0.00516) + (0.15346 * t3 - 0.26756 * t2 + 0.06670 * th + 0.26688);
  vec3 dv = dir; dv.z = max(dv.z, 0.0005); dv = normalize(dv);
  float cosT = dv.z;
  float cosG = clamp(dot(dv, sun), -1.0, 1.0), g = acos(cosG);
  vec3 num = nd_perez(cosT, g, cosG, A, B, C, D, E);
  vec3 den = nd_perez(1.0, th, cos(th), A, B, C, D, E);
  vec3 ratio = num / den;
  vec3 xyY = vec3(xz * ratio.y, yz * ratio.z, Yz * ratio.x);
  float Y = xyY.z * 0.045;
  vec3 XYZ = vec3(xyY.x / xyY.y * Y, Y, (1.0 - xyY.x - xyY.y) / xyY.y * Y);
  vec3 rgb = max(vec3(3.2404542 * XYZ.x - 1.5371385 * XYZ.y - 0.4985314 * XYZ.z, -0.969266 * XYZ.x + 1.8760108 * XYZ.y + 0.041556 * XYZ.z, 0.0556434 * XYZ.x - 0.2040259 * XYZ.y + 1.0572252 * XYZ.z), vec3(0.0));
  // dim the sky as the sun sets below the horizon
  rgb *= smoothstep(-0.12, 0.05, sun.z);
  if (dir.z < 0.0) {
    vec3 ground = mix(rgb, vec3(dot(rgb, vec3(0.2126, 0.7152, 0.0722))), 0.75) * (0.12 + 0.3 * albedo);
    rgb = mix(rgb, ground, smoothstep(0.0, 0.08, -dir.z));
  } else if (disc > 0.0 && sun.z > -0.05) {
    float re = max(r, texel);
    float ang = acos(clamp(dot(dir, sun), -1.0, 1.0));
    if (ang < re) {
      vec3 tint = mix(vec3(1.0, 0.45, 0.2), vec3(1.0, 0.97, 0.92), smoothstep(0.0, 0.5, sun.z));
      float limb = 1.0 - 0.5 * (1.0 - sqrt(max(0.0, 1.0 - (ang / re) * (ang / re))));
      rgb += tint * limb * min(4.0 * k / (3.14159265 * re * re), 30000.0);
    }
  }
  return rgb;
}
`,
  },
};
