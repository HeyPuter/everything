/**
 * Effect rendering for the compositor: one full-frame effect pass (effect
 * tracks and clip stacks share it) and per-clip effect stacks.
 *
 * A clip with effects is drawn untransformed into its own buffer (its size on
 * screen, bucketed so animated scale does not reallocate every frame), the
 * effects run there in order, then the result is placed on the canvas with
 * the clip's position, scale, rotation, opacity and animation blur. Effects
 * therefore move with the clip, and blend modes and transitions see the
 * finished clip.
 */
import { FULL_VS, QUAD_VS, PLACE_FS, effectShader } from './shaders.js';
import { effectIsOff, effectUniforms } from '../model/effect-params.js';
import { isBodyEffect } from '../model/body-effects.js';
import { bindPersonMatte, MATTE_UNIT } from './cutout.js';

const failed = new Set();

/** Lazily compiled effect program; null (and one warning) if it fails to build. */
function fxProgram(comp, id) {
  if (failed.has(id)) return null;
  const fs = effectShader(id);
  if (!fs) return null;
  try {
    return comp._program(`fx:${id}`, FULL_VS, fs);
  } catch (err) {
    failed.add(id);
    console.warn(`Effect ${id} is unavailable:`, err?.message || err);
    return null;
  }
}

/**
 * Run one effect from src into dst (both { fb, tex, w, h }). Returns false
 * when nothing was drawn (effect off at these params, unknown, or broken),
 * in which case dst is untouched and src still holds the picture.
 */
export function effectPass(comp, id, params, src, dst, { time = 0, duration = 0 } = {}, person = null) {
  if (effectIsOff(id, params)) return false;
  // Body effects need the clip's person matte (only in a clip's own stack).
  if (isBodyEffect(id) && !person) return false;
  const prog = fxProgram(comp, id);
  if (!prog) return false;
  const gl = comp.gl;
  comp._into(dst);
  gl.disable(gl.BLEND);
  const p = comp._use(prog);
  comp._bindTex(0, src.tex);
  comp._seti(p, 'u_tex', 0);
  comp._set(p, 'u_texel', 1 / src.w, 1 / src.h);
  comp._set(p, 'u_res', src.w, src.h);
  comp._set(p, 'u_px', comp.pxScale);
  comp._set(p, 'u_time', time);
  comp._set(p, 'u_dur', duration);
  for (const [name, value] of effectUniforms(id, params)) comp._set(p, name, value);
  if (person) {
    comp._bindTex(MATTE_UNIT, person.tex);
    comp._seti(p, 'u_person', MATTE_UNIT);
    comp._set(p, 'u_personRect', person.rect);
    comp._set(p, 'u_personFlip', person.flip[0], person.flip[1]);
    comp._set(p, 'u_personTexel', person.texel[0], person.texel[1]);
    comp._bindTex(0, src.tex);
  }
  comp._fullPass(p);
  return true;
}

/* Buffers for clip effects, pooled by size --------------------------------- */

function makeTarget(gl, w, h, float) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { fb, tex, w, h, used: 0 };
}

/**
 * A pooled render target of w x h for a slot (RGBA8, or half float with
 * float: true, which needs EXT_color_buffer_float). Also used by the
 * slow motion passes (slow-motion.js).
 */
export function poolTarget(comp, slot, w, h, float = false) {
  const pool = (comp.clipFxPool ||= new Map());
  const key = `${slot}:${w}x${h}${float ? 'f' : ''}`;
  let t = pool.get(key);
  if (!t) {
    // Drop buffers nobody used for a while (clips that left, old sizes).
    for (const [k, e] of pool) {
      if (comp.frame - e.used > 90) {
        comp.gl.deleteFramebuffer(e.fb);
        comp.gl.deleteTexture(e.tex);
        pool.delete(k);
      }
    }
    t = makeTarget(comp.gl, w, h, float);
    pool.set(key, t);
  }
  t.used = comp.frame;
  return t;
}

/** Free the clip effect buffers (dispose, context loss). */
export function freeClipFx(comp, { lost = false } = {}) {
  const pool = comp.clipFxPool;
  if (!pool) return;
  if (!lost) {
    for (const e of pool.values()) {
      comp.gl.deleteFramebuffer(e.fb);
      comp.gl.deleteTexture(e.tex);
    }
  }
  comp.clipFxPool = null;
}

/** The person matte of a media layer, mapped to its effect buffer, or null. */
function personFor(comp, layer, info) {
  if (layer.kind !== 'media' || !layer.clip) return null;
  const t = bindPersonMatte(comp, layer, info);
  if (!t) return null;
  const c = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
  const rect = [c.l, c.b, Math.max(0.05, 1 - c.l - c.r), Math.max(0.05, 1 - c.t - c.b)];
  return { tex: t.tex, rect, flip: [layer.flipH ? 1 : 0, layer.flipV ? 1 : 0], texel: [1 / t.mw / rect[2], 1 / t.mh / rect[3]] };
}

/** Scale steps of 2^(1/2) so animated zooms reuse buffers. */
const bucket = (s) => 2 ** (Math.ceil(Math.log2(Math.max(1e-3, s)) * 2) / 2);

/**
 * Draw a visual layer that carries layer.effects into the target bound by
 * the caller (blending premultiplied over it). Falls back to a plain draw
 * when the layer has no effects.
 */
export function drawLayerWithEffects(comp, layer, time) {
  const list = layer.effects;
  if (!list?.length) return comp._drawLayer(layer, time);
  const info = comp.resolve(layer);
  if (!info || !info.source) return false;
  const box = comp.layerBox(layer, info);
  const scale = Math.abs(layer.scale);
  if (!(scale > 1e-4) || !(box.w > 0) || !(box.h > 0)) return false;
  const natW = box.w / scale;
  const natH = box.h / scale;
  // Buffer size: the clip's size on screen (in output pixels), bucketed and capped.
  const k = comp.width / comp.projW;
  let sz = bucket(scale) * k;
  const cap = (2 * Math.max(comp.width, comp.height)) / Math.max(natW, natH);
  sz = Math.min(sz, cap);
  const w = Math.max(2, Math.round(natW * sz));
  const h = Math.max(2, Math.round(natH * sz));
  const gl = comp.gl;
  const back = comp.bound ?? null;
  let cur = poolTarget(comp, 'a', w, h);
  let other = poolTarget(comp, 'b', w, h);

  // 1. The clip's own pixels (crop, color, mask, chroma key), untransformed.
  comp._into(cur);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const saved = { projW: comp.projW, projH: comp.projH, resolve: comp.resolve };
  comp.projW = natW;
  comp.projH = natH;
  comp.resolve = () => info;
  let ok;
  try {
    ok = comp._drawLayer({ ...layer, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, blur: 0 }, time);
  } finally {
    comp.projW = saved.projW;
    comp.projH = saved.projH;
    comp.resolve = saved.resolve;
  }
  if (!ok) {
    comp._into(back);
    return false;
  }

  // 2. The effect stack, ping-ponging between the two buffers.
  const timing = { time: (layer.fxTime || 0) / 1e6, duration: (layer.fxDur || 0) / 1e6 };
  const person = list.some((fx) => isBodyEffect(fx.id)) ? personFor(comp, layer, info) : null;
  for (const fx of list) {
    if (effectPass(comp, fx.id, fx.params, cur, other, timing, person)) [cur, other] = [other, cur];
  }

  // 3. Place the result with the clip's transform.
  comp._into(back);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const p = comp._use(comp._program('clipfx-place', QUAD_VS, PLACE_FS));
  comp._set(p, 'u_matrix', comp._matrix(box.cx, box.cy, box.w, box.h, layer.rotation));
  comp._set(p, 'u_uvRect', [0, 0, 1, 1]);
  comp._set(p, 'u_flip', 0, 0);
  comp._set(p, 'u_opacity', layer.opacity);
  comp._set(p, 'u_texel', 1 / w, 1 / h);
  // Sized as at the project's own resolution, so the preview blurs as much as the export.
  comp._set(p, 'u_blur', layer.blur > 0 ? layer.blur * 4 * Math.max(1, w / k / 640) * k : 0);
  comp._bindTex(0, cur.tex);
  comp._seti(p, 'u_tex', 0);
  gl.bindVertexArray(comp.vao);
  comp._draw();
  return true;
}
