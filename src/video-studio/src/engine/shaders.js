/**
 * GLSL ES 3.00 sources. All shaders are original. Effects and transitions
 * are compiled lazily, one small program per id, so only looks in use cost
 * anything.
 */
import { FX_LIB, TR_LIB, EXTRA_EFFECT_SHADERS, EXTRA_TRANSITION_SHADERS } from './effects-extra.js';
import { BODY_EFFECT_SHADERS } from './body-effects.js';

export const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;   // unit quad (-0.5..0.5) to clip space
uniform vec4 u_uvRect;   // x, y, w, h of the sampled region
uniform vec2 u_flip;
out vec2 v_uv;
out vec2 v_quad;
void main() {
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vec2 q = a_pos + 0.5;
  v_quad = q;
  q = mix(q, 1.0 - q, u_flip);
  v_uv = u_uvRect.xy + q * u_uvRect.zw;
}`;

export const FULL_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos + 0.5;
  gl_Position = vec4(a_pos * 2.0, 0.0, 1.0);
}`;

/**
 * Shared color grading used by layers, filter clips and adjustment clips.
 * Order: clarity, light (exposure .. brilliance), white balance, color
 * wheels, HSL, saturation and vibrance, curves, LUT, then the filter look
 * (mono, split toning), fade, vignette and grain. The optional stages are
 * switched by integer uniforms so ungraded clips skip them.
 */
const COLOR_FN = `
uniform float u_brightness, u_contrast, u_saturation, u_exposure, u_temperature, u_tint;
uniform float u_highlights, u_shadows, u_fade, u_vignette, u_grain, u_sharpen, u_mono;
uniform float u_vibrance, u_whites, u_blacks, u_brilliance, u_clarity;
uniform vec3 u_shadowTint, u_highlightTint;
uniform float u_splitAmount, u_time;
uniform int u_hslOn;
uniform vec3 u_hsl[8];          // per hue range: hue shift (degrees), saturation, value
uniform int u_wheelsOn;
uniform vec3 u_lift, u_gamma, u_gain, u_offset;
uniform int u_curvesOn;
uniform sampler2D u_curves;     // 256 x 1: master, red, green, blue lookups
uniform int u_lutOn;
uniform mediump sampler3D u_lut;
uniform float u_lutSize, u_lutMix;
uniform vec3 u_lutMin, u_lutMax;
float g_local = -1.0;           // neighborhood luma for clarity, set by main()
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 toHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
  }
  return vec3(h / 6.0, mx > 0.0 ? d / mx : 0.0, mx);
}
vec3 fromHsv(vec3 c) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + c.x * 6.0, 6.0);
  return c.z - c.z * c.y * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
const float HUE_AT[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 220.0, 270.0, 310.0, 360.0);
vec3 hslRanges(vec3 c) {
  vec3 hsv = toHsv(clamp(c, 0.0, 1.0));
  float h = hsv.x * 360.0;
  vec3 adj = vec3(0.0);
  // Neighboring ranges blend smoothly: full strength at a range's center, none at the next center.
  for (int i = 0; i < 8; i++) {
    if (h <= HUE_AT[i + 1]) {
      float t = (h - HUE_AT[i]) / (HUE_AT[i + 1] - HUE_AT[i]);
      t = t * t * (3.0 - 2.0 * t);
      adj = mix(u_hsl[i], u_hsl[(i + 1) % 8], t);
      break;
    }
  }
  float w = smoothstep(0.02, 0.2, hsv.y); // greys stay put
  hsv.x = fract(hsv.x + adj.x * w / 360.0 + 1.0);
  hsv.y = clamp(hsv.y * (1.0 + adj.y * w), 0.0, 1.0);
  hsv.z = max(0.0, hsv.z * (1.0 + adj.z * w));
  return fromHsv(hsv);
}
vec4 curveTap(float x) { return texture(u_curves, vec2(clamp(x, 0.0, 1.0) * 0.99609375 + 0.001953125, 0.5)); }
vec3 curves(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float l = luma(c);
  c = clamp(c + (curveTap(l).r - l), 0.0, 1.0);
  return vec3(curveTap(c.r).g, curveTap(c.g).b, curveTap(c.b).a);
}
vec3 wheels(vec3 c) {
  c += u_lift * (1.0 - clamp(c, 0.0, 1.0));
  c *= 1.0 + u_gain;
  c = pow(max(c, 0.0), 1.0 / max(1.0 + u_gamma, vec3(0.05)));
  return c + u_offset;
}
vec3 lookup(vec3 c) {
  vec3 x = clamp((c - u_lutMin) / (u_lutMax - u_lutMin), 0.0, 1.0);
  vec3 uvw = x * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
  return mix(c, texture(u_lut, uvw).rgb, u_lutMix);
}
vec3 grade(vec3 c, vec2 uv, vec2 px) {
  if (u_clarity != 0.0 && g_local >= 0.0) {
    float l0 = clamp(luma(c), 0.0, 1.0);
    c += (l0 - g_local) * u_clarity * 0.012 * (0.35 + 0.65 * (1.0 - abs(l0 * 2.0 - 1.0)));
  }
  c *= exp2(u_exposure * 0.015);
  c += u_brightness * 0.0025;
  c = (c - 0.5) * (1.0 + u_contrast * 0.01) + 0.5;
  float l = luma(c);
  c += u_shadows * 0.003 * (1.0 - smoothstep(0.0, 0.55, l));
  c += u_highlights * 0.003 * smoothstep(0.45, 1.0, l);
  if (u_whites != 0.0 || u_blacks != 0.0) {
    l = luma(c);
    c += u_whites * 0.0035 * smoothstep(0.5, 1.05, l);
    c += u_blacks * 0.003 * (1.0 - smoothstep(-0.05, 0.4, l));
  }
  if (u_brilliance != 0.0) {
    l = clamp(luma(c), 0.0, 1.0);
    float b = u_brilliance * 0.01;
    c += b * (0.28 * smoothstep(0.0, 0.45, l) * (1.0 - l) - 0.12 * smoothstep(0.65, 1.0, l));
    c = mix(vec3(luma(c)), c, 1.0 + b * 0.12);
  }
  c.r += u_temperature * 0.0011; c.b -= u_temperature * 0.0011;
  c.g -= u_tint * 0.0009; c.r += u_tint * 0.0003; c.b += u_tint * 0.0003;
  if (u_wheelsOn == 1) c = wheels(c);
  if (u_hslOn == 1) c = hslRanges(c);
  l = luma(c);
  c = mix(vec3(l), c, max(0.0, 1.0 + u_saturation * 0.01));
  if (u_vibrance != 0.0) {
    float s = clamp(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), 0.0, 1.0);
    c = mix(vec3(l), c, max(0.0, 1.0 + u_vibrance * 0.012 * (1.0 - s)));
  }
  if (u_curvesOn == 1) c = curves(c);
  if (u_lutOn == 1) c = lookup(c);
  if (u_curvesOn == 1 || u_lutOn == 1) l = luma(c);
  c = mix(c, vec3(l), u_mono);
  if (u_splitAmount > 0.0) {
    l = clamp(luma(c), 0.0, 1.0);
    vec3 sh = mix(c, u_shadowTint * (l * 2.0 + 0.2), (1.0 - l) * u_splitAmount);
    c = mix(sh, mix(sh, u_highlightTint * (l + 0.15), l * u_splitAmount), l);
  }
  c = mix(c, c * 0.82 + 0.13, clamp(u_fade * 0.01, -1.0, 1.0));
  if (u_vignette != 0.0) {
    float d = distance(uv, vec2(0.5));
    c *= 1.0 - u_vignette * 0.01 * smoothstep(0.25, 0.85, d) * 0.9;
  }
  if (u_grain > 0.0) c += (hash12(uv / px + fract(u_time) * 97.0) - 0.5) * u_grain * 0.0025;
  return clamp(c, 0.0, 1.0);
}
`;

/** GLSL for localLuma(uv): mean luma on two rings about 1.2% of the width out (clarity). sample(uv) returns straight RGB. */
const localLumaFn = (sample) => `
float localLuma(vec2 uv) {
  vec2 r = vec2(0.012, 0.012 * u_texel.y / u_texel.x);
  float s = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 1.0472 + (i < 6 ? 0.0 : 0.5236);
    s += luma(${sample}(uv + vec2(cos(a), sin(a)) * r * (i < 6 ? 0.5 : 1.0)));
  }
  return s / 12.0;
}`;

export const LAYER_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_quad;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec2 u_texel;
uniform float u_blur;
uniform int u_chroma;
uniform vec3 u_keyColor;
uniform float u_keyStrength, u_keySpill;
uniform int u_maskOn;        // clip masks, rasterized to a coverage texture (engine/mask-raster.js)
uniform sampler2D u_maskTex;
uniform int u_matteOn;       // person matte (engine/cutout.js): 1 = bound, 2 = not ready yet
uniform int u_cutOn;         // background removal keeps only the person
uniform sampler2D u_matteTex;
uniform int u_maskColor;     // 1: the clip's masks limit its color instead of cutting it
uniform int u_colorTarget;   // color only on: 0 everything, 1 the person, 2 the background
uniform int u_retouchOn;     // skin retouch (model/retouch.js)
uniform vec4 u_retouch;      // smooth, even, brighten, sharpen (0..1)
uniform vec2 u_matteTexel;
uniform vec2 u_matteWin;
uniform int u_premultiplied;
uniform vec2 u_srcSize;      // source size in pixels (face tools work in source pixels, y down)
uniform int u_warpFaces;     // face shape (engine/face-render.js): faces with warp handles, 0 = off
uniform highp sampler2D u_warpTex; // handles, one column each: (center, move), shape matrix, (scale)
uniform vec4 u_warpFace[3];  // per face: center, reach, first handle
uniform vec3 u_warpEnd;      // per face: one past its last handle
uniform int u_faceFixOn;     // skin fixes placed by face landmarks
uniform sampler2D u_faceMask; // R spot-free skin, G under the eyes, B lips, A inside the mouth
uniform vec4 u_faceMaskRect; // where the masks sit in source pixels
uniform vec4 u_faceFix;      // blemishes, dark circles, teeth, lips (0..1)
uniform vec3 u_lipColor;
uniform float u_spotR;       // spot search radius in source pixels
uniform int u_hairOn;        // hair color
uniform sampler2D u_hairTex; // hair matte (R) of the square u_hairRect (source pixels), rows top first
uniform vec4 u_hairRect;
uniform vec2 u_hairTexel;
uniform vec3 u_hairColor;
uniform float u_hairAmount, u_hairLuma;
uniform int u_bodyOn;        // body shape (engine/body-render.js)
uniform highp sampler2D u_bodyTex; // offset field on a grid over the source (source px, RG float, rows top first)
uniform int u_makeupOn;      // makeup placed by face landmarks
uniform sampler2D u_makeupMask; // R blush, G eyeshadow, B eyeliner, A brows
uniform sampler2D u_sculptMask; // R contour, G highlight
uniform vec4 u_makeupRect;   // where the makeup masks sit in source pixels
uniform vec4 u_makeup;       // blush, eyeshadow, eyeliner, brows (0..1)
uniform vec2 u_sculpt;       // contour, highlight (0..1)
uniform vec3 u_blushColor, u_shadowColor, u_linerColor, u_browColor, u_contourColor, u_glowColor;
out vec4 outColor;
${COLOR_FN}
vec4 tap(vec2 uv) {
  vec4 s = texture(u_tex, uv);
  if (u_premultiplied == 1 && s.a > 0.0) s.rgb /= s.a;
  return s;
}
vec3 tapRgb(vec2 uv) { return tap(uv).rgb; }
${localLumaFn('tapRgb')}
vec2 rgb2uv(vec3 c) { return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b); }
// Masks are drawn on the picture, so they are sampled at the source uv (crop and flip included).
float maskAlpha(vec2 uv) {
  if (u_maskOn == 0) return 1.0;
  return texture(u_maskTex, uv).a;
}
// The matte is coarse, so each pixel takes it from nearby matte samples that
// look like it in the full picture (joint bilateral upsampling): edges snap
// to hair and shoulders instead of the matte's own blocky outline.
float matteRefined(vec2 uv, vec3 rgb) {
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    vec2 o = vec2(float(i), float(j));
    vec2 q = uv + o * u_matteTexel;
    vec3 d = tap(q).rgb - rgb;
    float w = exp(-dot(o, o) * 0.22 - dot(d, d) * 28.0);
    acc += texture(u_matteTex, q).a * w;
    wsum += w;
  }
  return smoothstep(u_matteWin.x, u_matteWin.y, acc / max(wsum, 1e-5));
}
float matteAlpha(vec2 uv, vec3 rgb) {
  if (u_cutOn == 0 || u_matteOn == 0) return 1.0;
  if (u_matteOn == 2) return 0.0;
  return matteRefined(uv, rgb);
}
// Where the clip's color applies (masks in color mode, person or background).
float colorRegion(vec2 uv, vec3 rgb, float mask) {
  float r = u_maskColor == 1 ? mask : 1.0;
  if (u_colorTarget > 0) {
    // Until the person is found nothing is graded, rather than everything.
    float p = u_matteOn == 1 ? matteRefined(uv, rgb) : -1.0;
    r *= p < 0.0 ? 0.0 : u_colorTarget == 1 ? p : 1.0 - p;
  }
  return r;
}
// Soft skin-tone membership from chroma (YCbCr), fading out in deep shadow.
float skinW(vec3 c) {
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return smoothstep(0.26, 0.31, cb) * (1.0 - smoothstep(0.49, 0.54, cb))
       * smoothstep(0.515, 0.55, cr) * (1.0 - smoothstep(0.67, 0.71, cr))
       * smoothstep(0.08, 0.2, y);
}
// Skin retouch in source space: an edge-preserving average of nearby skin
// (smooth), a wide average of its color (even), a lift (brighten), and an
// unsharp mask on everything that is not skin (sharpen).
vec3 retouch(vec2 uv, vec3 c) {
  float person = u_matteOn == 1 ? smoothstep(0.25, 0.6, texture(u_matteTex, uv).a) : u_matteOn == 2 ? 0.0 : 1.0;
  float w0 = skinW(c) * person;
  vec2 st = u_texel * (1.0 + 2.5 * u_retouch.x) * max(1.0, 0.75 / (u_texel.y * 1080.0));
  vec3 acc = vec3(0.0);
  float wa = 0.0;
  vec3 wide = vec3(0.0);
  float ww = 0.0;
  vec3 near = vec3(0.0);
  for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
    vec2 o = vec2(float(i), float(j));
    vec3 s = tap(uv + o * st).rgb;
    vec3 d = s - c;
    float sk = skinW(s);
    float w = exp(-dot(o, o) * 0.18 - dot(d, d) * 90.0) * sk;
    acc += s * w;
    wa += w;
    wide += s * sk;
    ww += sk;
    near += s;
  }
  vec3 outc = c;
  if (w0 > 0.0) {
    vec3 sm = wa > 1e-4 ? acc / wa : c;
    outc = mix(outc, sm, clamp(u_retouch.x * 1.15, 0.0, 1.0) * w0);
    if (ww > 1e-4 && u_retouch.y > 0.0) {
      vec3 avg = wide / ww;
      float l = luma(outc);
      vec3 chroma = mix(outc - l, avg - luma(avg), u_retouch.y * 0.7 * w0);
      outc = l + chroma;
    }
    float l = luma(outc);
    outc *= 1.0 + u_retouch.z * 0.35 * w0 * (1.0 - l);
  }
  if (u_retouch.w > 0.0) {
    vec3 blur = near / 25.0;
    outc += (c - blur) * u_retouch.w * 1.6 * (1.0 - w0) * person;
  }
  return clamp(outc, 0.0, 1.0);
}
// Source pixel (y down) of a source uv, and back.
vec2 srcPx(vec2 uv) { return vec2(uv.x, 1.0 - uv.y) * u_srcSize; }
vec2 pxUv(vec2 p) { vec2 q = p / u_srcSize; return vec2(q.x, 1.0 - q.y); }
// Face shape: each handle moves the picture inside its ellipse and scales it
// around its center, fading smoothly to nothing at the edge, so everything
// away from the faces stays put. Mirrors warpOffset in face-geometry.js.
vec2 warpUv(vec2 uv) {
  vec2 p = srcPx(uv);
  vec2 off = vec2(0.0);
  for (int f = 0; f < 3; f++) {
    if (f >= u_warpFaces) break;
    vec4 g = u_warpFace[f];
    vec2 dg = p - g.xy;
    if (dot(dg, dg) >= g.z * g.z) continue;
    int last = int(u_warpEnd[f] + 0.5);
    for (int i = int(g.w + 0.5); i < last; i++) {
      vec4 a = texelFetch(u_warpTex, ivec2(i, 0), 0);
      vec4 m = texelFetch(u_warpTex, ivec2(i, 1), 0);
      vec2 r = p - a.xy;
      vec2 q = vec2(dot(m.xy, r), dot(m.zw, r));
      float r2 = dot(q, q);
      if (r2 >= 1.0) continue;
      float w = (1.0 - r2) * (1.0 - r2);
      float s = texelFetch(u_warpTex, ivec2(i, 2), 0).x;
      off += (a.zw + r * s) * w;
    }
  }
  return pxUv(p - off);
}
// Body shape: the offset field of engine/body-geometry.js, read with
// bilinear filtering between its grid points (sampleGrid there).
vec2 bodyWarpPx(vec2 p) {
  ivec2 n = textureSize(u_bodyTex, 0);
  vec2 g = clamp(p / u_srcSize * vec2(n - 1), vec2(0.0), vec2(n - 1));
  ivec2 i = min(ivec2(g), n - 2);
  vec2 f = g - vec2(i);
  vec2 a = texelFetch(u_bodyTex, i, 0).xy;
  vec2 b = texelFetch(u_bodyTex, i + ivec2(1, 0), 0).xy;
  vec2 c = texelFetch(u_bodyTex, i + ivec2(0, 1), 0).xy;
  vec2 d = texelFetch(u_bodyTex, i + ivec2(1, 1), 0).xy;
  return p + mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Body first (its field was made on the source as found), then the faces.
vec2 warped(vec2 uv) {
  if (u_bodyOn == 1) uv = pxUv(bodyWarpPx(srcPx(uv)));
  return u_warpFaces > 0 ? warpUv(uv) : uv;
}
vec4 faceMaskAt(vec2 uv) {
  vec2 m = (srcPx(uv) - u_faceMaskRect.xy) / u_faceMaskRect.zw;
  if (m.x <= 0.0 || m.y <= 0.0 || m.x >= 1.0 || m.y >= 1.0) return vec4(0.0);
  return texture(u_faceMask, m);
}
// Red spots count as darker, so the test below finds them too.
float spotV(vec3 s) { return luma(s) - 0.5 * max(s.r - s.g - 0.1, 0.0); }
// Blemishes: a pixel darker than every sample on a ring around it is part of
// a small spot (edges, shadows and lines reach the ring and are left alone);
// it takes the ring's average color. Two ring sizes catch larger spots.
// Mirrors spotStrength in face-geometry.js.
vec3 clearSpots(vec2 uv, vec3 c, float amt) {
  float v = spotV(c);
  vec3 fill = c;
  float best = 0.0;
  for (int sc = 1; sc <= 2; sc++) {
    vec2 r = vec2(u_spotR * float(sc)) / u_srcSize;
    vec3 avg = vec3(0.0);
    float mn = 9.0;
    for (int k = 0; k < 10; k++) {
      float a = float(k) * 0.6283185 + float(sc) * 0.3;
      vec3 s = tap(uv + vec2(cos(a), sin(a)) * r).rgb;
      avg += s;
      mn = min(mn, spotV(s));
    }
    float w = smoothstep(0.012, 0.045, mn - v);
    if (w > best) {
      best = w;
      fill = avg / 10.0;
    }
  }
  return mix(c, fill, best * amt * skinW(fill));
}
// Skin fixes in the regions drawn from the face landmarks.
vec3 faceFix(vec2 uv, vec3 c) {
  vec4 m = faceMaskAt(uv);
  if (m.r + m.g + m.b + m.a <= 0.0) return c;
  if (u_faceFix.x > 0.0 && m.r > 0.0) c = clearSpots(uv, c, u_faceFix.x * m.r);
  if (u_faceFix.y > 0.0 && m.g > 0.0) {
    // Dark circles: lift the shadow (more where darker) and take out some of its blue.
    float k = u_faceFix.y * m.g;
    c = pow(c, vec3(1.0 - 0.42 * k));
    c *= vec3(1.0 + 0.03 * k, 1.0 + 0.01 * k, 1.0 - 0.06 * k);
  }
  if (u_faceFix.z > 0.0 && m.a > 0.0) {
    // Teeth: bright, not red (lips, gums and tongue are) inside the mouth.
    float l = luma(c);
    float red = c.r - 0.5 * (c.g + c.b);
    float k = u_faceFix.z * m.a * smoothstep(0.16, 0.38, l) * (1.0 - smoothstep(0.07, 0.17, red));
    float yellow = max(0.5 * (c.r + c.g) - c.b, 0.0);
    c = mix(c, vec3(l), k * clamp(0.35 + yellow * 4.0, 0.0, 0.85));
    c += (1.0 - c) * 0.22 * k;
  }
  if (u_faceFix.w > 0.0 && m.b > 0.0) {
    // Lips: the chosen color, keeping most of the lips' own light and shade.
    float l = luma(c);
    float tl = max(luma(u_lipColor), 0.04);
    vec3 tint = clamp(u_lipColor * (l / tl), 0.0, 1.0);
    c = mix(c, tint, u_faceFix.w * m.b * 0.7);
  }
  return clamp(c, 0.0, 1.0);
}
vec3 softLight(vec3 b, vec3 s) {
  vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
}
// A color's hue at about full light, so tints keep the skin's own light.
vec3 hueOf(vec3 col) { return min(col / max(luma(col), 0.05), vec3(1.8)); }
// Makeup in the regions drawn from the face landmarks, each laid down the
// way the real thing sits on skin: contour shades, highlight lifts like a
// sheen, blush flushes, eyeshadow deepens the lid, liner is nearly opaque
// and brow tint only darkens. Cheek products stay mostly off hair over the face.
vec3 makeup(vec2 uv, vec3 c) {
  vec2 m = (srcPx(uv) - u_makeupRect.xy) / u_makeupRect.zw;
  if (m.x <= 0.0 || m.y <= 0.0 || m.x >= 1.0 || m.y >= 1.0) return c;
  vec4 k = texture(u_makeupMask, m) * u_makeup;
  vec2 s = texture(u_sculptMask, m).rg * u_sculpt;
  if (k.r + k.g + k.b + k.a + s.x + s.y <= 0.0) return c;
  float skin = mix(0.35, 1.0, skinW(c));
  if (s.x > 0.0) {
    vec3 shade = u_contourColor / max(max(u_contourColor.r, max(u_contourColor.g, u_contourColor.b)), 0.05);
    c = mix(c, c * mix(vec3(1.0), shade, 0.55) * 0.82, s.x * skin * 0.7);
  }
  if (s.y > 0.0) c = mix(c, 1.0 - (1.0 - c) * (1.0 - u_glowColor * 0.5), s.y * skin * 0.75);
  if (k.r > 0.0) c = mix(c, mix(softLight(c, u_blushColor), min(c * hueOf(u_blushColor), vec3(1.0)), 0.2), k.r * skin * 0.85);
  if (k.g > 0.0) c = mix(c, c * u_shadowColor * 1.35, k.g * 0.8);
  if (k.a > 0.0) {
    vec3 pigment = u_browColor * (0.75 + 0.5 * luma(c));
    c = mix(c, min(c, mix(c * hueOf(u_browColor) * 0.75, pigment, 0.5)), k.a * 0.75);
  }
  if (k.b > 0.0) c = mix(c, u_linerColor * (0.8 + 0.4 * luma(c)), k.b * 0.92);
  return clamp(c, 0.0, 1.0);
}
// Hair matte refined against the full picture, like matteRefined. h is the
// position in the matte's square; one matte texel is st in source uv.
float hairAt(vec2 uv, vec2 h, vec3 rgb) {
  vec2 st = u_hairRect.zw * u_hairTexel / u_srcSize * vec2(1.0, -1.0);
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 o = vec2(float(i), float(j));
    vec3 d = tap(uv + o * st).rgb - rgb;
    float w = exp(-dot(o, o) * 0.4 - dot(d, d) * 40.0);
    acc += texture(u_hairTex, h + o * u_hairTexel).r * w;
    wsum += w;
  }
  return smoothstep(0.35, 0.85, acc / max(wsum, 1e-5));
}
// Hair color: the chosen color scaled by how light each pixel is next to the
// hair's mean, so strands, shine and shadow survive the change. Scaling
// would flatten dark colors, so those keep the detail as differences.
vec3 hairRecolor(vec2 uv, vec3 c) {
  vec2 hp = (srcPx(uv) - u_hairRect.xy) / u_hairRect.zw;
  if (hp.x <= 0.0 || hp.y <= 0.0 || hp.x >= 1.0 || hp.y >= 1.0) return c;
  if (texture(u_hairTex, hp).r < 0.02) return c;
  float h = hairAt(uv, hp, c);
  if (h <= 0.0) return c;
  float l = luma(c);
  float rel = pow(l / max(u_hairLuma, 0.03), 0.85);
  vec3 scaled = u_hairColor * rel;
  float over = max(max(scaled.r, max(scaled.g, scaled.b)) - 1.0, 0.0);
  scaled += over * 0.6;
  vec3 shifted = u_hairColor + (l - u_hairLuma) * 0.7;
  vec3 tgt = clamp(mix(shifted, scaled, smoothstep(0.06, 0.3, luma(u_hairColor))), 0.0, 1.0);
  return mix(c, tgt, u_hairAmount * h);
}
void main() {
  vec2 uv = warped(v_uv);
  vec4 c;
  if (u_blur > 0.0) {
    c = vec4(0.0);
    float r = u_blur;
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) {
      c += tap(uv + vec2(float(i), float(j)) * u_texel * r);
    }
    c /= 49.0;
  } else {
    c = tap(uv);
  }
  if (u_sharpen > 0.0) {
    vec4 n = tap(uv + vec2(u_texel.x, 0.0)) + tap(uv - vec2(u_texel.x, 0.0)) + tap(uv + vec2(0.0, u_texel.y)) + tap(uv - vec2(0.0, u_texel.y));
    c.rgb = c.rgb + (c.rgb - n.rgb * 0.25) * u_sharpen * 0.012;
  }
  if (u_chroma == 1) {
    float d = distance(rgb2uv(c.rgb), rgb2uv(u_keyColor));
    float edge = u_keyStrength * 0.004;
    float k = smoothstep(edge, edge + 0.06, d);
    c.a *= k;
    // Remove key color spill on the remaining edge.
    float spill = (1.0 - k) * u_keySpill * 0.01;
    c.rgb = mix(c.rgb, vec3(luma(c.rgb)), spill);
  }
  if (u_retouchOn == 1) c.rgb = retouch(uv, c.rgb);
  if (u_faceFixOn == 1) c.rgb = faceFix(uv, c.rgb);
  if (u_makeupOn == 1) c.rgb = makeup(uv, c.rgb);
  if (u_hairOn == 1) c.rgb = hairRecolor(uv, c.rgb);
  float cut = matteAlpha(uv, c.rgb);
  float mk = maskAlpha(v_uv);
  float region = colorRegion(uv, c.rgb, mk);
  vec3 before = c.rgb;
  if (u_clarity != 0.0) g_local = localLuma(uv);
  c.rgb = mix(before, grade(c.rgb, v_quad, u_texel), region);
  float a = c.a * u_opacity * (u_maskColor == 1 ? 1.0 : mk) * cut;
  outColor = vec4(c.rgb * a, a);
}`;

/** Draw a premultiplied texture (canvas output, temp buffers). */
export const COPY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 outColor;
void main() { outColor = texture(u_tex, v_uv) * u_opacity; }`;

/** Separable 9-tap Gaussian, used for the blurred background and blur effects. */
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv) * 0.2270270270;
  c += texture(u_tex, v_uv + u_dir * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv - u_dir * 1.3846153846) * 0.3162162162;
  c += texture(u_tex, v_uv + u_dir * 3.2307692308) * 0.0702702703;
  c += texture(u_tex, v_uv - u_dir * 3.2307692308) * 0.0702702703;
  outColor = c;
}`;

/** Grade the whole frame (filter and adjustment clips). Input and output premultiplied. */
export const GRADE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_mix;
out vec4 outColor;
${COLOR_FN}
vec3 srcRgb(vec2 uv) { vec4 s = texture(u_tex, uv); return s.a > 0.0 ? s.rgb / s.a : s.rgb; }
${localLumaFn('srcRgb')}
void main() {
  vec4 s = texture(u_tex, v_uv);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : s.rgb;
  if (u_clarity != 0.0) g_local = localLuma(v_uv);
  if (u_sharpen > 0.0) {
    vec3 n = texture(u_tex, v_uv + vec2(u_texel.x, 0.0)).rgb + texture(u_tex, v_uv - vec2(u_texel.x, 0.0)).rgb + texture(u_tex, v_uv + vec2(0.0, u_texel.y)).rgb + texture(u_tex, v_uv - vec2(0.0, u_texel.y)).rgb;
    c = c + (c - n * 0.25) * u_sharpen * 0.012;
  }
  vec3 g = grade(c, v_uv, u_texel);
  outColor = vec4(mix(c, g, u_mix) * s.a, s.a);
}`;

/** Separable blend of a premultiplied source layer over the destination. */
export const BLEND_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
out vec4 outColor;
vec3 blendFn(vec3 b, vec3 s) {
  if (u_mode == 1) return b * s;
  if (u_mode == 2) return b + s - b * s;
  if (u_mode == 3) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (u_mode == 4) return min(b, s);
  if (u_mode == 5) return max(b, s);
  if (u_mode == 6) return min(vec3(1.0), b / max(1.0 - s, 1e-4));
  if (u_mode == 7) return 1.0 - min(vec3(1.0), (1.0 - b) / max(s, 1e-4));
  if (u_mode == 8) return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (sqrt(b) - b), step(0.5, s));
  if (u_mode == 9) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (u_mode == 10) return abs(b - s);
  if (u_mode == 11) return min(vec3(1.0), b + s);
  return s;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv);
  vec3 b = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 sc = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 mixed = mix(sc, blendFn(b, sc), d.a);
  float a = s.a + d.a * (1.0 - s.a);
  outColor = vec4(mixed * s.a + d.rgb * (1.0 - s.a), a);
}`;

export const BLEND_MODE_INDEX = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
  'color-dodge': 6, 'color-burn': 7, 'soft-light': 8, 'hard-light': 9, difference: 10, add: 11,
};

const FX_HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec2 u_res;
uniform float u_time;      // seconds since the effect clip started
uniform float u_speed;     // 0..1
uniform float u_strength;  // 0..1
out vec4 outColor;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 src(vec2 uv) { return texture(u_tex, uv); }
float rate() { return 0.25 + u_speed * 3.0; }
`;

/** Effect bodies: each defines main() writing premultiplied outColor. */
export const EFFECT_SHADERS = {
  blur: `void main() {
    vec4 c = vec4(0.0); float r = 1.0 + u_strength * 10.0; float n = 0.0;
    for (int i = -4; i <= 4; i++) for (int j = -4; j <= 4; j++) { float w = exp(-float(i*i + j*j) / 18.0); c += src(v_uv + vec2(i, j) * u_texel * r) * w; n += w; }
    outColor = c / n; }`,
  vignette: `void main() { vec4 c = src(v_uv); float d = distance(v_uv, vec2(0.5)); c.rgb *= 1.0 - smoothstep(0.2, 0.8, d) * u_strength; outColor = c; }`,
  'black-white': `void main() { vec4 c = src(v_uv); c.rgb = mix(c.rgb, vec3(luma(c.rgb / max(c.a, 1e-4)) * c.a), u_strength * 0.5 + 0.5); outColor = c; }`,
  invert: `void main() { vec4 c = src(v_uv); vec3 inv = c.a - c.rgb; c.rgb = mix(c.rgb, inv, 0.5 + 0.5 * u_strength); outColor = c; }`,
  sharpen: `void main() { vec4 c = src(v_uv); vec4 n = src(v_uv + vec2(u_texel.x, 0.0)) + src(v_uv - vec2(u_texel.x, 0.0)) + src(v_uv + vec2(0.0, u_texel.y)) + src(v_uv - vec2(0.0, u_texel.y)); c.rgb += (c.rgb - n.rgb * 0.25) * (0.5 + u_strength * 2.5); outColor = clamp(c, 0.0, 1.0); }`,
  'zoom-pulse': `void main() { float p = 0.5 - 0.5 * cos(u_time * rate() * 6.2831); float z = 1.0 + p * (0.05 + u_strength * 0.2); outColor = src((v_uv - 0.5) / z + 0.5); }`,
  shake: `void main() { float t = floor(u_time * (8.0 + u_speed * 24.0)); vec2 o = (vec2(hash11(t), hash11(t + 7.1)) - 0.5) * (0.01 + u_strength * 0.05); float z = 1.0 + (0.01 + u_strength * 0.05) * 2.0; outColor = src((v_uv - 0.5) / z + 0.5 + o); }`,
  'spin-blur': `void main() { vec2 c = v_uv - 0.5; vec4 acc = vec4(0.0); float a = u_strength * 0.12 * (0.5 + 0.5 * sin(u_time * rate() * 3.0)); for (int i = 0; i < 12; i++) { float t = (float(i) / 11.0 - 0.5) * a; mat2 m = mat2(cos(t), -sin(t), sin(t), cos(t)); acc += src(m * c + 0.5); } outColor = acc / 12.0; }`,
  'zoom-blur': `void main() { vec2 c = v_uv - 0.5; vec4 acc = vec4(0.0); float s = u_strength * 0.15 * (0.6 + 0.4 * sin(u_time * rate() * 4.0)); for (int i = 0; i < 12; i++) { acc += src(c * (1.0 - s * float(i) / 11.0) + 0.5); } outColor = acc / 12.0; }`,
  strobe: `void main() { vec4 c = src(v_uv); float on = step(0.5, fract(u_time * (2.0 + u_speed * 10.0))); c.rgb = mix(c.rgb, vec3(c.a), on * u_strength * 0.8); outColor = c; }`,
  vhs: `void main() {
    vec2 uv = v_uv; float t = u_time * rate();
    float line = hash11(floor(uv.y * 240.0) + floor(t * 12.0));
    uv.x += (line - 0.5) * 0.004 * u_strength + sin(uv.y * 30.0 + t * 5.0) * 0.002 * u_strength;
    float off = 0.004 * u_strength;
    vec4 c = vec4(src(uv + vec2(off, 0.0)).r, src(uv).g, src(uv - vec2(off, 0.0)).b, src(uv).a);
    c.rgb *= 0.92 + 0.08 * sin(uv.y * u_res.y * 1.5);
    float band = smoothstep(0.0, 0.02, abs(fract(uv.y + t * 0.1) - 0.5) - 0.48);
    c.rgb += (1.0 - band) * 0.15 * u_strength;
    c.rgb += (hash12(uv * u_res + t) - 0.5) * 0.08 * u_strength;
    outColor = c; }`,
  'film-grain': `void main() { vec4 c = src(v_uv); float n = hash12(v_uv * u_res + floor(u_time * 24.0) * 13.7) - 0.5; c.rgb += n * (0.05 + u_strength * 0.25) * c.a; outColor = c; }`,
  'old-film': `void main() {
    float t = floor(u_time * 18.0);
    vec2 uv = v_uv + vec2(0.0, (hash11(t) - 0.5) * 0.004 * u_strength);
    vec4 c = src(uv); float l = luma(c.rgb);
    vec3 sep = vec3(l) * vec3(1.07, 0.95, 0.78);
    c.rgb = mix(c.rgb, sep, 0.6 + 0.4 * u_strength);
    c.rgb *= 0.9 + 0.1 * hash11(t * 3.1);
    float scratch = step(0.997 - u_strength * 0.004, hash11(floor(v_uv.x * 300.0) + t));
    c.rgb += scratch * 0.25;
    c.rgb += (hash12(v_uv * u_res + t) - 0.5) * 0.12 * u_strength;
    c.rgb *= 1.0 - smoothstep(0.3, 0.9, distance(v_uv, vec2(0.5))) * 0.6;
    outColor = c; }`,
  scanlines: `void main() { vec4 c = src(v_uv); float s = 0.5 + 0.5 * sin((v_uv.y * u_res.y * 0.5 + u_time * rate() * 20.0)); c.rgb *= 1.0 - s * u_strength * 0.45; outColor = c; }`,
  posterize: `void main() { vec4 c = src(v_uv); float levels = mix(12.0, 3.0, u_strength); vec3 rgb = c.a > 0.0 ? c.rgb / c.a : c.rgb; rgb = floor(rgb * levels + 0.5) / levels; outColor = vec4(rgb * c.a, c.a); }`,
  glow: `void main() {
    vec4 c = src(v_uv); vec4 b = vec4(0.0); float n = 0.0;
    for (int i = -4; i <= 4; i++) for (int j = -4; j <= 4; j++) { float w = exp(-float(i*i + j*j) / 10.0); b += src(v_uv + vec2(i, j) * u_texel * 6.0) * w; n += w; }
    b /= n; vec3 bright = max(b.rgb - 0.45, 0.0) * 2.0;
    c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - bright * (0.4 + u_strength * 1.2));
    c.rgb = mix(c.rgb, c.rgb * 0.9 + 0.08, 0.3 * u_strength);
    outColor = c; }`,
  'light-leak': `void main() {
    vec4 c = src(v_uv); float t = u_time * rate() * 0.4;
    vec2 p1 = vec2(0.1 + 0.3 * sin(t), 0.2 + 0.2 * cos(t * 1.3));
    vec2 p2 = vec2(0.9 - 0.2 * cos(t * 0.7), 0.8 + 0.15 * sin(t * 1.7));
    vec3 leak = vec3(1.0, 0.45, 0.15) * smoothstep(0.7, 0.0, distance(v_uv, p1)) + vec3(1.0, 0.2, 0.4) * smoothstep(0.6, 0.0, distance(v_uv, p2));
    c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - leak * u_strength * 0.9);
    outColor = c; }`,
  flash: `void main() { vec4 c = src(v_uv); float p = pow(max(0.0, sin(u_time * rate() * 3.1416)), 8.0); c.rgb = mix(c.rgb, vec3(c.a), p * u_strength); outColor = c; }`,
  sparkle: `void main() {
    vec4 c = src(v_uv); vec2 g = v_uv * vec2(u_res.x / u_res.y, 1.0) * 18.0; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
    float h = hash12(id); float tw = 0.5 + 0.5 * sin(u_time * rate() * 4.0 + h * 40.0);
    vec2 o = (vec2(hash12(id + 3.1), hash12(id + 7.7)) - 0.5) * 0.6; float d = length(f - o);
    float star = step(0.88, h) * tw * (smoothstep(0.08, 0.0, d) + smoothstep(0.02, 0.0, abs((f - o).x)) * smoothstep(0.25, 0.0, abs((f - o).y)) * 0.6 + smoothstep(0.02, 0.0, abs((f - o).y)) * smoothstep(0.25, 0.0, abs((f - o).x)) * 0.6);
    c.rgb += star * u_strength * 1.2; outColor = c; }`,
  'rgb-split': `void main() { float o = (0.003 + u_strength * 0.02) * (0.6 + 0.4 * sin(u_time * rate() * 4.0)); vec4 g = src(v_uv); outColor = vec4(src(v_uv + vec2(o, 0.0)).r, g.g, src(v_uv - vec2(o, 0.0)).b, g.a); }`,
  glitch: `void main() {
    float t = floor(u_time * (6.0 + u_speed * 20.0));
    vec2 uv = v_uv; float block = floor(uv.y * (8.0 + hash11(t) * 24.0));
    float on = step(1.0 - u_strength * 0.6, hash11(block + t * 1.7));
    uv.x += on * (hash11(block * 3.3 + t) - 0.5) * 0.15 * u_strength;
    float o = on * 0.02 * u_strength;
    vec4 c = vec4(src(uv + vec2(o, 0.0)).r, src(uv).g, src(uv - vec2(o, 0.0)).b, src(uv).a);
    outColor = c; }`,
  wave: `void main() { vec2 uv = v_uv; uv.x += sin(uv.y * 18.0 + u_time * rate() * 4.0) * 0.012 * u_strength * 2.0; uv.y += cos(uv.x * 14.0 + u_time * rate() * 3.0) * 0.008 * u_strength * 2.0; outColor = src(uv); }`,
  bulge: `void main() { vec2 c = v_uv - 0.5; float r = length(c); float k = u_strength * 0.9; vec2 uv = 0.5 + c * (1.0 - k * 0.5 + k * r * r * 1.4); outColor = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : src(uv); }`,
  pixelate: `void main() { float cells = mix(160.0, 14.0, u_strength); vec2 size = vec2(cells * u_res.x / u_res.y, cells); outColor = src((floor(v_uv * size) + 0.5) / size); }`,
  mirror: `void main() { vec2 uv = v_uv; if (u_strength > 0.5) uv.y = uv.y > 0.5 ? 1.0 - uv.y : uv.y; uv.x = uv.x > 0.5 ? 1.0 - uv.x : uv.x; outColor = src(uv); }`,
  kaleidoscope: `void main() { vec2 p = v_uv - 0.5; p.x *= u_res.x / u_res.y; float a = atan(p.y, p.x) + u_time * rate() * 0.3; float r = length(p); float seg = 6.2831 / floor(4.0 + u_strength * 8.0); a = mod(a, seg); a = abs(a - seg * 0.5); vec2 q = vec2(cos(a), sin(a)) * r; q.x /= u_res.x / u_res.y; outColor = src(q + 0.5); }`,
  edge: `void main() {
    float tl = luma(src(v_uv + u_texel * vec2(-1, 1)).rgb), t = luma(src(v_uv + u_texel * vec2(0, 1)).rgb), tr = luma(src(v_uv + u_texel * vec2(1, 1)).rgb);
    float l = luma(src(v_uv + u_texel * vec2(-1, 0)).rgb), r = luma(src(v_uv + u_texel * vec2(1, 0)).rgb);
    float bl = luma(src(v_uv + u_texel * vec2(-1, -1)).rgb), b = luma(src(v_uv + u_texel * vec2(0, -1)).rgb), br = luma(src(v_uv + u_texel * vec2(1, -1)).rgb);
    float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br; float gy = -bl - 2.0 * b - br + tl + 2.0 * t + tr;
    float e = clamp(length(vec2(gx, gy)) * 2.0, 0.0, 1.0);
    vec4 c = src(v_uv); vec3 sketch = vec3(1.0 - e);
    outColor = vec4(mix(c.rgb, sketch * c.a, 0.4 + 0.6 * u_strength), c.a); }`,
  halftone: `void main() {
    float cells = mix(140.0, 40.0, u_strength); vec2 g = v_uv * vec2(cells * u_res.x / u_res.y, cells);
    vec2 id = floor(g); vec2 f = fract(g) - 0.5;
    vec4 c = src((id + 0.5) / vec2(cells * u_res.x / u_res.y, cells)); float l = luma(c.rgb);
    float dot = smoothstep(0.05, 0.0, length(f) - sqrt(1.0 - l) * 0.55);
    outColor = vec4(mix(vec3(1.0), c.rgb * 0.6, dot) * c.a, c.a); }`,
  'split-screen': `void main() { vec2 uv = v_uv; float n = u_strength > 0.66 ? 4.0 : u_strength > 0.33 ? 3.0 : 2.0; uv.x = fract(uv.x * n); uv.x = (uv.x - 0.5) / n * 1.0 + 0.5; outColor = src(vec2(uv.x * 1.0, v_uv.y)); }`,
  letterbox: `void main() { vec4 c = src(v_uv); float bar = 0.06 + u_strength * 0.1; float m = step(bar, v_uv.y) * step(v_uv.y, 1.0 - bar); outColor = vec4(c.rgb * m, mix(1.0, c.a, m)); }`,
  ...EXTRA_EFFECT_SHADERS,
  ...BODY_EFFECT_SHADERS,
};

export function effectShader(id) {
  const body = Object.hasOwn(EFFECT_SHADERS, id) ? EFFECT_SHADERS[id] : null;
  return body ? FX_HEAD + FX_LIB + body : null;
}

/** Place a premultiplied texture with a layer's transform and opacity (per-clip effects). */
export const PLACE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform vec2 u_texel;
uniform float u_blur;
out vec4 outColor;
void main() {
  vec4 c;
  if (u_blur > 0.0) {
    c = vec4(0.0);
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) c += texture(u_tex, v_uv + vec2(float(i), float(j)) * u_texel * u_blur);
    c /= 49.0;
  } else {
    c = texture(u_tex, v_uv);
  }
  outColor = c * u_opacity;
}`;

const TR_HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_from;
uniform sampler2D u_to;
uniform float u_progress;
uniform vec2 u_res;
out vec4 outColor;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec4 A(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_from, uv); }
vec4 B(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_to, uv); }
float ease(float p) { return p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) / 2.0; }
float aspect() { return u_res.x / u_res.y; }
`;

/** Transition bodies: mix u_from (outgoing) into u_to (incoming) by u_progress. */
export const TRANSITION_SHADERS = {
  mix: `void main() { outColor = mix(A(v_uv), B(v_uv), u_progress); }`,
  'dip-black': `void main() { float p = u_progress; vec4 c = p < 0.5 ? A(v_uv) * (1.0 - p * 2.0) : B(v_uv) * (p * 2.0 - 1.0); outColor = vec4(c.rgb, mix(1.0, 1.0, p)); }`,
  'dip-white': `void main() { float p = u_progress; vec4 c = p < 0.5 ? A(v_uv) : B(v_uv); float w = 1.0 - abs(p * 2.0 - 1.0); outColor = vec4(mix(c.rgb, vec3(1.0), w), 1.0); }`,
  blur: `void main() {
    float p = u_progress; float r = sin(p * 3.1416) * 18.0; vec4 a = vec4(0.0), b = vec4(0.0);
    for (int i = -3; i <= 3; i++) for (int j = -3; j <= 3; j++) { vec2 o = vec2(i, j) * r / u_res; a += A(v_uv + o); b += B(v_uv + o); }
    outColor = mix(a, b, smoothstep(0.3, 0.7, p)) / 49.0; }`,
  'zoom-in': `void main() { float p = ease(u_progress); vec4 a = A((v_uv - 0.5) / (1.0 + p * 1.5) + 0.5); vec4 b = B((v_uv - 0.5) * (1.0 + (1.0 - p) * 0.4) + 0.5); outColor = mix(a, b, smoothstep(0.35, 0.75, u_progress)); }`,
  'zoom-out': `void main() { float p = ease(u_progress); vec4 a = A((v_uv - 0.5) * (1.0 + p * 1.0) + 0.5); vec4 b = B((v_uv - 0.5) / (1.0 + (1.0 - p) * 1.2) + 0.5); outColor = mix(a, b, smoothstep(0.35, 0.75, u_progress)); }`,
  'wipe-left': `void main() { float e = 0.02; float m = smoothstep(u_progress - e, u_progress + e, 1.0 - v_uv.x); outColor = mix(B(v_uv), A(v_uv), m); }`,
  'wipe-right': `void main() { float e = 0.02; float m = smoothstep(u_progress - e, u_progress + e, v_uv.x); outColor = mix(B(v_uv), A(v_uv), m); }`,
  'wipe-up': `void main() { float e = 0.02; float m = smoothstep(u_progress - e, u_progress + e, v_uv.y); outColor = mix(B(v_uv), A(v_uv), m); }`,
  'wipe-down': `void main() { float e = 0.02; float m = smoothstep(u_progress - e, u_progress + e, 1.0 - v_uv.y); outColor = mix(B(v_uv), A(v_uv), m); }`,
  'slide-left': `void main() { float p = ease(u_progress); vec2 uv = v_uv + vec2(p, 0.0); outColor = uv.x < 1.0 ? A(uv) : B(uv - vec2(1.0, 0.0)); }`,
  'slide-right': `void main() { float p = ease(u_progress); vec2 uv = v_uv - vec2(p, 0.0); outColor = uv.x >= 0.0 ? A(uv) : B(uv + vec2(1.0, 0.0)); }`,
  'slide-up': `void main() { float p = ease(u_progress); vec2 uv = v_uv - vec2(0.0, p); outColor = uv.y >= 0.0 ? A(uv) : B(uv + vec2(0.0, 1.0)); }`,
  'slide-down': `void main() { float p = ease(u_progress); vec2 uv = v_uv + vec2(0.0, p); outColor = uv.y < 1.0 ? A(uv) : B(uv - vec2(0.0, 1.0)); }`,
  'circle-open': `void main() { vec2 p = (v_uv - 0.5) * vec2(aspect(), 1.0); float r = ease(u_progress) * length(vec2(aspect(), 1.0)) * 0.5; outColor = mix(A(v_uv), B(v_uv), 1.0 - smoothstep(r - 0.01, r + 0.01, length(p))); }`,
  'circle-close': `void main() { vec2 p = (v_uv - 0.5) * vec2(aspect(), 1.0); float r = (1.0 - ease(u_progress)) * length(vec2(aspect(), 1.0)) * 0.5; outColor = mix(B(v_uv), A(v_uv), 1.0 - smoothstep(r - 0.01, r + 0.01, length(p))); }`,
  diamond: `void main() { vec2 p = abs(v_uv - 0.5) * vec2(aspect(), 1.0); float d = p.x + p.y; float r = ease(u_progress) * (aspect() * 0.5 + 0.5); outColor = mix(A(v_uv), B(v_uv), 1.0 - smoothstep(r - 0.01, r + 0.01, d)); }`,
  clock: `void main() { vec2 p = v_uv - 0.5; float a = atan(p.x, p.y); float t = (a + 3.14159) / 6.28318; outColor = mix(A(v_uv), B(v_uv), step(1.0 - u_progress, 1.0 - t)); }`,
  blinds: `void main() { float n = 10.0; float f = fract(v_uv.x * n); outColor = mix(A(v_uv), B(v_uv), step(f, u_progress)); }`,
  'split-open': `void main() { float p = ease(u_progress); float d = abs(v_uv.x - 0.5) * 2.0; outColor = d < p ? B(v_uv) : A(vec2(v_uv.x < 0.5 ? v_uv.x + p * 0.5 : v_uv.x - p * 0.5, v_uv.y)); }`,
  pixelize: `void main() { float s = sin(u_progress * 3.1416); float cells = mix(400.0, 12.0, s); vec2 size = vec2(cells * aspect(), cells); vec2 uv = s > 0.02 ? (floor(v_uv * size) + 0.5) / size : v_uv; outColor = mix(A(uv), B(uv), step(0.5, u_progress)); }`,
  glitch: `void main() {
    float s = sin(u_progress * 3.1416); float t = floor(u_progress * 30.0);
    float block = floor(v_uv.y * 18.0); float off = (hash11(block + t) - 0.5) * 0.2 * s * step(0.4, hash11(block * 1.3 + t));
    vec2 uv = v_uv + vec2(off, 0.0);
    vec4 a = vec4(A(uv + vec2(0.02 * s, 0.0)).r, A(uv).g, A(uv - vec2(0.02 * s, 0.0)).b, A(uv).a);
    vec4 b = vec4(B(uv + vec2(0.02 * s, 0.0)).r, B(uv).g, B(uv - vec2(0.02 * s, 0.0)).b, B(uv).a);
    outColor = mix(a, b, step(0.5, u_progress)); }`,
  spin: `void main() {
    float p = ease(u_progress); vec2 c = (v_uv - 0.5) * vec2(aspect(), 1.0); float ang = p * 6.2831; float z = 1.0 + sin(p * 3.1416) * 1.5;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c * z; q.x /= aspect(); q += 0.5;
    outColor = mix(A(q), B(q), smoothstep(0.4, 0.6, u_progress)); }`,
  flash: `void main() { float w = pow(1.0 - abs(u_progress * 2.0 - 1.0), 2.0); vec4 c = mix(A(v_uv), B(v_uv), step(0.5, u_progress)); outColor = vec4(mix(c.rgb, vec3(1.0), w), max(c.a, w)); }`,
  ripple: `void main() { vec2 p = v_uv - 0.5; float d = length(p); float s = sin(u_progress * 3.1416); vec2 uv = v_uv + normalize(p + 1e-5) * sin(d * 60.0 - u_progress * 30.0) * 0.02 * s; outColor = mix(A(uv), B(uv), smoothstep(0.2, 0.8, u_progress)); }`,
  'color-burn': `void main() { vec4 a = A(v_uv), b = B(v_uv); float p = u_progress; vec3 burn = mix(a.rgb, vec3(1.0, 0.55, 0.1) * (a.rgb + 0.2), sin(p * 3.1416)); outColor = mix(vec4(burn, a.a), b, smoothstep(0.45, 0.75, p)); }`,
  ...EXTRA_TRANSITION_SHADERS,
};

export function transitionShader(id) {
  const body = Object.hasOwn(TRANSITION_SHADERS, id) ? TRANSITION_SHADERS[id] : TRANSITION_SHADERS.mix;
  return TR_HEAD + TR_LIB + body;
}
