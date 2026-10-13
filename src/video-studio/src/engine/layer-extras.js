/**
 * Compositor hooks for per-clip masks and picture extras. Kept out of
 * compositor.js so the core draw stays small:
 *  - bindLayerMask: rasterized mask coverage on its own texture unit,
 *    sampled by LAYER_FS at the picture's own coordinates.
 *  - drawLayerWithExtras: per-clip canvas fill behind the clip, then the clip
 *    rendered alone (several transform samples for motion blur) with noise
 *    reduction and relight passes, composited into the target the caller
 *    bound. Exports run the same code, so they match the preview.
 */
import { FULL_VS } from './shaders.js';
import { MaskRaster } from './mask-raster.js';

/** Texture unit of the mask coverage (layers use 0, curves 4, LUT 5). */
export const MASK_UNIT = 6;
const ZERO_CROP = { l: 0, t: 0, r: 0, b: 0 };

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
`;

/** Solid color or linear gradient across the frame. */
export const CANVAS_FS = `${HEAD}
uniform int u_mode;
uniform vec3 u_c1, u_c2;
uniform vec2 u_dir;
void main() {
  if (u_mode == 0) { outColor = vec4(u_c1, 1.0); return; }
  float t = clamp(dot(v_uv - 0.5, u_dir) + 0.5, 0.0, 1.0);
  outColor = vec4(mix(u_c1, u_c2, t * t * (3.0 - 2.0 * t)), 1.0);
}`;

/**
 * Edge-preserving (bilateral) noise reduction of a premultiplied buffer:
 * neighbors count less the more their color differs, so edges stay sharp.
 */
export const DENOISE_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_strength;
uniform float u_step;
void main() {
  vec4 c0 = texture(u_tex, v_uv);
  if (c0.a <= 0.002) { outColor = c0; return; }
  vec3 b0 = c0.rgb / c0.a;
  float sr = 0.025 + u_strength * 0.11;
  float ss = 1.2 + u_strength * 1.8;
  vec3 acc = vec3(0.0);
  float wa = 0.0;
  for (int i = -3; i <= 3; i++) {
    for (int j = -3; j <= 3; j++) {
      vec2 o = vec2(float(i), float(j));
      vec4 s = texture(u_tex, v_uv + o * u_texel * u_step);
      vec3 sb = s.a > 0.002 ? s.rgb / s.a : b0;
      vec3 d = sb - b0;
      float w = exp(-dot(o, o) / (2.0 * ss * ss) - dot(d, d) / (2.0 * sr * sr)) * s.a;
      acc += sb * w;
      wa += w;
    }
  }
  vec3 f = wa > 0.0 ? acc / wa : b0;
  outColor = vec4(mix(b0, f, clamp(0.35 + u_strength, 0.0, 1.0)) * c0.a, c0.a);
}`;

/**
 * Directional relight: a soft light from one side across the clip's box,
 * weighted by luminance so shadows keep their detail, with a warm or cool
 * tint on the lit side.
 */
export const RELIGHT_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_center;
uniform vec2 u_half;
uniform vec2 u_dir;
uniform float u_intensity;
uniform float u_temp;
void main() {
  vec4 c0 = texture(u_tex, v_uv);
  if (c0.a <= 0.002) { outColor = c0; return; }
  vec3 c = c0.rgb / c0.a;
  vec2 p = (v_uv - u_center) / max(u_half, vec2(1e-4));
  float side = smoothstep(-1.3, 1.3, dot(p, u_dir));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float gain = mix(1.0 - 0.45 * u_intensity, 1.0 + 0.65 * u_intensity, side);
  float w = 0.4 + 0.6 * smoothstep(0.0, 0.7, l);
  c *= mix(1.0, gain, w);
  vec3 tint = u_temp >= 0.0 ? mix(vec3(1.0), vec3(1.0, 0.8, 0.58), u_temp) : mix(vec3(1.0), vec3(0.62, 0.8, 1.0), -u_temp);
  c *= mix(vec3(1.0), tint, side * u_intensity);
  outColor = vec4(clamp(c, 0.0, 1.0) * c0.a, c0.a);
}`;

function hexToRgb(hex) {
  const n = parseInt(String(hex || '#000000').slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Gradient direction in uv (y up) for a CSS-like angle (0 = toward the top, 90 = toward the right). */
export function gradientDir(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = Math.cos(a);
  const k = Math.abs(dx) + Math.abs(dy) || 1;
  return [dx / k, dy / k];
}

/**
 * Set the mask uniforms of the layer program: rasterize (cached) and bind the
 * coverage, or turn masking off.
 */
export function bindLayerMask(comp, p, layer, box) {
  const gl = comp.gl;
  comp._seti(p, 'u_maskTex', MASK_UNIT);
  let on = 0;
  const masks = layer.kind === 'media' ? layer.masks : null;
  if (masks?.length && layer.clip) {
    const crop = layer.crop || ZERO_CROP;
    const outScale = comp.width / (comp.projW || 1);
    const shownW = (Math.abs(box.w) / Math.max(0.05, 1 - crop.l - crop.r)) * outScale;
    const shownH = (Math.abs(box.h) / Math.max(0.05, 1 - crop.t - crop.b)) * outScale;
    comp._maskRaster ||= new MaskRaster();
    const r = comp._maskRaster.get(layer.clip.id, masks, layer.width, layer.height, Math.max(shownW, shownH));
    if (r) {
      gl.activeTexture(gl.TEXTURE0 + MASK_UNIT);
      const e = comp._texture({ key: `mask:${layer.clip.id}`, source: r.canvas, width: r.width, height: r.height, version: r.key });
      gl.activeTexture(gl.TEXTURE0);
      if (e) on = 1;
    }
  }
  comp._seti(p, 'u_maskOn', on);
}

/** Fill the bound target behind a clip: color, gradient or a blurred copy of the clip. */
function drawClipCanvas(comp, layer, cv, time, dst) {
  const gl = comp.gl;
  if (cv.type === 'blur') {
    const info = comp.resolve(layer);
    if (!info?.source) return;
    const W = comp.projW;
    const H = comp.projH;
    const iw = info.width || layer.width;
    const ih = info.height || layer.height;
    const cover = Math.max(W / iw, H / ih);
    const fit = Math.min(W / iw, H / ih);
    const fake = { ...layer, inner: true, extras: null, enhance: null, masks: null, cutout: null, retouch: null, faceShape: null, hairColor: null, bodyShape: null, makeup: null, effects: null, x: 0, y: 0, rotation: 0, opacity: 1, blur: 0, sx: 1, sy: 1, scale: cover / fit, crop: ZERO_CROP, flipH: false, flipV: false };
    // A small buffer and a modest radius per pass keep the blur smooth (large taps alias into blocks).
    const small = comp._target('clipBgS', 0.125);
    comp._into(small);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    comp._drawLayer(fake, time);
    const blurred = comp._blurInto(small.tex, comp._target('clipBgA', 0.125), comp._target('clipBgB', 0.125), 0.6 + (cv.blur ?? 0.5) * 1.4);
    comp._into(dst);
    gl.disable(gl.BLEND);
    comp._copy(blurred.tex);
    return;
  }
  comp._into(dst);
  gl.disable(gl.BLEND);
  const p = comp._use(comp._program('clipCanvas', FULL_VS, CANVAS_FS));
  comp._seti(p, 'u_mode', cv.type === 'gradient' ? 1 : 0);
  comp._set(p, 'u_c1', hexToRgb(cv.color));
  comp._set(p, 'u_c2', hexToRgb(cv.color2));
  comp._set(p, 'u_dir', gradientDir(cv.angle ?? 180));
  comp._fullPass(p);
}

/**
 * Draw a layer that has extras into the target bound by the caller, leaving
 * that target bound and the blend state as the caller set it.
 */
export function drawLayerWithExtras(comp, layer, time) {
  const gl = comp.gl;
  const ex = layer.extras;
  const dst = comp._bound || null;
  const blendWasOn = gl.isEnabled(gl.BLEND);
  const restore = () => {
    comp._into(dst);
    if (blendWasOn) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
  };
  const inner = { ...layer, inner: true };
  if (ex.canvas) drawClipCanvas(comp, layer, ex.canvas, time, dst);
  if (!ex.motion && !ex.denoise && !ex.relight) {
    restore();
    return comp._drawLayer(inner, time);
  }
  // The clip alone, in its own buffer.
  const bufA = comp._target('clipFxA');
  const bufB = comp._target('clipFxB');
  comp._into(bufA);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  let drawn = false;
  if (ex.motion) {
    // Average the samples: each adds 1/n of its premultiplied color.
    gl.blendFunc(gl.ONE, gl.ONE);
    const n = ex.motion.length;
    for (const s of ex.motion) {
      drawn = comp._drawLayer({ ...inner, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, sx: s.sx ?? 1, sy: s.sy ?? 1, opacity: layer.opacity / n }, time) || drawn;
    }
  } else {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    drawn = comp._drawLayer(inner, time);
  }
  if (!drawn) {
    restore();
    return false;
  }
  let cur = bufA;
  const other = () => (cur === bufA ? bufB : bufA);
  gl.disable(gl.BLEND);
  if (ex.denoise) {
    const out = other();
    comp._into(out);
    const p = comp._use(comp._program('clipDenoise', FULL_VS, DENOISE_FS));
    comp._bindTex(0, cur.tex);
    comp._seti(p, 'u_tex', 0);
    comp._set(p, 'u_texel', 1 / cur.w, 1 / cur.h);
    comp._set(p, 'u_strength', ex.denoise);
    comp._set(p, 'u_step', Math.max(1, comp.width / (comp.projW || 1)));
    comp._fullPass(p);
    cur = out;
  }
  if (ex.relight) {
    const info = comp.resolve(layer);
    const box = comp.layerBox(layer, info);
    const a = (layer.rotation * Math.PI) / 180;
    const hw = (Math.abs(box.w * Math.cos(a)) + Math.abs(box.h * Math.sin(a))) / 2;
    const hh = (Math.abs(box.w * Math.sin(a)) + Math.abs(box.h * Math.cos(a))) / 2;
    const out = other();
    comp._into(out);
    const p = comp._use(comp._program('clipRelight', FULL_VS, RELIGHT_FS));
    comp._bindTex(0, cur.tex);
    comp._seti(p, 'u_tex', 0);
    comp._set(p, 'u_center', box.cx / comp.projW, 1 - box.cy / comp.projH);
    comp._set(p, 'u_half', hw / comp.projW, hh / comp.projH);
    const la = (ex.relight.angle * Math.PI) / 180;
    comp._set(p, 'u_dir', Math.cos(la), Math.sin(la));
    comp._set(p, 'u_intensity', ex.relight.intensity);
    comp._set(p, 'u_temp', ex.relight.temperature);
    comp._fullPass(p);
    cur = out;
  }
  comp._into(dst);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  comp._copy(cur.tex);
  restore();
  return true;
}
