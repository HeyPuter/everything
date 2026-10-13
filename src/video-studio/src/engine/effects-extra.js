/**
 * GLSL bodies for the second wave of effects and transitions. All original.
 * shaders.js puts FX_LIB after its effect header (u_tex, u_texel, u_res,
 * u_time, u_speed, u_strength, src(), luma(), hash11/12, rate()) and TR_LIB
 * after its transition header (A/B, ease, aspect, hash11/12, u_progress).
 *
 * Effect bodies declare the uniforms of their own parameters (u_<key>, see
 * model/effect-params.js). Every effect is a single full-frame pass that
 * reads and writes premultiplied color.
 */

/** Helpers shared by the effect bodies. */
export const FX_LIB = `
uniform float u_dur;       // length of the effect (or clip) in seconds, 0 if unknown
const float PI = 3.14159265;
const float TAU = 6.28318531;
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; } return s / 0.9375; }
vec3 hue2rgb(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
vec3 rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)); float mn = min(c.r, min(c.g, c.b)); float d = mx - mn; float h = 0.0;
  if (d > 1e-5) { if (mx == c.r) h = mod((c.g - c.b) / d, 6.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0; }
  return vec3(h / 6.0, mx > 0.0 ? d / mx : 0.0, mx);
}
vec3 hsv2rgb(vec3 c) { return c.z * mix(vec3(1.0), hue2rgb(c.x), c.y); }
mat2 rot(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
float aspect() { return u_res.x / u_res.y; }
bool inside(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
vec3 unpre(vec4 c) { return c.a > 1e-4 ? c.rgb / c.a : vec3(0.0); }
vec4 repre(vec3 rgb, float a) { return vec4(clamp(rgb, 0.0, 1.0) * a, a); }
vec4 over(vec4 c, vec3 col, float m) { m = clamp(m, 0.0, 1.0); return c * (1.0 - m) + vec4(col * m, m); }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float bayer4(vec2 cell) {
  ivec2 i = ivec2(mod(cell, 4.0)); int a = i.x ^ i.y; int b = i.y;
  int v = ((a & 1) << 3) | ((b & 1) << 2) | (((a >> 1) & 1) << 1) | ((b >> 1) & 1);
  return (float(v) + 0.5) / 16.0;
}
// Disc blur: 24 taps on a golden-angle spiral, rotated per pixel to hide the pattern. r is the radius in uv.
vec4 discBlur(vec2 uv, vec2 r) {
  vec4 acc = vec4(0.0); float j = hash12(uv * u_res) * TAU;
  for (int i = 0; i < 24; i++) { float a = float(i) * 2.39996323 + j; float d = sqrt((float(i) + 0.5) / 24.0); acc += src(uv + vec2(cos(a), sin(a)) * d * r); }
  return acc / 24.0;
}
`;

export const EXTRA_EFFECT_SHADERS = {
  // ---- Basic -------------------------------------------------------------
  'soft-focus': `uniform float u_radius;
void main() {
  vec4 c = src(v_uv);
  vec4 b = discBlur(v_uv, vec2(1.0 / aspect(), 1.0) * (0.004 + u_radius * 0.03));
  vec3 soft = mix(b.rgb, max(b.rgb, c.rgb), 0.6);
  outColor = vec4(mix(c.rgb, soft, u_strength * 0.85), c.a);
}`,
  'tilt-shift': `uniform float u_focus, u_size;
void main() {
  float d = abs(v_uv.y - u_focus);
  float m = smoothstep(u_size * 0.3, u_size * 0.3 + 0.28, d);
  vec4 b = discBlur(v_uv, vec2(1.0 / aspect(), 1.0) * m * u_strength * 0.022);
  vec3 rgb = unpre(b);
  rgb = mix(vec3(luma(rgb)), rgb, 1.0 + 0.35 * u_strength);
  rgb = (rgb - 0.5) * (1.0 + 0.1 * u_strength) + 0.5;
  outColor = repre(rgb, b.a);
}`,
  duotone: `uniform vec3 u_dark, u_light;
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  float l = smoothstep(0.04, 0.96, luma(rgb));
  vec3 d = mix(u_dark, u_light, l);
  outColor = repre(mix(rgb, d, u_strength), c.a);
}`,
  'color-pop': `uniform float u_hue, u_range;
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c); vec3 hsv = rgb2hsv(rgb);
  float dh = abs(fract(hsv.x - u_hue / 360.0 + 0.5) - 0.5) * 360.0;
  float tol = 5.0 + u_range * 55.0;
  float keep = (1.0 - smoothstep(tol, tol + 18.0, dh)) * smoothstep(0.08, 0.25, hsv.y);
  outColor = repre(mix(rgb, vec3(luma(rgb)), (1.0 - keep) * u_strength), c.a);
}`,
  // ---- Motion ------------------------------------------------------------
  'slow-push': `uniform float u_angle;
void main() {
  float p = u_dur > 0.0 ? clamp(u_time / u_dur, 0.0, 1.0) : 0.5;
  float z = 1.0 + u_strength * 0.35 * p;
  vec2 dir = vec2(cos(radians(u_angle)), sin(radians(u_angle)));
  outColor = src((v_uv - 0.5) / z + 0.5 + dir * (1.0 - 1.0 / z) * 0.45);
}`,
  'beat-bounce': `void main() {
  float bpm = 60.0 + u_speed * 120.0;
  float k = exp(-fract(u_time * bpm / 60.0) * 7.0) * u_strength;
  vec4 c = src((v_uv - 0.5) / vec2(1.0 + k * 0.1, 1.0 + k * 0.16) + 0.5);
  c.rgb *= 1.0 + k * 0.12;
  outColor = c;
}`,
  handheld: `void main() {
  float t = u_time * (0.2 + u_speed * 1.6);
  vec2 o = vec2(vnoise(vec2(t, 1.7)), vnoise(vec2(t + 9.2, 4.1))) - 0.5;
  o += (vec2(vnoise(vec2(t * 3.1, 2.3)), vnoise(vec2(t * 2.9, 8.8))) - 0.5) * 0.35;
  float a = (vnoise(vec2(t * 0.8, 7.3)) - 0.5) * u_strength * 0.05;
  float z = 1.0 + u_strength * 0.12;
  vec2 p = rot(a) * ((v_uv - 0.5) * vec2(aspect(), 1.0));
  p.x /= aspect();
  outColor = src(p / z + 0.5 + o * u_strength * 0.05);
}`,
  'whip-blur': `uniform float u_angle;
void main() {
  float t = u_time * (0.4 + u_speed * 2.5);
  float w = pow(abs(sin(t * PI)), 8.0);
  vec2 dir = vec2(cos(radians(u_angle)) / aspect(), sin(radians(u_angle)));
  float len = (0.01 + 0.2 * w) * u_strength;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) acc += src(v_uv + dir * ((float(i) / 15.0 - 0.5) * len + w * u_strength * 0.03));
  outColor = acc / 16.0;
}`,
  // ---- Light and glow -----------------------------------------------------
  bloom: `uniform float u_threshold;
void main() {
  vec4 c = src(v_uv);
  float j = hash12(v_uv * u_res) * TAU;
  vec2 r = vec2(1.0 / aspect(), 1.0) * 0.05;
  vec3 b = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float a = float(i) * 2.39996323 + j; float d = sqrt((float(i) + 0.5) / 24.0);
    b += max(src(v_uv + vec2(cos(a), sin(a)) * d * r).rgb - u_threshold, 0.0) * (1.2 - d);
  }
  b /= 24.0 * 0.6 * max(1.0 - u_threshold, 0.15);
  outColor = vec4(c.rgb + b * u_strength * 1.5, c.a);
}`,
  'sun-rays': `uniform float u_pos;
void main() {
  vec4 c = src(v_uv);
  vec2 L = vec2(u_pos, 0.95);
  vec2 stp = (L - v_uv) / 40.0;
  vec2 uv = v_uv + stp * hash12(v_uv * u_res);
  float decay = 1.0; vec3 acc = vec3(0.0);
  for (int i = 0; i < 40; i++) { uv += stp; vec3 s = src(uv).rgb; acc += s * smoothstep(0.5, 0.95, luma(s)) * decay; decay *= 0.97; }
  acc /= 40.0;
  float flick = 0.85 + 0.15 * vnoise(vec2(u_time * rate(), 3.0));
  float halo = exp(-length((v_uv - L) * vec2(aspect(), 1.0)) * 3.5);
  outColor = vec4(c.rgb + (acc * 2.5 + halo * 0.3) * vec3(1.0, 0.9, 0.7) * u_strength * flick, c.a);
}`,
  'lens-flare': `void main() {
  vec4 c = src(v_uv);
  float t = u_time * rate() * 0.25;
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = (v_uv - 0.5) * asp;
  vec2 l = (vec2(0.5 + 0.32 * sin(t), 0.68 + 0.12 * cos(t * 0.8)) - 0.5) * asp;
  vec2 dl = p - l; float d = length(dl);
  vec3 f = vec3(1.0, 0.92, 0.8) * (0.012 / (d + 0.012));
  f += vec3(0.7, 0.8, 1.0) * exp(-abs(dl.y) * 90.0) * exp(-abs(dl.x) * 2.5) * 0.5;
  f += vec3(1.0, 0.85, 0.7) * pow(max(0.0, 1.0 - d * 2.2), 3.0) * 0.25;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float r = 0.025 + 0.035 * hash11(fi + 3.0);
    float gd = length(p - l * (0.6 - fi * 0.38));
    vec3 col = hue2rgb(fract(0.08 + fi * 0.17)) * 0.6 + 0.2;
    f += col * ((1.0 - smoothstep(r * 0.7, r, gd)) * 0.14 + (1.0 - smoothstep(0.0, 0.006, abs(gd - r))) * 0.1);
  }
  outColor = vec4(c.rgb + f * u_strength, c.a);
}`,
  bokeh: `uniform float u_size;
void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(aspect(), 1.0);
  float t = u_time * rate();
  vec3 acc = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float sc = (2.5 + fl * 1.5) / (0.4 + u_size);
    vec2 p = v_uv * asp * sc + vec2(t * 0.03 * (fl + 1.0), -t * 0.05 * (fl + 1.0));
    vec2 id = floor(p); vec2 f = fract(p) - 0.5;
    float h = hash12(id + fl * 19.0);
    if (h > 0.25 + 0.55 * u_strength) continue;
    vec2 o = (hash22(id + fl * 7.0) - 0.5) * 0.45;
    float r = 0.16 + 0.16 * hash12(id * 1.7 + fl);
    float d = length(f - o);
    float disc = (1.0 - smoothstep(r - 0.025, r, d)) * (0.55 + 0.45 * smoothstep(r * 0.3, r, d));
    vec3 col = mix(vec3(1.0), hue2rgb(fract(h * 3.7 + 0.08)), 0.55);
    acc += col * disc * (0.65 + 0.35 * sin(t * 1.3 + h * 40.0)) * (0.3 - fl * 0.06);
  }
  outColor = vec4(c.rgb * (1.0 - 0.2 * u_strength) + acc * (0.4 + u_strength), c.a);
}`,
  // ---- Retro and film -----------------------------------------------------
  crt: `uniform float u_curve;
void main() {
  vec2 p = v_uv * 2.0 - 1.0;
  p *= 1.0 + u_curve * 0.2 * (p.yx * p.yx);
  vec2 uv = p * 0.5 + 0.5;
  float edge = smoothstep(0.0, 0.006, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  float off = 0.0012 + 0.002 * u_strength;
  vec4 m = src(uv);
  vec3 col = vec3(src(uv + vec2(off, 0.0)).r, m.g, src(uv - vec2(off, 0.0)).b);
  float lines = min(240.0, u_res.y * 0.3);
  col *= 1.0 - u_strength * 0.4 * (0.5 + 0.5 * cos(uv.y * lines * TAU));
  float tri = mod(floor(uv.x * lines * aspect() * 1.5), 3.0);
  vec3 mask = tri < 0.5 ? vec3(1.0, 0.75, 0.75) : tri < 1.5 ? vec3(0.75, 1.0, 0.75) : vec3(0.75, 0.75, 1.0);
  col *= mix(vec3(1.0), mask * 1.15, u_strength * 0.7);
  float vig = pow(clamp(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.0, 1.0), 0.3);
  col *= mix(1.0, vig, u_strength) * (1.0 + 0.25 * u_strength) * (1.0 + 0.03 * u_strength * sin(u_time * 60.0));
  outColor = mix(vec4(0.0, 0.0, 0.0, 1.0), vec4(col, m.a), edge);
}`,
  'home-movie': `uniform float u_grain;
void main() {
  float t = floor(u_time * 18.0);
  vec2 jit = vec2(hash11(t) - 0.5, hash11(t + 3.7) - 0.5) * vec2(0.002, 0.005) * u_strength;
  vec4 c = src((v_uv - 0.5) * (1.0 - 0.04 * u_strength) + 0.5 + jit);
  vec3 rgb = unpre(c);
  vec3 film = mix(rgb, vec3(luma(rgb)), 0.25) * vec3(1.08, 0.98, 0.8) + vec3(0.06, 0.035, 0.0);
  film = mix(film, film * film * (3.0 - 2.0 * film), 0.5);
  film *= 0.93 + 0.07 * hash11(t * 1.3);
  vec2 d = abs(v_uv - 0.5) - vec2(0.43, 0.41);
  film *= 1.0 - smoothstep(-0.05, 0.07, length(max(d, 0.0)) + min(max(d.x, d.y), 0.0));
  film += (hash12(v_uv * u_res + t * 7.0) - 0.5) * 0.18 * u_grain;
  outColor = repre(mix(rgb, film, u_strength), c.a);
}`,
  dust: `void main() {
  vec4 c = src(v_uv);
  float t = floor(u_time * (4.0 + u_speed * 20.0));
  vec2 asp = vec2(aspect(), 1.0);
  float dark = 0.0;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 g = v_uv * asp * (14.0 + fi * 20.0);
    vec2 id = floor(g);
    if (hash12(id + vec2(t * 13.1, fi * 5.0)) > 1.0 - 0.02 * u_strength) {
      vec2 o = (hash22(id + t) - 0.5) * 0.5;
      float r = 0.06 + 0.16 * hash12(id - t);
      dark = max(dark, 1.0 - smoothstep(r * 0.3, r, length(fract(g) - 0.5 - o)));
    }
  }
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    if (hash11(t * 3.3 + fi * 7.7) > 0.25 + 0.6 * u_strength) continue;
    vec2 ctr = vec2(hash11(t + fi * 1.9), hash11(t * 1.7 + fi));
    vec2 p = rot(hash11(t + 9.0 + fi) * TAU) * ((v_uv - ctr) * asp);
    float curve = p.y - (hash11(t + 4.0 + fi) - 0.5) * 30.0 * p.x * p.x;
    dark = max(dark, (1.0 - smoothstep(0.0, 0.0022, abs(curve))) * (1.0 - smoothstep(0.0, 0.07, abs(p.x))));
  }
  float scratch = (1.0 - smoothstep(0.0, 0.0012, abs(v_uv.x - hash11(t * 0.37 + 1.0)))) * step(0.55, hash11(t * 2.9)) * (0.4 + 0.6 * vnoise(vec2(v_uv.y * 25.0, t)));
  vec3 rgb = mix(c.rgb, vec3(0.04) * c.a, dark * 0.85) + vec3(scratch * 0.4 * u_strength) * c.a;
  outColor = vec4(rgb, c.a);
}`,
  dither: `uniform float u_size; uniform vec3 u_ink, u_paper;
void main() {
  float n = mix(360.0, 70.0, u_size);
  vec2 cells = vec2(floor(n * aspect()), n);
  vec2 cell = floor(v_uv * cells);
  vec4 c = src((cell + 0.5) / cells);
  float l = clamp((luma(unpre(c)) - 0.5) * 1.15 + 0.5, 0.0, 1.0);
  outColor = vec4((l > bayer4(cell) ? u_paper : u_ink) * c.a, c.a);
}`,
  bit8: `uniform float u_size, u_colors;
void main() {
  float n = mix(160.0, 36.0, u_size);
  vec2 cells = vec2(floor(n * aspect()), n);
  vec2 cell = floor(v_uv * cells);
  vec4 c = src((cell + 0.5) / cells);
  vec3 rgb = unpre(c);
  rgb = clamp(mix(vec3(luma(rgb)), rgb, 1.25), 0.0, 1.0);
  float lv = floor(mix(2.0, 7.0, u_colors));
  outColor = repre(floor(rgb * lv + bayer4(cell)) / lv, c.a);
}`,
  // ---- Glitch ------------------------------------------------------------
  'block-smear': `uniform float u_size;
void main() {
  float t = floor(u_time * (3.0 + u_speed * 15.0));
  float n = mix(36.0, 8.0, u_size);
  vec2 cells = vec2(floor(n * aspect()), n);
  vec2 id = floor(v_uv * cells);
  float on = step(1.0 - u_strength * 0.45, hash12(id + t * 1.31));
  vec2 uv = v_uv + on * (hash22(id * 0.73 + t) - 0.5) * vec2(0.14, 0.06) * u_strength;
  float row = step(1.0 - u_strength * 0.2, hash12(vec2(id.y, t * 2.1)));
  uv.x = mix(uv.x, (floor(v_uv.x * cells.x * 0.25) + 0.5) / (cells.x * 0.25), row);
  vec4 c = src(uv);
  c.rgb = mix(c.rgb, c.gbr, on * step(0.8, hash12(id + t * 3.7)));
  outColor = c;
}`,
  'signal-tear': `void main() {
  float t = u_time * (0.4 + u_speed * 2.5);
  float y = v_uv.y;
  float band = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float pos = fract(t * (0.11 + fi * 0.07) + hash11(fi * 7.0 + 1.0));
    float w = 0.015 + 0.05 * hash11(fi + floor(t * 2.0));
    band += 1.0 - smoothstep(0.0, w, abs(y - pos));
  }
  band = min(band, 1.0);
  float shift = (band * 0.08 * sin(t * 11.0 + y * 45.0) + (vnoise(vec2(y * 90.0, t * 25.0)) - 0.5) * 0.012) * u_strength;
  float x = fract(v_uv.x + shift);
  vec4 m = src(vec2(x, y));
  vec4 c = vec4(src(vec2(fract(x + shift * 0.6), y)).r, m.g, src(vec2(fract(x - shift * 0.6), y)).b, m.a);
  c.rgb += band * (hash12(vec2(floor(y * u_res.y * 0.5), floor(t * 30.0))) - 0.5) * 0.35 * u_strength * c.a;
  outColor = c;
}`,
  static: `void main() {
  vec4 c = src(v_uv);
  float t = floor(u_time * (8.0 + u_speed * 40.0));
  float n = hash12(floor(v_uv * u_res * 0.6) + t * 17.0);
  float roll = smoothstep(0.0, 0.12, abs(fract(v_uv.y * 0.6 - u_time * 0.35) - 0.5));
  float line = 0.85 + 0.15 * hash11(floor(v_uv.y * u_res.y * 0.4) + t);
  vec3 rgb = mix(c.rgb, vec3(n) * c.a, u_strength * 0.65);
  outColor = vec4(rgb * mix(1.0, line * (0.8 + 0.2 * roll), u_strength), c.a);
}`,
  'slice-shift': `uniform float u_count;
void main() {
  float n = floor(mix(3.0, 20.0, u_count));
  float t = u_time * (0.3 + u_speed * 2.0);
  float id = floor(v_uv.y * n);
  float dir = mod(id, 2.0) * 2.0 - 1.0;
  float ph = fract(t + hash11(id + 1.0) * 0.25);
  float e = smoothstep(0.0, 0.18, ph) - smoothstep(0.5, 0.68, ph);
  vec4 c = src(vec2(fract(v_uv.x + dir * e * u_strength * 0.3), v_uv.y));
  c.rgb *= 1.0 - (1.0 - smoothstep(0.0, 0.04, fract(v_uv.y * n))) * e * u_strength * 0.5;
  outColor = c;
}`,
  'pixel-melt': `uniform float u_threshold;
void main() {
  vec4 c = src(v_uv);
  float col = hash11(floor(v_uv.x * min(u_res.x, 640.0)) + 0.5);
  float len = u_strength * 0.3 * (0.35 + 0.65 * col) * (0.75 + 0.25 * sin(u_time * rate() + col * 6.0));
  vec4 best = c; float bl = luma(unpre(c));
  for (int i = 1; i <= 20; i++) {
    vec4 s = src(v_uv + vec2(0.0, float(i) / 20.0 * len));
    float l = luma(unpre(s));
    if (l > bl && l > u_threshold) { best = s; bl = l; }
  }
  outColor = best;
}`,
  // ---- Distort -----------------------------------------------------------
  twirl: `uniform float u_size;
void main() {
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = (v_uv - 0.5) * asp;
  float k = 1.0 - smoothstep(0.0, 0.15 + u_size * 0.6, length(p));
  p = rot(k * k * u_strength * 5.0 * (0.65 + 0.35 * sin(u_time * rate()))) * p;
  outColor = src(p / asp + 0.5);
}`,
  'water-ripple': `uniform float u_size;
void main() {
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = (v_uv - 0.5) * asp;
  float r = length(p);
  float ph = r * mix(80.0, 20.0, u_size) - u_time * rate() * 5.0;
  float amp = u_strength * 0.01 * (1.0 - smoothstep(0.0, 1.0, r));
  vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
  vec4 c = src(v_uv + dir / asp * sin(ph) * amp);
  c.rgb += pow(max(0.0, cos(ph)), 12.0) * amp * 18.0 * c.a;
  outColor = c;
}`,
  'heat-haze': `void main() {
  float t = u_time * (0.3 + u_speed * 2.0);
  vec2 q = v_uv * vec2(aspect(), 1.0) * 6.0;
  vec2 n = vec2(fbm(q + vec2(0.0, -t * 2.0)), fbm(q + vec2(5.2, -t * 2.3))) - 0.5;
  vec4 c = src(v_uv + n * 0.025 * u_strength * mix(1.0, 0.4, v_uv.y));
  outColor = repre(unpre(c) * vec3(1.0 + 0.06 * u_strength, 1.0, 1.0 - 0.06 * u_strength), c.a);
}`,
  'glass-tiles': `uniform float u_size;
void main() {
  float n = mix(28.0, 5.0, u_size);
  vec2 cells = vec2(floor(n * aspect() + 0.5), n);
  vec2 g = v_uv * cells; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
  vec2 uv = (id + 0.5 + f * (1.0 - 0.6 * u_strength) + f * f * f * 2.4 * u_strength) / cells;
  vec4 c = src(uv);
  c.rgb *= 1.0 - smoothstep(0.43, 0.5, max(abs(f.x), abs(f.y))) * 0.35 * u_strength;
  c.rgb += (1.0 - smoothstep(0.0, 0.35, length(f - vec2(-0.2, 0.2)))) * 0.1 * u_strength * c.a;
  outColor = c;
}`,
  // ---- Stylize -----------------------------------------------------------
  comic: `uniform float u_lines;
float lum(vec2 uv) { return luma(src(uv).rgb); }
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  vec2 o = vec2(1.0 / aspect(), 1.0) * (0.0012 + u_lines * 0.003);
  float tl = lum(v_uv + o * vec2(-1.0, 1.0)), tc = lum(v_uv + o * vec2(0.0, 1.0)), tr = lum(v_uv + o * vec2(1.0, 1.0));
  float ml = lum(v_uv - vec2(o.x, 0.0)), mr = lum(v_uv + vec2(o.x, 0.0));
  float bl = lum(v_uv - o), bc = lum(v_uv - vec2(0.0, o.y)), br = lum(v_uv + o * vec2(1.0, -1.0));
  float gx = tr + 2.0 * mr + br - tl - 2.0 * ml - bl;
  float gy = tl + 2.0 * tc + tr - bl - 2.0 * bc - br;
  float e = smoothstep(0.25, 0.6, length(vec2(gx, gy)));
  vec3 hsv = rgb2hsv(rgb);
  hsv.y = min(1.0, hsv.y * 1.35);
  hsv.z = max(0.12, floor(hsv.z * 4.0 + 0.5) / 4.0);
  vec3 pc = hsv2rgb(hsv);
  vec2 g = rot(0.785) * (v_uv * vec2(aspect(), 1.0) * 120.0);
  float dots = 1.0 - smoothstep(0.26, 0.32, length(fract(g) - 0.5));
  pc *= 1.0 - dots * (1.0 - smoothstep(0.15, 0.55, luma(rgb))) * 0.45;
  pc = mix(pc, vec3(0.04), e);
  outColor = repre(mix(rgb, pc, u_strength), c.a);
}`,
  'oil-paint': `uniform float u_size;
void main() {
  vec2 st = vec2(1.0 / aspect(), 1.0) * (0.0008 + u_size * 0.0035);
  float best = 1e9; vec3 res = vec3(0.0);
  for (int q = 0; q < 4; q++) {
    vec2 sg = vec2(q == 0 || q == 2 ? -1.0 : 1.0, q < 2 ? -1.0 : 1.0);
    vec3 mean = vec3(0.0); vec3 sq = vec3(0.0);
    for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
      vec3 x = src(v_uv + vec2(float(i), float(j)) * sg * st).rgb;
      mean += x; sq += x * x;
    }
    mean /= 16.0;
    vec3 v = abs(sq / 16.0 - mean * mean);
    float s = v.r + v.g + v.b;
    if (s < best) { best = s; res = mean; }
  }
  vec4 c = src(v_uv);
  outColor = vec4(mix(c.rgb, res, u_strength), c.a);
}`,
  'type-mosaic': `uniform float u_size, u_color;
float glyph(vec2 f, float l) {
  vec2 p = f - 0.5; vec2 a = abs(p); float w = 0.08;
  if (l < 0.12) return 0.0;
  if (l < 0.26) return step(length(p), 0.1);
  if (l < 0.4) return step(a.y, w) * step(a.x, 0.3);
  if (l < 0.55) return max(step(a.y, w) * step(a.x, 0.32), step(a.x, w) * step(a.y, 0.32));
  if (l < 0.7) return max(step(abs(p.x - p.y), w * 1.3), step(abs(p.x + p.y), w * 1.3)) * step(max(a.x, a.y), 0.33);
  if (l < 0.85) return max(step(abs(a.x - 0.15), w * 0.8) * step(a.y, 0.36), step(abs(a.y - 0.15), w * 0.8) * step(a.x, 0.36));
  return step(max(a.x, a.y), 0.38);
}
void main() {
  float n = mix(80.0, 24.0, u_size);
  vec2 cells = vec2(floor(n * aspect() / 0.62), n);
  vec2 g = v_uv * cells; vec2 id = floor(g);
  vec4 c = src((id + 0.5) / cells);
  vec3 rgb = unpre(c); float l = luma(rgb);
  vec3 ink = mix(vec3(0.3, 1.0, 0.5) * (0.55 + 0.6 * l), clamp(rgb * 1.35, 0.0, 1.0), u_color);
  outColor = vec4(ink * glyph(fract(g), l) * c.a, c.a);
}`,
  'hex-tiles': `uniform float u_size, u_gap;
void main() {
  float n = mix(60.0, 10.0, u_size);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = v_uv * asp * n;
  vec2 r = vec2(1.0, 1.7320508); vec2 hr = r * 0.5;
  vec2 c1 = (floor(p / r) + 0.5) * r;
  vec2 c2 = (floor((p - hr) / r) + 0.5) * r + hr;
  vec2 ctr = dot(p - c1, p - c1) < dot(p - c2, p - c2) ? c1 : c2;
  vec2 q = abs(p - ctr);
  float d = max(q.x, q.x * 0.5 + q.y * 0.8660254);
  vec4 col = src(ctr / n / asp);
  float lim = 0.5 - u_gap * 0.12;
  col.rgb *= 1.0 - smoothstep(lim - 0.02, lim, d) * 0.85;
  col.rgb += (1.0 - smoothstep(0.0, 0.45, length(p - ctr + vec2(0.15, -0.2)))) * 0.06 * col.a;
  outColor = col;
}`,
  crosshatch: `uniform float u_density;
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c); float l = luma(rgb);
  vec2 p = v_uv * vec2(aspect(), 1.0) * mix(70.0, 200.0, u_density);
  float wob = vnoise(p * 0.08) * 0.8;
  float h1 = abs(fract((p.x + p.y) * 0.5 + wob) - 0.5);
  float h2 = abs(fract((p.x - p.y) * 0.5 + wob) - 0.5);
  float h3 = abs(fract(p.y * 0.7 + wob * 0.5) - 0.5);
  float ink = (1.0 - smoothstep(0.55, 0.85, l)) * (1.0 - smoothstep(0.08, 0.2, h1));
  ink = max(ink, (1.0 - smoothstep(0.35, 0.6, l)) * (1.0 - smoothstep(0.08, 0.2, h2)));
  ink = max(ink, (1.0 - smoothstep(0.15, 0.35, l)) * (1.0 - smoothstep(0.08, 0.2, h3)));
  vec2 o = vec2(1.0 / aspect(), 1.0) * 0.0015;
  float e = abs(luma(src(v_uv + vec2(o.x, 0.0)).rgb) - luma(src(v_uv - vec2(o.x, 0.0)).rgb)) + abs(luma(src(v_uv + vec2(0.0, o.y)).rgb) - luma(src(v_uv - vec2(0.0, o.y)).rgb));
  e = smoothstep(0.08, 0.3, e);
  vec3 col = mix(vec3(0.97, 0.955, 0.92), vec3(0.16, 0.16, 0.2), clamp(max(ink * 0.8, e), 0.0, 1.0));
  outColor = repre(mix(rgb, col, u_strength), c.a);
}`,
  'ink-sketch': `uniform float u_lines;
float inkL(vec2 uv) { return luma(unpre(src(uv))); }
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  vec2 px = vec2(1.0 / aspect(), 1.0) * (0.0007 + u_lines * 0.0022);
  // A fine and a wide blur of the light; where the fine one is darker there is a line.
  float a = 0.0; float b = 0.0; float wa = 0.0; float wb = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 o = vec2(float(i), float(j));
    float l = inkL(v_uv + o * px);
    float d = dot(o, o);
    float ka = exp(-d / 1.1); float kb = exp(-d / 4.5);
    a += l * ka; wa += ka; b += l * kb; wb += kb;
  }
  float dog = a / wa - b / wb;
  float ink = smoothstep(0.004, 0.04, -dog);
  float l = luma(rgb);
  float wash = (1.0 - smoothstep(0.12, 0.5, l)) * 0.3 + (1.0 - smoothstep(0.02, 0.18, l)) * 0.3;
  float grain = vnoise(v_uv * u_res * 0.4) * 0.05;
  vec3 paper = vec3(0.97, 0.955, 0.92) - grain;
  vec3 col = mix(paper, vec3(0.1, 0.1, 0.14), clamp(ink + wash, 0.0, 1.0));
  outColor = repre(mix(rgb, col, u_strength), c.a);
}`,
  watercolor: `uniform float u_bleed;
float wl(vec2 uv) { return luma(unpre(src(uv))); }
void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(1.0 / aspect(), 1.0);
  // Water pushes the pigment around a little.
  vec2 n = vec2(fbm(v_uv * 5.0), fbm(v_uv * 5.0 + 7.3)) - 0.5;
  vec2 uv = v_uv + n * asp * 0.014 * (0.4 + u_bleed);
  vec4 b = discBlur(uv, asp * (0.003 + u_bleed * 0.012));
  vec3 rgb = unpre(b);
  vec3 hsv = rgb2hsv(rgb);
  // Soft steps of tone, like layered washes (hard steps would band smooth skies).
  float q = hsv.z * 5.0; float qf = fract(q);
  hsv.z = mix(hsv.z, (floor(q) + smoothstep(0.3, 0.7, qf)) / 5.0, 0.45);
  hsv.y *= 0.88;
  vec3 wash = hsv2rgb(hsv);
  // Pigment gathers at the edges of each color area.
  vec2 o = asp * 0.003;
  float g = length(vec2(wl(uv + vec2(o.x, 0.0)) - wl(uv - vec2(o.x, 0.0)), wl(uv + vec2(0.0, o.y)) - wl(uv - vec2(0.0, o.y))));
  wash *= 1.0 - smoothstep(0.03, 0.25, g) * 0.3;
  // Blooms, paper tooth and a lighter, airy whole.
  wash *= 1.0 - smoothstep(0.55, 0.85, fbm(v_uv * 3.0 + 2.0)) * 0.12;
  float tooth = fbm(v_uv * u_res / 14.0);
  wash = mix(wash, vec3(1.0), 0.14) * (0.93 + 0.07 * tooth);
  outColor = repre(mix(unpre(c), wash, u_strength), c.a);
}`,
  'neon-edges': `uniform float u_hue;
float nl(vec2 uv) { return luma(unpre(src(uv))); }
float sob(vec2 o) {
  float tl = nl(v_uv + o * vec2(-1.0, 1.0)), tc = nl(v_uv + o * vec2(0.0, 1.0)), tr = nl(v_uv + o * vec2(1.0, 1.0));
  float ml = nl(v_uv - vec2(o.x, 0.0)), mr = nl(v_uv + vec2(o.x, 0.0));
  float bl = nl(v_uv - o), bc = nl(v_uv - vec2(0.0, o.y)), br = nl(v_uv + o * vec2(1.0, -1.0));
  return length(vec2(tr + 2.0 * mr + br - tl - 2.0 * ml - bl, tl + 2.0 * tc + tr - bl - 2.0 * bc - br));
}
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  vec2 o = vec2(1.0 / aspect(), 1.0) * 0.0016;
  float e1 = sob(o);
  float e2 = sob(o * 3.5);
  vec3 tint = hue2rgb(fract(u_hue / 360.0 + v_uv.x * 0.22 + v_uv.y * 0.12));
  vec3 col = rgb * 0.1 + tint * (smoothstep(0.12, 0.5, e1) * 1.2 + smoothstep(0.08, 0.7, e2) * 0.45);
  col += smoothstep(0.55, 1.0, e1) * 0.35;
  outColor = repre(mix(rgb, col, u_strength), c.a);
}`,
  thermal: `uniform float u_shift;
vec3 heat(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 a = mix(vec3(0.02, 0.0, 0.18), vec3(0.45, 0.0, 0.6), smoothstep(0.0, 0.25, x));
  a = mix(a, vec3(0.92, 0.1, 0.15), smoothstep(0.25, 0.5, x));
  a = mix(a, vec3(1.0, 0.62, 0.0), smoothstep(0.5, 0.75, x));
  return mix(a, vec3(1.0, 1.0, 0.85), smoothstep(0.75, 1.0, x));
}
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  outColor = repre(mix(rgb, heat(luma(rgb) + u_shift), u_strength), c.a);
}`,
  'night-scope': `uniform float u_noise;
void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  float l = pow(clamp(luma(rgb) * 1.6 + 0.05, 0.0, 1.0), 0.8);
  l += (hash12(v_uv * u_res + floor(u_time * 24.0) * 31.0) - 0.5) * u_noise * 0.35;
  vec3 g = vec3(0.15, 1.0, 0.3) * l * (0.9 + 0.1 * sin(v_uv.y * min(u_res.y, 600.0) * 1.5));
  vec2 p = (v_uv - 0.5) * vec2(aspect(), 1.0);
  g *= 1.0 - smoothstep(0.46, 0.5, length(p));
  g *= 1.0 - smoothstep(0.2, 0.5, length(p)) * 0.4;
  outColor = repre(mix(rgb, g, u_strength), c.a);
}`,
  // ---- Party -------------------------------------------------------------
  disco: `void main() {
  vec4 c = src(v_uv);
  vec2 p = v_uv * vec2(aspect(), 1.0);
  float t = u_time * rate();
  vec3 light = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 ctr = vec2((0.5 + sin(t * (0.7 + fi * 0.23) + fi * 2.1) * 0.45) * aspect(), 0.5 + cos(t * (0.9 + fi * 0.17) + fi) * 0.4);
    light += hue2rgb(fract(fi * 0.25 + t * 0.05)) * (1.0 - smoothstep(0.0, 0.34, length(p - ctr)));
  }
  vec2 g = p * 22.0 + vec2(t * 0.5, 0.0);
  float s = step(0.93, hash12(floor(g) + floor(t * 6.0))) * (1.0 - smoothstep(0.0, 0.25, length(fract(g) - 0.5)));
  vec3 rgb = c.rgb * (1.0 - 0.45 * u_strength) + c.rgb * light * u_strength * 1.2 + (light * 0.15 + s * 0.8) * u_strength * c.a;
  outColor = vec4(rgb, c.a);
}`,
  confetti: `vec4 piece(vec2 uv, float sc, float t, float seed) {
  vec2 p = uv * vec2(aspect(), 1.0) * sc;
  p.y += t * (0.8 + 0.3 * hash11(seed));
  vec2 id = floor(p); vec2 f = fract(p) - 0.5;
  float h = hash12(id + seed);
  if (h > u_strength * 0.75) return vec4(0.0);
  vec2 o = (hash22(id + seed * 3.1) - 0.5) * 0.45;
  o.x += sin(t * 1.7 + h * 20.0) * 0.12;
  vec2 q = rot(h * 6.28 + t * (h - 0.5) * 4.0) * (f - o);
  float spin = t * (2.0 + 5.0 * h) + h * 10.0;
  q.x /= max(0.2, abs(cos(spin)));
  float r = 0.1 + 0.05 * hash12(id * 2.3 + seed);
  float m = (1.0 - smoothstep(r - 0.02, r, abs(q.x))) * (1.0 - smoothstep(r * 0.5 - 0.02, r * 0.5, abs(q.y)));
  vec3 col = (hue2rgb(fract(h * 7.13 + seed)) * 0.85 + 0.12) * (0.7 + 0.3 * abs(cos(spin)));
  return vec4(col, m);
}
void main() {
  vec4 c = src(v_uv);
  float t = u_time * (0.3 + u_speed * 2.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec4 k = piece(v_uv, 12.0 - fi * 3.5, t * (0.8 + fi * 0.25), fi * 31.0 + 1.0);
    c = over(c, k.rgb, k.a);
  }
  outColor = c;
}`,
  hearts: `uniform vec3 u_color;
float heartF(vec2 p) { p.y += 0.15; float a = p.x * p.x + p.y * p.y - 1.0; return a * a * a - p.x * p.x * p.y * p.y * p.y; }
void main() {
  vec4 c = src(v_uv);
  float t = u_time * (0.2 + u_speed * 1.5);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = v_uv * vec2(aspect(), 1.0) * (9.0 - fi * 2.5);
    p.y -= t * (0.6 + fi * 0.25);
    vec2 id = floor(p); vec2 f = fract(p) - 0.5;
    float h = hash12(id + fi * 13.0);
    if (h > u_strength * 0.6) continue;
    vec2 o = (hash22(id + fi) - 0.5) * 0.25;
    o.x += sin(t * 2.0 + h * 30.0) * 0.06;
    float s = 0.16 + 0.08 * hash12(id * 1.9);
    vec2 q = rot(sin(t * 1.5 + h * 9.0) * 0.3) * (f - o) / s;
    float m = 1.0 - smoothstep(-0.05, 0.05, heartF(q));
    vec3 col = mix(u_color, vec3(1.0), 0.1 + 0.2 * hash12(id + 2.0));
    col *= 0.85 + 0.25 * (1.0 - smoothstep(-0.4, 0.6, q.y + q.x * 0.3));
    c = over(c, col, m * (0.75 + 0.125 * fi));
  }
  outColor = c;
}`,
  'hue-cycle': `void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c); vec3 hsv = rgb2hsv(rgb);
  hsv.x = fract(hsv.x + u_time * rate() * 0.15);
  hsv.y = min(1.0, hsv.y * (1.0 + 0.3 * u_strength));
  outColor = repre(mix(rgb, hsv2rgb(hsv), u_strength), c.a);
}`,
  'color-strobe': `void main() {
  vec4 c = src(v_uv); vec3 rgb = unpre(c);
  float beat = u_time * (80.0 + u_speed * 100.0) / 60.0;
  float k = exp(-fract(beat) * 8.0);
  vec3 col = hue2rgb(fract(floor(beat) * 0.37));
  vec3 lit = mix(rgb, rgb * col * 1.6 + col * 0.25, k * u_strength);
  outColor = repre(mix(lit, lit * 0.6, (1.0 - k) * u_strength * 0.5), c.a);
}`,
  // ---- Frames and borders -------------------------------------------------
  'film-strip': `uniform float u_size;
void main() {
  float band = 0.07 + u_size * 0.08;
  vec2 uv = (v_uv - 0.5) / (1.0 - 2.0 * band) + 0.5;
  vec4 img = inside(uv) ? src(uv) : vec4(0.0);
  float hy = abs(v_uv.y - 0.5) - (0.5 - band * 0.5);
  float pitch = band * 1.1;
  float fx = mod(v_uv.x * aspect() + u_time * u_speed * 0.3, pitch) - pitch * 0.5;
  float sd = sdBox(vec2(fx, hy), vec2(pitch * 0.28, band * 0.26)) - band * 0.06;
  float hole = (1.0 - smoothstep(-0.002, 0.002, sd)) * step(0.5 - band, abs(v_uv.y - 0.5));
  vec4 film = vec4(mix(vec3(0.07, 0.06, 0.055), vec3(0.92, 0.9, 0.85), hole), 1.0);
  outColor = img + film * (1.0 - img.a);
}`,
  'instant-photo': `uniform float u_size; uniform vec3 u_color;
void main() {
  float m = 0.04 + u_size * 0.06;
  vec2 lo = vec2(m / aspect(), m * 3.0);
  vec2 hi = vec2(1.0 - m / aspect(), 1.0 - m);
  vec2 sz = hi - lo;
  vec2 uv = (v_uv - lo) / sz;
  float areaA = sz.x * aspect() / sz.y;
  vec2 k = areaA > aspect() ? vec2(1.0, aspect() / areaA) : vec2(areaA / aspect(), 1.0);
  vec2 dd = max(lo - v_uv, v_uv - hi);
  float outside = max(dd.x, dd.y);
  vec3 paper = u_color * (0.96 + 0.04 * vnoise(v_uv * vec2(aspect(), 1.0) * 180.0));
  if (outside > 0.0) { outColor = vec4(paper * (1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.01, outside))), 1.0); return; }
  vec4 img = src((uv - 0.5) * k + 0.5);
  vec3 rgb = unpre(img);
  rgb = mix(rgb, rgb * vec3(1.04, 1.0, 0.92) + 0.03, 0.6) * (1.0 - 0.25 * smoothstep(0.3, 0.75, length(uv - 0.5)));
  vec4 photo = repre(rgb, img.a);
  outColor = photo + vec4(0.08, 0.08, 0.09, 1.0) * (1.0 - photo.a);
}`,
  'rounded-frame': `uniform float u_size, u_radius; uniform vec3 u_color;
void main() {
  vec2 asp = vec2(aspect(), 1.0);
  float s = 1.0 - u_size * 0.3;
  vec2 p = (v_uv - 0.5) * asp;
  vec2 hb = 0.5 * asp * s;
  float r = u_radius * 0.12;
  float sd = sdBox(p, hb - r) - r;
  vec4 img = src((v_uv - 0.5) / s + 0.5) * (1.0 - smoothstep(-0.0015, 0.0015, sd));
  float shadow = (1.0 - smoothstep(-0.01, 0.05, sdBox(p + vec2(0.0, 0.012), hb - r) - r)) * 0.45;
  vec3 bg = u_color * (1.0 + 0.3 * (v_uv.y - 0.5)) * (1.0 - shadow);
  outColor = img + vec4(bg, 1.0) * (1.0 - img.a);
}`,
  viewfinder: `uniform vec3 u_color;
void main() {
  vec4 c = src(v_uv);
  float A = aspect();
  vec2 p = v_uv * vec2(A, 1.0);
  float lw = 0.0045; float m = 0.06; float L = 0.085;
  vec2 q = vec2(min(p.x, A - p.x), min(p.y, 1.0 - p.y)) - m;
  float ink = max(step(abs(q.x), lw) * step(-lw, q.y) * step(q.y, L), step(abs(q.y), lw) * step(-lw, q.x) * step(q.x, L));
  vec2 cc = p - vec2(0.5 * A, 0.5);
  ink = max(ink, step(abs(cc.x), lw * 0.6) * step(abs(cc.y), 0.03));
  ink = max(ink, step(abs(cc.y), lw * 0.6) * step(abs(cc.x), 0.03));
  float grid = max(step(abs(p.x - A / 3.0), 0.0012), step(abs(p.x - 2.0 * A / 3.0), 0.0012));
  grid = max(grid, max(step(abs(p.y - 1.0 / 3.0), 0.0012), step(abs(p.y - 2.0 / 3.0), 0.0012)));
  float rec = (1.0 - smoothstep(0.014, 0.017, length(p - vec2(m + 0.04, 1.0 - m - 0.04)))) * step(0.5, fract(u_time));
  vec2 bp = p - vec2(A - m - 0.08, 1.0 - m - 0.04);
  float bat = step(abs(sdBox(bp, vec2(0.035, 0.016))), lw * 0.7);
  bat = max(bat, step(sdBox(bp - vec2(0.041, 0.0), vec2(0.004, 0.007)), 0.0));
  bat = max(bat, step(sdBox(bp - vec2(-0.008, 0.0), vec2(0.022, 0.009)), 0.0));
  vec4 o = c;
  o.rgb *= 1.0 - 0.15 * u_strength * smoothstep(0.4, 0.9, length((v_uv - 0.5) * 2.0));
  o = over(o, u_color, max(ink, bat) * u_strength * 0.95);
  o = over(o, u_color, grid * u_strength * 0.25);
  outColor = over(o, vec3(1.0, 0.15, 0.12), rec * u_strength);
}`,
  'neon-border': `uniform float u_size; uniform vec3 u_color;
void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 p = (v_uv - 0.5) * asp;
  float r = 0.04;
  float sd = sdBox(p, 0.5 * asp - 0.04 - r) - r;
  float w = 0.0015 + u_size * 0.006;
  float line = 1.0 - smoothstep(w * 0.5, w, abs(sd));
  float glow = exp(-abs(sd) / (0.01 + u_size * 0.03));
  float chase = 0.75 + 0.25 * sin((atan(p.y, p.x) / TAU - u_time * u_speed * 0.5) * TAU * 3.0);
  c.rgb *= mix(1.0, 0.6, smoothstep(0.0, 0.02, sd));
  outColor = vec4(c.rgb + mix(u_color, vec3(1.0), line * 0.6) * (line + glow * 0.7) * chase, max(c.a, line));
}`,
  'blur-fill': `uniform float u_size;
void main() {
  float s = 1.0 - u_size * 0.5;
  vec2 uv = (v_uv - 0.5) / s + 0.5;
  vec2 bu = (v_uv - 0.5) * 0.82 + 0.5;
  vec2 r = vec2(1.0 / aspect(), 1.0) * 0.04;
  vec4 bg = vec4(0.0); float j = hash12(v_uv * u_res) * TAU;
  for (int i = 0; i < 40; i++) { float a = float(i) * 2.39996323 + j; float d = sqrt((float(i) + 0.5) / 40.0); bg += src(bu + vec2(cos(a), sin(a)) * d * r); }
  bg /= 40.0;
  bg.rgb *= 0.65 * (1.0 - (1.0 - smoothstep(0.0, 0.03, sdBox(v_uv - 0.5 + vec2(0.0, 0.006), vec2(0.5 * s)))) * 0.35);
  vec4 fg = inside(uv) ? src(uv) : vec4(0.0);
  outColor = fg + bg * (1.0 - fg.a);
}`,
  // ---- Weather and particles ----------------------------------------------
  snow: `uniform float u_size;
void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(aspect(), 1.0);
  float acc = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float sc = (4.0 + fi * 2.7) / (0.5 + u_size);
    float t = u_time * (0.15 + u_speed * 0.9) * (1.2 - fi * 0.18);
    vec2 p = v_uv * asp * sc;
    p.y += t * sc * 0.35;
    p.x += sin(t * 1.3 + p.y * 0.7 + fi) * 0.3;
    vec2 id = floor(p); vec2 f = fract(p) - 0.5;
    float h = hash12(id + fi * 17.0);
    if (h > u_strength * 0.75) continue;
    vec2 o = (hash22(id + fi) - 0.5) * 0.6;
    float r = (0.05 + 0.06 * hash12(id * 3.1)) * (1.4 - fi * 0.25);
    acc += (1.0 - smoothstep(r * 0.2, r, length(f - o))) * (1.0 - fi * 0.15);
  }
  c.rgb = mix(c.rgb, c.rgb * vec3(0.93, 0.97, 1.06), u_strength * 0.5);
  outColor = over(c, vec3(1.0), clamp(acc, 0.0, 1.0) * 0.92);
}`,
  rain: `uniform float u_angle;
void main() {
  vec4 c = src(v_uv);
  vec2 p0 = rot(radians(u_angle)) * (v_uv * vec2(aspect(), 1.0));
  float acc = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 sc = vec2(60.0 + fi * 40.0, 3.0 + fi * 2.0);
    vec2 p = p0 * sc;
    p.y += u_time * (1.5 + u_speed * 4.5) * (1.0 - fi * 0.2) * sc.y;
    vec2 id = floor(p); vec2 f = fract(p);
    if (hash12(id + fi * 7.0) > u_strength * 0.6) continue;
    float len = 0.25 + 0.3 * hash12(id + 5.0);
    float streak = (1.0 - smoothstep(0.0, len, fract(f.y - hash12(id + 3.0)))) * (1.0 - smoothstep(0.05, 0.2, abs(f.x - 0.5)));
    acc += streak * (0.5 - fi * 0.12);
  }
  c.rgb *= mix(1.0, 0.82, u_strength);
  c.rgb = mix(c.rgb, c.rgb * vec3(0.92, 0.97, 1.05), u_strength);
  outColor = over(c, vec3(0.85, 0.9, 0.97), clamp(acc * 1.6, 0.0, 1.0) * 0.75);
}`,
  fog: `uniform vec3 u_color;
void main() {
  vec4 c = src(v_uv);
  float t = u_time * (0.05 + u_speed * 0.4);
  vec2 q = v_uv * vec2(aspect(), 1.0) * 2.5;
  float n = fbm(q + vec2(t, t * 0.3));
  n = fbm(q + n * 1.5 + vec2(-t * 0.6, 0.0));
  float f = clamp(smoothstep(0.25, 0.85, n) * u_strength * 1.1 * mix(1.0, 0.55, v_uv.y) + u_strength * 0.12, 0.0, 0.92);
  outColor = over(c, u_color, f);
}`,
  fireflies: `uniform vec3 u_color;
void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(aspect(), 1.0);
  float t = u_time * (0.2 + u_speed);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    vec2 p = v_uv * asp * (5.0 + fi * 4.0);
    vec2 id = floor(p);
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 cid = id + vec2(float(x), float(y));
      float h = hash12(cid + fi * 11.0);
      if (h > u_strength * 0.8) continue;
      vec2 pos = cid + 0.5 + vec2(sin(t * (0.5 + h) + h * 30.0), cos(t * (0.4 + h * 0.7) + h * 50.0)) * 0.45;
      float d = length(p - pos);
      float blink = smoothstep(0.2, 1.0, 0.5 + 0.5 * sin(t * (2.0 + h * 3.0) + h * 70.0));
      light += u_color * ((1.0 - smoothstep(0.0, 0.06, d)) * 1.2 + exp(-d * 9.0) * 0.35) * blink;
    }
  }
  outColor = vec4(c.rgb * (1.0 - 0.15 * u_strength) + light, c.a);
}`,
  embers: `void main() {
  vec4 c = src(v_uv);
  vec2 asp = vec2(aspect(), 1.0);
  float t = u_time * (0.2 + u_speed * 1.5);
  vec3 light = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = v_uv * asp * (6.0 + fi * 5.0);
    p.y -= t * (1.0 + fi * 0.4) * 1.2;
    p.x += sin(p.y * 0.8 + t + fi) * 0.25;
    vec2 id = floor(p); vec2 f = fract(p) - 0.5;
    float h = hash12(id + fi * 5.0);
    if (h > u_strength * 0.55) continue;
    vec2 q = f - (hash22(id + fi) - 0.5) * 0.6;
    q.y *= 0.45;
    float d = length(q);
    vec3 col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.85, 0.4), hash12(id * 1.3));
    light += col * ((1.0 - smoothstep(0.0, 0.05, d)) + exp(-d * 18.0) * 0.4) * (0.6 + 0.4 * sin(t * 9.0 + h * 40.0)) * (1.0 - fi * 0.25);
  }
  float heat = (1.0 - smoothstep(0.0, 0.5, v_uv.y)) * 0.25 * u_strength;
  outColor = vec4(c.rgb + light + vec3(1.0, 0.4, 0.1) * heat * c.a, c.a);
}`,
};

/** Helpers shared by the transition bodies. */
export const TR_LIB = `
const float PI = 3.14159265;
const float TAU = 6.28318531;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 Ac(vec2 uv) { return texture(u_from, clamp(uv, 0.0, 1.0)); }
vec4 Bc(vec2 uv) { return texture(u_to, clamp(uv, 0.0, 1.0)); }
bool inside(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
float easeIn(float p) { return p * p * p; }
float easeOut(float p) { float q = 1.0 - p; return 1.0 - q * q * q; }
// Pulls back a little, then overshoots and settles.
float backInOut(float p) {
  float c = 1.70158 * 1.525;
  if (p < 0.5) { float x = 2.0 * p; return x * x * ((c + 1.0) * x - c) / 2.0; }
  float x = 2.0 * p - 2.0; return (x * x * ((c + 1.0) * x + c) + 2.0) / 2.0;
}
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; } return s / 0.9375; }
mat2 rot(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
`;

export const EXTRA_TRANSITION_SHADERS = {
  // ---- Basic -------------------------------------------------------------
  'luma-fade': `void main() {
  vec4 a = A(v_uv); vec4 b = B(v_uv);
  float r = (1.0 - luma(b.a > 0.0 ? b.rgb / b.a : b.rgb)) * 0.7;
  outColor = mix(a, b, smoothstep(r, r + 0.3, ease(u_progress)));
}`,
  'noise-dissolve': `void main() {
  float n = vnoise(v_uv * vec2(aspect(), 1.0) * 7.0) * 0.65 + hash12(floor(v_uv * u_res * 0.5)) * 0.35;
  float m = smoothstep(n * 0.8, n * 0.8 + 0.2, u_progress);
  vec4 c = mix(A(v_uv), B(v_uv), m);
  outColor = vec4(c.rgb + smoothstep(0.0, 0.5, m) * (1.0 - smoothstep(0.5, 1.0, m)) * 0.35 * c.a, c.a);
}`,
  // ---- Slide and push -----------------------------------------------------
  'cover-left': `void main() {
  float p = ease(u_progress); float x0 = 1.0 - p;
  if (v_uv.x >= x0) { outColor = B(v_uv - vec2(x0, 0.0)); return; }
  vec4 a = A(v_uv);
  float sh = exp(-(x0 - v_uv.x) * 40.0) * 0.5 * step(0.001, p);
  outColor = vec4(a.rgb * (1.0 - 0.35 * p) * (1.0 - sh), a.a);
}`,
  'reveal-right': `void main() {
  float p = ease(u_progress);
  if (v_uv.x >= p) { outColor = A(v_uv - vec2(p, 0.0)); return; }
  vec4 b = B(v_uv);
  float sh = exp(-(p - v_uv.x) * 40.0) * 0.5 * step(p, 0.999);
  outColor = vec4(b.rgb * (0.65 + 0.35 * p) * (1.0 - sh), b.a);
}`,
  'bounce-push': `void main() {
  vec2 uv = v_uv + vec2(backInOut(u_progress), 0.0);
  outColor = uv.x < 1.0 ? Ac(uv) : Bc(uv - vec2(1.0, 0.0));
}`,
  'corner-slide': `void main() {
  float p = ease(u_progress);
  vec2 uv = v_uv - vec2(1.0 - p);
  if (uv.x >= 0.0 && uv.y >= 0.0) { outColor = B(uv); return; }
  vec4 a = A(v_uv);
  float d = max(-uv.x, -uv.y);
  float sh = exp(-d * 40.0) * 0.5 * step(0.001, p);
  outColor = vec4(a.rgb * (1.0 - 0.35 * p) * (1.0 - sh), a.a);
}`,
  stripes: `void main() {
  float n = 8.0;
  float id = floor(v_uv.y * n);
  float p = ease(clamp((u_progress - id / (n - 1.0) * 0.35) / 0.65, 0.0, 1.0));
  float dir = mod(id, 2.0) < 0.5 ? 1.0 : -1.0;
  vec2 uv = v_uv - vec2(dir * (1.0 - p), 0.0);
  outColor = (uv.x >= 0.0 && uv.x <= 1.0) ? B(uv) : A(v_uv);
}`,
  // ---- Wipe and shape -----------------------------------------------------
  'diagonal-wipe': `void main() {
  float d = (v_uv.x * aspect() + (1.0 - v_uv.y)) / (aspect() + 1.0);
  float p = ease(u_progress) * 1.1 - 0.05;
  vec4 c = mix(A(v_uv), B(v_uv), smoothstep(d - 0.03, d + 0.03, p));
  float line = (1.0 - smoothstep(0.0, 0.012, abs(d - p))) * step(0.01, u_progress) * step(u_progress, 0.99);
  outColor = vec4(c.rgb + line * 0.4 * c.a, c.a);
}`,
  'heart-iris': `float heartF(vec2 p) { p.y += 0.15; float a = p.x * p.x + p.y * p.y - 1.0; return a * a * a - p.x * p.x * p.y * p.y * p.y; }
void main() {
  vec2 p = (v_uv - 0.5) * vec2(aspect(), 1.0);
  float s = ease(u_progress) * 3.2 + 1e-3;
  float m = 1.0 - smoothstep(-0.02, 0.02, heartF(p / s * 2.0));
  outColor = mix(A(v_uv), B(v_uv), m);
}`,
  'star-iris': `float starF(vec2 p) {
  float seg = TAU / 5.0;
  float k = abs(mod(atan(p.x, p.y), seg) - seg * 0.5) / (seg * 0.5);
  return length(p) / mix(0.45, 1.0, k);
}
void main() {
  float e = ease(u_progress);
  vec2 p = rot(e * 1.2) * ((v_uv - 0.5) * vec2(aspect(), 1.0));
  float m = 1.0 - smoothstep(0.97, 1.03, starF(p / (e * 2.6 + 1e-3)));
  outColor = mix(A(v_uv), B(v_uv), m);
}`,
  checker: `void main() {
  float ny = 6.0; float nx = floor(ny * aspect() + 0.5);
  vec2 g = v_uv * vec2(nx, ny); vec2 id = floor(g); vec2 f = fract(g) - 0.5;
  float d = (id.x + id.y) / (nx + ny) * 0.5 + hash12(id) * 0.1;
  float p = ease(clamp((u_progress - d) / 0.4, 0.0, 1.0));
  outColor = mix(A(v_uv), B(v_uv), step(max(abs(f.x), abs(f.y)), p * 0.5 + 1e-4) * step(0.0001, p));
}`,
  'fan-wipe': `void main() {
  vec2 p = (v_uv - 0.5) * vec2(aspect(), 1.0);
  float f = fract((atan(p.y, p.x) / TAU + 0.5) * 4.0);
  outColor = mix(A(v_uv), B(v_uv), smoothstep(f - 0.01, f + 0.01, ease(u_progress) * 1.03 - 0.015));
}`,
  'wave-wipe': `void main() {
  float edge = ease(u_progress) * 1.3 - 0.15 + sin(v_uv.y * 14.0 + u_progress * 8.0) * 0.05;
  outColor = mix(A(v_uv), B(v_uv), smoothstep(v_uv.x - 0.015, v_uv.x + 0.015, edge));
}`,
  // ---- Zoom and spin ------------------------------------------------------
  'zoom-punch': `void main() {
  float p = u_progress; float s = sin(p * PI); float e = ease(p);
  vec2 c = v_uv - 0.5;
  float zA = 1.0 + e * 0.8; float zB = 1.0 + (1.0 - e) * 0.8;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float k = 1.0 - s * 0.25 * float(i) / 11.0;
    acc += p < 0.5 ? Ac(c * k / zA + 0.5) : Bc(c * k / zB + 0.5);
  }
  acc /= 12.0;
  outColor = vec4(acc.rgb + s * s * s * s * 0.25 * acc.a, acc.a);
}`,
  twist: `void main() {
  float p = u_progress; float s = sin(p * PI);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 q = (v_uv - 0.5) * asp;
  float ang = s * s * 7.0 * (1.0 - smoothstep(0.0, 0.9, length(q)));
  outColor = mix(Ac(rot(ang) * q / asp + 0.5), Bc(rot(-ang) * q / asp + 0.5), smoothstep(0.4, 0.6, p));
}`,
  roll: `void main() {
  float p = ease(u_progress);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 q = (v_uv - 0.5) * asp;
  vec2 qa = rot(-p * PI * 0.5) * q * (1.0 + p * 1.2);
  vec2 qb = rot((1.0 - p) * PI * 0.5) * q * (1.0 + (1.0 - p) * 1.2);
  outColor = mix(A(qa / asp + 0.5), B(qb / asp + 0.5), smoothstep(0.3, 0.7, u_progress));
}`,
  // ---- Light and flash ----------------------------------------------------
  'light-sweep': `void main() {
  float d = (v_uv.x * aspect() + v_uv.y * 0.6) / (aspect() + 0.6);
  float x = ease(u_progress) * 1.5 - 0.25;
  vec4 c = mix(A(v_uv), B(v_uv), smoothstep(x + 0.04, x - 0.04, d));
  float k = (d - x) / 0.07;
  float band = exp(-k * k);
  outColor = vec4(c.rgb + vec3(1.0, 0.97, 0.9) * band * 1.1, max(c.a, band));
}`,
  'film-burn': `void main() {
  float v = fbm(v_uv * vec2(aspect(), 1.0) * 2.5 + 3.0);
  float d = ease(u_progress) * 1.5 - 0.25 - v;
  float glow = exp(-abs(d - 0.05) * 25.0);
  float s = sin(u_progress * PI);
  vec4 c = mix(A(v_uv), B(v_uv), smoothstep(0.0, 0.15, d));
  vec3 hot = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.9, 0.6), glow);
  outColor = vec4(c.rgb + hot * glow * 1.4 * s + vec3(1.0, 0.6, 0.25) * s * s * 0.25, c.a);
}`,
  'flare-pass': `void main() {
  float p = u_progress; float s = sin(p * PI);
  vec4 c = mix(A(v_uv), B(v_uv), smoothstep(0.42, 0.58, p));
  vec2 d = (v_uv - vec2(mix(-0.1, 1.1, ease(p)), 0.55)) * vec2(aspect(), 1.0);
  float core = 0.02 / (length(d) + 0.02);
  float streak = exp(-abs(d.y) * 70.0) * exp(-abs(d.x) * 1.2);
  vec3 f = vec3(1.0, 0.95, 0.85) * core * 0.6 + vec3(0.55, 0.75, 1.0) * streak * 0.9;
  outColor = vec4(c.rgb * (1.0 + s * s * 0.5) + f * s + s * s * s * 0.15, c.a);
}`,
  // ---- Glitch and distort -------------------------------------------------
  'channel-tear': `void main() {
  float p = u_progress; float s = sin(p * PI);
  float t = floor(p * 14.0);
  vec2 uv = v_uv + vec2(0.0, (hash11(floor(v_uv.x * 18.0) + t * 3.1) - 0.5) * 0.25 * s);
  vec2 o = vec2(0.02 * s, 0.0);
  vec4 r = p < 0.42 ? Ac(uv + o) : Bc(uv + o);
  vec4 g = p < 0.5 ? Ac(uv) : Bc(uv);
  vec4 b = p < 0.58 ? Ac(uv - o) : Bc(uv - o);
  outColor = vec4(r.r, g.g, b.b, g.a);
}`,
  melt: `void main() {
  float n = vnoise(vec2(v_uv.x * 18.0, 0.5)) * 0.6 + hash11(floor(v_uv.x * 120.0)) * 0.15;
  float y = v_uv.y + easeIn(u_progress) * (1.0 + n * 1.5) * 1.1;
  outColor = y > 1.0 ? B(v_uv) : A(vec2(v_uv.x, y));
}`,
  shatter: `void main() {
  vec2 asp = vec2(aspect(), 1.0);
  vec2 g = v_uv * asp * 5.0; vec2 id = floor(g);
  float best = 9.0; float second = 9.0; vec2 cell = id;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = id + vec2(float(x), float(y));
    float d = length(g - c - hash22(c));
    if (d < best) { second = best; best = d; cell = c; } else if (d < second) second = d;
  }
  float q = clamp((u_progress - hash12(cell * 1.3) * 0.5) / 0.5, 0.0, 1.0);
  q *= q;
  vec2 vel = (hash22(cell * 2.7) - 0.5) * vec2(0.6, 0.3) + vec2(0.0, -0.9);
  vec4 a = A(v_uv - vel * q / asp) * (1.0 - q);
  float crack = (1.0 - smoothstep(0.0, 0.04, second - best)) * step(0.001, u_progress) * (1.0 - q);
  a.rgb = mix(a.rgb, vec3(0.9) * a.a, crack * 0.6);
  outColor = a + B(v_uv) * (1.0 - a.a);
}`,
  'wave-warp': `void main() {
  float p = u_progress; float s = sin(p * PI);
  vec2 uv = v_uv + vec2(sin(v_uv.y * 22.0 + p * 12.0) * 0.045, cos(v_uv.x * 16.0 + p * 9.0) * 0.03) * s;
  outColor = mix(Ac(uv), Bc(uv), smoothstep(0.3, 0.7, p));
}`,
  // ---- 3D ----------------------------------------------------------------
  cube: `void main() {
  float th = ease(u_progress) * PI * 0.5;
  vec2 sp = (v_uv - 0.5) * (1.0 + 0.35 * sin(u_progress * PI));
  float D = 2.2;
  vec3 o = vec3(0.0, 0.0, -D); vec3 d = vec3(sp, D); vec3 nd = normalize(d);
  float cs = cos(th); float sn = sin(th);
  vec3 piv = vec3(0.0, 0.0, 0.5);
  vec3 cA = piv + vec3(-0.5 * sn, 0.0, -0.5 * cs); vec3 nA = vec3(-sn, 0.0, -cs); vec3 tA = vec3(cs, 0.0, -sn);
  vec3 cB = piv + vec3(0.5 * cs, 0.0, -0.5 * sn); vec3 nB = vec3(cs, 0.0, -sn); vec3 tB = vec3(sn, 0.0, cs);
  vec4 col = vec4(0.0); float best = 1e9;
  float dn = dot(d, nA);
  if (dn < 0.0) {
    float t = dot(cA - o, nA) / dn; vec3 h = o + d * t;
    vec2 uv = vec2(dot(h - cA, tA) + 0.5, h.y + 0.5);
    if (t > 0.0 && inside(uv)) { vec4 a = A(uv); col = vec4(a.rgb * (0.45 + 0.55 * -dot(nd, nA)), a.a); best = t; }
  }
  dn = dot(d, nB);
  if (dn < 0.0) {
    float t = dot(cB - o, nB) / dn; vec3 h = o + d * t;
    vec2 uv = vec2(dot(h - cB, tB) + 0.5, h.y + 0.5);
    if (t > 0.0 && t < best && inside(uv)) { vec4 b = B(uv); col = vec4(b.rgb * (0.45 + 0.55 * -dot(nd, nB)), b.a); }
  }
  outColor = col;
}`,
  'card-flip': `void main() {
  float th = ease(u_progress) * PI;
  vec2 sp = (v_uv - 0.5) * (1.0 + 0.3 * sin(u_progress * PI));
  float D = 2.5;
  vec3 o = vec3(0.0, 0.0, -D); vec3 d = vec3(sp, D);
  vec3 n = vec3(-sin(th), 0.0, -cos(th)); vec3 t = vec3(cos(th), 0.0, -sin(th));
  float dn = dot(d, n);
  if (abs(dn) < 1e-5) { outColor = vec4(0.0); return; }
  vec3 h = o + d * (dot(-o, n) / dn);
  vec2 uv = vec2(dot(h, t) + 0.5, h.y + 0.5);
  if (!inside(uv)) { outColor = vec4(0.0); return; }
  float shade = 0.5 + 0.5 * abs(dot(normalize(d), n));
  vec4 c = dn < 0.0 ? A(uv) : B(vec2(1.0 - uv.x, uv.y));
  outColor = vec4(c.rgb * shade, c.a);
}`,
  'page-turn': `void main() {
  float asp = aspect();
  vec2 P = vec2(v_uv.x * asp, v_uv.y);
  vec2 corner = vec2(asp, 0.0);
  vec2 dir = normalize(vec2(-1.0, 0.5));
  float L = max(dot(vec2(0.0, 1.0) - corner, dir), dot(-corner, dir));
  float R = 0.1;
  float f = ease(u_progress) * (L + PI * R + 0.02) - 0.01;
  float x = dot(P - corner, dir);
  vec4 b = B(v_uv);
  if (x > f) {
    float ub = 2.0 * f - PI * R - x;
    vec2 Q = P + dir * (ub - x); vec2 bu = vec2(Q.x / asp, Q.y);
    if (inside(bu)) { vec4 a = A(bu); outColor = vec4(mix(a.rgb, vec3(0.94) * a.a, 0.7), a.a); return; }
    vec4 a = A(v_uv);
    outColor = vec4(a.rgb * (1.0 - 0.25 * exp(-(x - f) * 30.0) * step(0.001, u_progress)), a.a);
    return;
  }
  if (x > f - R) {
    float s1 = asin(clamp((f - x) / R, -1.0, 1.0));
    float u2 = f - R * (PI - s1);
    vec2 Q = P + dir * (u2 - x); vec2 uv2 = vec2(Q.x / asp, Q.y);
    if (inside(uv2)) { vec4 a = A(uv2); outColor = vec4(mix(a.rgb, vec3(0.94) * a.a, 0.7) * (0.75 + 0.25 * sin(s1)), a.a); return; }
    float u1 = f - R * s1;
    Q = P + dir * (u1 - x); vec2 uv1 = vec2(Q.x / asp, Q.y);
    if (inside(uv1)) { vec4 a = A(uv1); outColor = vec4(a.rgb * (0.65 + 0.35 * cos(s1)), a.a); return; }
  }
  float sh = 0.45 * exp(-max(0.0, f - R - x) * 18.0) * step(0.001, u_progress);
  outColor = vec4(b.rgb * (1.0 - sh), b.a);
}`,
  'swing-door': `void main() {
  float p = ease(u_progress);
  float th = p * 1.45;
  float D = 2.0;
  vec3 o = vec3(0.0, 0.0, -D); vec3 d = vec3(v_uv - 0.5, D);
  vec3 hinge = vec3(-0.5, 0.0, 0.0);
  vec3 t = vec3(cos(th), 0.0, -sin(th)); vec3 n = vec3(-sin(th), 0.0, -cos(th));
  vec4 b = B(v_uv); b.rgb *= 0.6 + 0.4 * p;
  float dn = dot(d, n);
  if (dn < -1e-5) {
    float k = dot(hinge - o, n) / dn; vec3 h = o + d * k;
    vec2 uv = vec2(dot(h - hinge, t), h.y + 0.5);
    if (k > 0.0 && inside(uv)) {
      vec4 a = A(uv) * (1.0 - smoothstep(0.85, 1.0, u_progress));
      outColor = vec4(a.rgb * (0.5 + 0.5 * -dot(normalize(d), n)), a.a) + b * (1.0 - a.a);
      return;
    }
  }
  outColor = b;
}`,
  // ---- Blur --------------------------------------------------------------
  'whip-pan': `vec4 pushAt(vec2 uv, float off) { vec2 q = uv + vec2(off, 0.0); return q.x < 1.0 ? Ac(q) : Bc(q - vec2(1.0, 0.0)); }
void main() {
  float off = ease(u_progress); float s = sin(u_progress * PI);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) acc += pushAt(v_uv, off + (float(i) / 15.0 - 0.5) * 0.25 * s);
  outColor = acc / 16.0;
}`,
  'focus-pull': `void main() {
  float p = u_progress; float s = sin(p * PI);
  vec2 r = vec2(1.0 / aspect(), 1.0) * 0.035 * s;
  float j = hash12(v_uv * u_res) * TAU;
  vec4 a = vec4(0.0); vec4 b = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float ang = float(i) * 2.39996323 + j; float d = sqrt((float(i) + 0.5) / 24.0);
    vec2 o = vec2(cos(ang), sin(ang)) * d * r;
    a += Ac(v_uv + o); b += Bc(v_uv + o);
  }
  outColor = mix(a, b, smoothstep(0.3, 0.7, p)) / 24.0;
}`,
  'spin-smear': `void main() {
  float p = ease(u_progress); float s = sin(u_progress * PI);
  vec2 asp = vec2(aspect(), 1.0);
  vec2 q = (v_uv - 0.5) * asp * (1.0 - 0.35 * s);
  float base = u_progress < 0.5 ? p * PI : (p - 1.0) * PI;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    vec2 r = rot(base + (float(i) / 15.0 - 0.5) * 0.6 * s) * q / asp + 0.5;
    acc += u_progress < 0.5 ? Ac(r) : Bc(r);
  }
  outColor = acc / 16.0;
}`,
};
