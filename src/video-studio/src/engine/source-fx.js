/**
 * Passes on a media layer's source picture before it is placed. The
 * compositor hands the uploaded source here (Compositor._drawLayer) and
 * draws whatever comes back, so everything after (crop, color, masks,
 * cutout, effects, transitions) sees one ordinary picture, the way the
 * in-between frames of smooth slow motion do. Exports run the same code.
 *
 *  - Object removal (model/removal.js): the regions are rasterized into a
 *    coverage image (feathered) and filled from the pixels around them with
 *    a push-pull pyramid. Pull averages the known pixels down level by level
 *    (holes count for nothing), push brings the averages back up into the
 *    holes with a smooth cubic, so the fill flows in from every side and
 *    meets the picture without a seam. The noise around the hole is
 *    measured and filled the same way, then added back as grain so the
 *    fill does not look smeared.
 *  - Enhance (model/clip-extras.js): when the source is shown larger than
 *    it is, a Lanczos upscale to the shown size, clamped to the nearest
 *    source pixels so edges stay crisp without ringing; then contrast-
 *    adaptive sharpening (strongest where there is room, kept inside the
 *    local range so there are no halos) and a gentle local detail boost
 *    that leaves strong edges alone.
 *
 * Results are cached per clip and source frame, so the several draws of one
 * layer in a frame (canvas fill, motion blur samples) compute them once.
 */
import { FULL_VS } from './shaders.js';
import { poolTarget } from './fx-render.js';
import { MaskRaster } from './mask-raster.js';

/** Long side of the removal pyramid's finest level and of the coverage image. */
export const FILL_MAX = 2048;
export const COVER_MAX = 1024;
/** Upscale steps (the enhanced picture is redrawn only when the step changes) and the cap. */
export const UPSCALE_STEP = 0.25;
export const UPSCALE_MAX = 3;
const TEX_MAX = 4096;

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
`;

/** Finest pyramid level: the picture with how much each pixel is known (0 inside a region). */
export const REMOVE_PREP_FS = `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_cov;
void main() {
  vec4 c = texture(u_src, v_uv);
  float cov = texture(u_cov, v_uv).a;
  // The hole reaches a little past the painted edge (into the feather) so fringes are not copied in.
  float known = (1.0 - smoothstep(0.02, 0.12, cov)) * step(0.004, c.a);
  outColor = vec4(c.rgb, known);
}`;

/** Noise around the hole: mean absolute deviation of luma from its four neighbors (x10, capped). */
export const REMOVE_DETAIL_FS = `${HEAD}
uniform sampler2D u_tex;
const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(u_tex, 0) - 1;
  vec4 c = texelFetch(u_tex, p, 0);
  vec4 l = texelFetch(u_tex, clamp(p + ivec2(-1, 0), ivec2(0), hi), 0);
  vec4 r = texelFetch(u_tex, clamp(p + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 d = texelFetch(u_tex, clamp(p + ivec2(0, -1), ivec2(0), hi), 0);
  vec4 u = texelFetch(u_tex, clamp(p + ivec2(0, 1), ivec2(0), hi), 0);
  float known = min(c.a, min(min(l.a, r.a), min(d.a, u.a)));
  float dev = dot(c.rgb, Y) - 0.25 * (dot(l.rgb, Y) + dot(r.rgb, Y) + dot(d.rgb, Y) + dot(u.rgb, Y));
  // Edges are capped so they do not read as noise.
  outColor = vec4(vec3(min(abs(dev), 0.08) * 10.0), known);
}`;

/**
 * Pull: half-size level from the known pixels only (4x4 tent). rgb is the
 * weighted average, a how sure it is (any known pixel nearby makes it sure).
 */
export const PULL_FS = `${HEAD}
uniform sampler2D u_tex;
void main() {
  ivec2 hi = textureSize(u_tex, 0) - 1;
  ivec2 base = ivec2(gl_FragCoord.xy) * 2 - 1;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 4; j++) {
    float wy = (j == 0 || j == 3) ? 1.0 : 3.0;
    for (int i = 0; i < 4; i++) {
      float w = wy * ((i == 0 || i == 3) ? 1.0 : 3.0);
      vec4 s = texelFetch(u_tex, clamp(base + ivec2(i, j), ivec2(0), hi), 0);
      acc += s.rgb * (w * s.a);
      wsum += w * s.a;
    }
  }
  outColor = vec4(wsum > 0.0 ? acc / wsum : vec3(0.0), min(1.0, wsum / 16.0));
}`;

/** Push: the level's known pixels over the filled coarser level (cubic B-spline, no blocky steps). */
export const PUSH_FS = `${HEAD}
uniform sampler2D u_fine;
uniform sampler2D u_coarse;
uniform vec2 u_coarseSize;
vec4 bspline(sampler2D t, vec2 pos, vec2 size) {
  vec2 p = pos - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y)))
    + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));
}
void main() {
  vec4 fine = texelFetch(u_fine, ivec2(gl_FragCoord.xy), 0);
  vec3 coarse = bspline(u_coarse, gl_FragCoord.xy * 0.5, u_coarseSize).rgb;
  outColor = vec4(mix(coarse, fine.rgb, fine.a), 1.0);
}`;

/** The source with the filled regions blended in (feathered), plus matched grain. */
export const REMOVE_FINAL_FS = `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_cov;
uniform sampler2D u_fill;
uniform sampler2D u_detail;
uniform float u_grain;
uniform int u_seed;
uint mixBits(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float rnd(uvec2 p, uint k) {
  return float(mixBits(p.x * 1973u + p.y * 9277u + k * 26699u + uint(u_seed) * 7919u) >> 8) / 16777215.0;
}
void main() {
  vec4 o = texture(u_src, v_uv);
  float cov = texture(u_cov, v_uv).a;
  float w = smoothstep(0.02, 0.5, cov);
  if (w <= 0.0) { outColor = o; return; }
  vec3 f = texture(u_fill, v_uv).rgb;
  if (u_grain > 0.0) {
    // Mean absolute deviation (stored x10) to a standard deviation.
    float sigma = texture(u_detail, v_uv).r * 0.1121;
    uvec2 p = uvec2(gl_FragCoord.xy);
    float n = (rnd(p, 0u) + rnd(p, 1u) + rnd(p, 2u) - 1.5) * 2.0;
    vec3 tint = vec3(rnd(p, 3u), rnd(p, 4u), rnd(p, 5u)) - 0.5;
    f += (vec3(n) + tint * 0.6) * sigma * u_grain;
  }
  outColor = vec4(mix(o.rgb, clamp(f, 0.0, 1.0), w), o.a);
}`;

/**
 * Lanczos (a = 2) upscale over 4x4 source pixels, clamped to the range of
 * the 2x2 nearest so edges get no ringing. Filters premultiplied so
 * transparent pixels do not bleed in.
 */
export const UPSCALE_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_srcSize;
float lanczos2(float x) {
  x = abs(x);
  if (x < 1e-4) return 1.0;
  if (x >= 2.0) return 0.0;
  float px = 3.14159265 * x;
  return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}
void main() {
  vec2 pos = v_uv * u_srcSize - 0.5;
  vec2 base = floor(pos);
  vec2 f = pos - base;
  ivec2 hi = ivec2(u_srcSize) - 1;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  vec4 lo = vec4(1.0);
  vec4 hiC = vec4(0.0);
  for (int j = -1; j <= 2; j++) {
    float wy = lanczos2(float(j) - f.y);
    for (int i = -1; i <= 2; i++) {
      float w = lanczos2(float(i) - f.x) * wy;
      vec4 s = texelFetch(u_tex, clamp(ivec2(base) + ivec2(i, j), ivec2(0), hi), 0);
      s.rgb *= s.a;
      acc += s * w;
      wsum += w;
      if (i >= 0 && i <= 1 && j >= 0 && j <= 1) {
        lo = min(lo, s);
        hiC = max(hiC, s);
      }
    }
  }
  vec4 c = clamp(acc / wsum, lo, hiC);
  outColor = vec4(c.a > 0.0 ? c.rgb / c.a : vec3(0.0), c.a);
}`;

/**
 * Contrast-adaptive sharpening plus a local detail boost. The sharpening
 * weight shrinks where the neighborhood is near black or white or already
 * contrasty, and the result stays inside the local min/max (no halos). The
 * detail boost lifts fine texture against a wider average and fades out on
 * strong edges.
 */
export const ENHANCE_FS = `${HEAD}
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_step;
uniform float u_sharp;
uniform float u_detail;
const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
vec3 at(vec2 o) { return texture(u_tex, v_uv + o * u_texel).rgb; }
void main() {
  vec4 c0 = texture(u_tex, v_uv);
  vec3 c = c0.rgb;
  float s = u_step;
  vec3 n = at(vec2(0.0, s));
  vec3 so = at(vec2(0.0, -s));
  vec3 e = at(vec2(s, 0.0));
  vec3 w = at(vec2(-s, 0.0));
  vec3 mn = min(c, min(min(n, so), min(e, w)));
  vec3 mx = max(c, max(max(n, so), max(e, w)));
  vec3 d1 = at(vec2(s, s));
  vec3 d2 = at(vec2(-s, s));
  vec3 d3 = at(vec2(s, -s));
  vec3 d4 = at(vec2(-s, -s));
  vec3 mn2 = min(mn, min(min(d1, d2), min(d3, d4)));
  vec3 mx2 = max(mx, max(max(d1, d2), max(d3, d4)));
  mn = 0.5 * (mn + mn2);
  mx = 0.5 * (mx + mx2);
  vec3 room = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  vec3 k = -sqrt(room) * (0.18 * u_sharp);
  vec3 sharp = (c + (n + so + e + w) * k) / (1.0 + 4.0 * k);
  sharp = clamp(sharp, mn2, mx2);
  float r = s * 3.0;
  float avg = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.3926991;
    avg += dot(at(vec2(cos(a), sin(a)) * r), Y) + dot(at(vec2(cos(a), sin(a)) * r * 0.5), Y);
  }
  avg /= 16.0;
  float dl = dot(c, Y) - avg;
  float boost = u_detail * dl * (1.0 - smoothstep(0.05, 0.18, abs(dl)));
  outColor = vec4(clamp(sharp + boost, 0.0, 1.0), c0.a);
}`;

/** Pyramid level sizes from w x h down to 1 x 1. */
export function pyramidLevels(w, h) {
  const out = [{ w, h }];
  while (w > 1 || h > 1) {
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
    out.push({ w, h });
  }
  return out;
}

/** Size of the finest fill level for a source (long side at most FILL_MAX). */
export function fillSize(sw, sh) {
  const k = Math.min(1, FILL_MAX / Math.max(sw, sh));
  return { w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
}

/**
 * Size to enhance at: the source enlarged to about the size it is shown
 * (in steps, at most UPSCALE_MAX times and TEX_MAX pixels), or the source
 * size when it is not shown larger. shownW: output pixels across the whole
 * (uncropped) source.
 */
export function enhanceSize(sw, sh, shownW) {
  let s = shownW / sw;
  s = Number.isFinite(s) ? Math.min(UPSCALE_MAX, Math.floor(s / UPSCALE_STEP) * UPSCALE_STEP) : 1;
  if (s <= 1) return { w: sw, h: sh, scale: 1 };
  s = Math.min(s, TEX_MAX / Math.max(sw, sh));
  if (s <= 1) return { w: sw, h: sh, scale: 1 };
  return { w: Math.round(sw * s), h: Math.round(sh * s), scale: s };
}

/** Enhance pass amounts for a strength 0..1 at an upscale. */
export function enhanceAmounts(strength, scale = 1) {
  return { sharp: strength, detail: 0.6 * strength, step: Math.min(2.5, Math.max(1, scale * 0.6)) };
}

function pass(comp, key, fs, target, uniforms, textures) {
  const p = comp._use(comp._program(key, FULL_VS, fs));
  comp._into(target);
  textures.forEach(([name, tex], i) => {
    comp._bindTex(i, tex);
    comp._seti(p, name, i);
  });
  for (const [name, v] of Object.entries(uniforms)) {
    if (name.startsWith('i:')) comp._seti(p, name.slice(2), v);
    else if (Array.isArray(v)) comp._set(p, name, v[0], v[1]);
    else comp._set(p, name, v);
  }
  comp._fullPass(p);
}

/** Push-pull fill of a level-0 target (rgb + known); returns the filled level 0. */
function pushPull(comp, slot, level0, levels) {
  const pulled = [level0];
  for (let i = 1; i < levels.length; i++) {
    const t = poolTarget(comp, `${slot}-pull${i}`, levels[i].w, levels[i].h);
    pass(comp, 'srcfx-pull', PULL_FS, t, {}, [['u_tex', pulled[i - 1].tex]]);
    pulled.push(t);
  }
  let coarse = pulled[levels.length - 1];
  for (let i = levels.length - 2; i >= 0; i--) {
    const t = poolTarget(comp, `${slot}-fill${i}`, levels[i].w, levels[i].h);
    pass(comp, 'srcfx-push', PUSH_FS, t, { u_coarseSize: [coarse.w, coarse.h] }, [['u_fine', pulled[i].tex], ['u_coarse', coarse.tex]]);
    coarse = t;
  }
  return coarse;
}

/** Coverage texture of the removal regions, or null. */
function coverageTexture(comp, layer, sw, sh) {
  comp._removalRaster ||= new MaskRaster();
  const id = layer.clip?.id || 'clip';
  const r = comp._removalRaster.get(`rm:${id}`, layer.removal.masks, layer.width || sw, layer.height || sh, Math.min(COVER_MAX, Math.max(sw, sh)));
  if (!r) return null;
  const e = comp._texture({ key: `rmcov:${id}`, source: r.canvas, width: r.width, height: r.height, version: r.key });
  return e ? { tex: e.tex, key: r.key } : null;
}

/** Fill the removal regions of src (w x h); returns the target holding the result. */
function drawRemoval(comp, layer, src, cov, w, h, seed) {
  const id = layer.clip?.id || 'clip';
  const fs = fillSize(w, h);
  const levels = pyramidLevels(fs.w, fs.h);
  const level0 = poolTarget(comp, 'srcfx-prep', fs.w, fs.h);
  pass(comp, 'srcfx-prep', REMOVE_PREP_FS, level0, {}, [['u_src', src], ['u_cov', cov]]);
  const fill = pushPull(comp, 'srcfx', level0, levels);
  const grain = layer.removal.grain || 0;
  let detail = fill;
  if (grain > 0) {
    const d0 = poolTarget(comp, 'srcfx-dprep', fs.w, fs.h);
    pass(comp, 'srcfx-detail', REMOVE_DETAIL_FS, d0, {}, [['u_tex', level0.tex]]);
    detail = pushPull(comp, 'srcfx-d', d0, levels);
  }
  const out = poolTarget(comp, `srcfx-rm:${id}`, w, h);
  pass(comp, 'srcfx-final', REMOVE_FINAL_FS, out, { u_grain: grain, 'i:u_seed': seed }, [['u_src', src], ['u_cov', cov], ['u_fill', fill.tex], ['u_detail', detail.tex]]);
  return out;
}

/** Enhance src (w x h) at size; returns the target holding the result. */
function drawEnhance(comp, layer, src, w, h, size) {
  const id = layer.clip?.id || 'clip';
  let tex = src;
  if (size.scale > 1) {
    const up = poolTarget(comp, `srcfx-up:${id}`, size.w, size.h);
    pass(comp, 'srcfx-up', UPSCALE_FS, up, { u_srcSize: [w, h] }, [['u_tex', src]]);
    tex = up.tex;
  }
  const a = enhanceAmounts(layer.enhance.strength, size.scale);
  const out = poolTarget(comp, `srcfx-en:${id}`, size.w, size.h);
  pass(comp, 'srcfx-enhance', ENHANCE_FS, out, { u_texel: [1 / size.w, 1 / size.h], u_step: a.step, u_sharp: a.sharp, u_detail: a.detail }, [['u_tex', tex]]);
  return out;
}

/** Output pixels across the whole uncropped source as the layer is drawn now. */
export function shownWidth(comp, layer, info) {
  const box = comp.layerBox(layer, info);
  const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
  return (Math.abs(box.w) / Math.max(0.05, 1 - crop.l - crop.r)) * (comp.width / (comp.projW || 1));
}

/**
 * Run the layer's source passes on an uploaded texture entry. Returns an
 * entry-like { tex, w, h, version, ok, used } to draw in its place, or the
 * entry itself when nothing applies. Leaves the bound target, blending and
 * the active texture unit as they were.
 */
export function processSource(comp, layer, info, entry, time = 0) {
  if (!layer.removal && !layer.enhance) return entry;
  const w = entry.w || info.width;
  const h = entry.h || info.height;
  if (!(w > 1 && h > 1)) return entry;
  const gl = comp.gl;
  const unit = gl.getParameter(gl.ACTIVE_TEXTURE);
  const id = layer.clip?.id || 'clip';
  const cov = layer.removal ? coverageTexture(comp, layer, w, h) : null;
  const size = layer.enhance ? enhanceSize(w, h, shownWidth(comp, layer, info)) : null;
  if (!cov && !size) {
    gl.activeTexture(unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    return entry;
  }
  const back = comp._bound || null;
  const blendOn = gl.isEnabled(gl.BLEND);
  // Video grain changes every frame; a still keeps one pattern.
  const seed = cov && layer.clip?.type !== 'image' ? Math.round(time * 1000) % 1000003 : 0;
  const ver = info.dynamic ? `d${comp.frame}` : String(entry.version);
  const sig = [info.key, ver, w, h, cov?.key ?? '-', cov ? layer.removal.grain : '-', seed, size ? `${layer.enhance.strength}|${size.w}x${size.h}` : '-'].join('|');
  const finalKey = size ? `srcfx-en:${id}` : `srcfx-rm:${id}`;
  const out = poolTarget(comp, finalKey, size ? size.w : w, size ? size.h : h);
  const cache = (comp.srcFxCache ||= new Map());
  const hit = cache.get(finalKey);
  if (!hit || hit.target !== out || hit.sig !== sig) {
    gl.disable(gl.BLEND);
    let src = entry.tex;
    if (cov) src = drawRemoval(comp, layer, src, cov.tex, w, h, seed).tex;
    if (size) drawEnhance(comp, layer, src, w, h, size);
    comp._into(back);
    if (blendOn) gl.enable(gl.BLEND);
    cache.set(finalKey, { target: out, sig });
    // Forget clips that left (their buffers leave the pool on their own).
    if (cache.size > 32) for (const k of [...cache.keys()].slice(0, cache.size - 32)) cache.delete(k);
  }
  gl.activeTexture(unit);
  gl.bindTexture(gl.TEXTURE_2D, out.tex);
  return { tex: out.tex, w: out.w, h: out.h, version: sig, ok: true, used: comp.frame };
}
