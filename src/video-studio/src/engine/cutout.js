/**
 * Compositor side of automatic background removal (model/cutout.js) and
 * skin retouch (model/retouch.js): finds the person matte of the frame a
 * layer is showing, keeps it per clip until the frame changes, and binds it
 * for LAYER_FS, which refines the soft low-resolution matte against the
 * full picture to cut the person out, and limits retouching to people. The
 * face and hair tools have their own models (engine/face-render.js).
 */
import { SEG_SIZE, segment, ready, segmenterState, onSegmenterChange } from '../media/segmenter.js';
import { matteWindow, steadyMatte, strokeOverride, applyOverride, CUTOUT_DEFAULT } from '../model/cutout.js';
import { retouchAmounts } from '../model/retouch.js';
import { clipUsesBodyEffect } from '../model/body-effects.js';
import { frameOf, drawUpright, faceModelsIn, ensureFaceModels, onFaceModelsReady, bindFaceLayer } from './face-render.js';
import { bindBodyLayer } from './body-render.js';

/** Texture unit of the matte (masks use 6). */
export const MATTE_UNIT = 7;

const makeCanvas = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** Whether a project has any clip that needs the person matte (background removal, retouch, body effects, person or background color). */
export function usesPersonMatte(project) {
  return (project?.tracks || []).some((t) => t.clips.some((c) => (c.cutout || retouchAmounts(c.retouch) || clipUsesBodyEffect(c) || c.colorTarget) && !c.disabled));
}

/** Whether a project needs any of the people models (person matte, face or pose landmarks, hair matte). */
export function usesCutout(project) {
  if (usesPersonMatte(project)) return true;
  const n = faceModelsIn(project);
  return n.face || n.hair || n.pose;
}

/** Load the models a project needs. Resolves to whether its people tools can render. */
export async function ensureCutout(project) {
  const ok = await Promise.all([usesPersonMatte(project) ? ready() : true, ensureFaceModels(project)]);
  return ok.every(Boolean);
}

/** Call fn whenever a people model finishes loading (to redraw). */
export function onCutoutReady(fn) {
  const a = onSegmenterChange((s) => {
    if (s === 'ready') fn();
  });
  const b = onFaceModelsReady(fn);
  return () => {
    a();
    b();
  };
}

/** Mattes per clip: the frame they were made from and the result. */
export class MatteCache {
  constructor() {
    this.entries = new Map(); // clipId -> { frameKey, raw (model matte), strokes, canvas, version, ... }
    this.input = null;
    this.inputCtx = null;
  }

  _input() {
    if (!this.input) {
      this.input = makeCanvas(SEG_SIZE, SEG_SIZE);
      this.inputCtx = this.input.getContext('2d', { willReadFrequently: true });
    }
    return this.inputCtx;
  }

  /**
   * Matte canvas for a layer showing `info` (the resolved source), or null
   * while the model loads. The canvas is upright and the size of the model.
   */
  get(layer, info) {
    if (segmenterState() !== 'ready') {
      ready();
      return null;
    }
    const src = info.source;
    const { sec, key: frameKey } = frameOf(layer, info);
    const strokes = layer.cutout?.strokes || null;
    let e = this.entries.get(layer.clip.id);
    if (e && e.frameKey === frameKey) {
      if (e.strokes !== strokes) this._compose(e, strokes, info);
      return e;
    }
    const m = this._segment(src);
    if (!m) return e || null;
    // Steady only between neighbouring frames of the same clip.
    const near = e && Math.abs(e.sec - sec) < 0.2 && e.raw.length === m.data.length;
    const raw = steadyMatte(m.data, near ? e.raw : null, layer.cutout?.smooth ?? CUTOUT_DEFAULT.smooth);
    if (!e) {
      e = { canvas: makeCanvas(m.width, m.height), version: 0, img: null, ov: null, ovFor: null };
      this.entries.set(layer.clip.id, e);
    }
    Object.assign(e, { frameKey, raw, sec, w: m.width, h: m.height });
    this._compose(e, strokes, info);
    return e;
  }

  /** Run the model on a frame; null when it cannot. */
  _segment(src) {
    if (!drawUpright(this._input(), src, SEG_SIZE, SEG_SIZE)) return null;
    try {
      return segment(this.input);
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  /** Hand-painted strokes over the model's matte, written to the matte canvas. */
  _compose(e, strokes, info) {
    let data = e.raw;
    if (strokes?.length) {
      if (e.ovFor !== strokes || e.ov?.length !== e.w * e.h) {
        e.ov = strokeOverride(strokes, e.w, e.h, (info.width || 1) / (info.height || 1));
        e.ovFor = strokes;
      }
      data = applyOverride(Uint8ClampedArray.from(e.raw), e.ov);
    }
    if (e.canvas.width !== e.w || e.canvas.height !== e.h) Object.assign(e.canvas, { width: e.w, height: e.h });
    if (!e.img || e.img.width !== e.w || e.img.height !== e.h) {
      e.img = new ImageData(e.w, e.h);
      e.img.data.fill(255);
    }
    const px = e.img.data;
    for (let i = 0; i < data.length; i++) px[i * 4 + 3] = data[i];
    e.canvas.getContext('2d').putImageData(e.img, 0, 0);
    e.strokes = strokes;
    e.version++;
  }

  dispose() {
    this.entries.clear();
  }
}

/**
 * Bind the person matte of a layer on MATTE_UNIT. Returns the texture
 * entry, null while the model loads (it starts loading), or undefined when
 * it cannot be had. comp.personMatte(layer, info), when set, supplies the
 * matte instead (look previews use a drawn one).
 */
export function bindPersonMatte(comp, layer, info) {
  let e;
  if (comp.personMatte) e = comp.personMatte(layer, info);
  else {
    comp._matteCache ||= new MatteCache();
    e = comp._matteCache.get(layer, info);
  }
  if (!e) return segmenterState() === 'failed' ? undefined : null;
  const gl = comp.gl;
  gl.activeTexture(gl.TEXTURE0 + MATTE_UNIT);
  const t = comp._texture({ key: `matte:${layer.clip.id}`, source: e.canvas, width: e.canvas.width, height: e.canvas.height, version: e.version });
  gl.activeTexture(gl.TEXTURE0);
  return t ? { ...t, mw: e.canvas.width, mh: e.canvas.height } : undefined;
}

/** Set the matte, cutout and retouch uniforms of the layer program for a layer drawn from `info`. */
export function bindLayerMatte(comp, p, layer, info) {
  let on = 0;
  const media = layer.kind === 'media' && layer.clip && info?.source;
  const cut = Boolean(media && layer.cutout);
  const touch = media ? retouchAmounts(layer.retouch) : null;
  const target = media ? COLOR_TARGETS[layer.colorTarget] || 0 : 0;
  if (cut || touch || target) {
    const t = bindPersonMatte(comp, layer, info);
    if (t) {
      on = 1;
      const [lo, hi] = matteWindow(layer.cutout);
      comp._set(p, 'u_matteWin', lo, hi);
      comp._set(p, 'u_matteTexel', 1 / t.mw, 1 / t.mh);
    } else if (t === null) {
      // Still loading: hide a cut-out clip rather than flash its background.
      on = 2;
    }
  }
  comp._seti(p, 'u_matteTex', MATTE_UNIT);
  comp._seti(p, 'u_matteOn', on);
  comp._seti(p, 'u_cutOn', cut ? 1 : 0);
  comp._seti(p, 'u_retouchOn', touch ? 1 : 0);
  if (touch) comp._set(p, 'u_retouch', touch);
  comp._seti(p, 'u_colorTarget', target);
  comp._seti(p, 'u_maskColor', media && layer.maskUse === 'color' && layer.masks?.length ? 1 : 0);
  bindBodyLayer(comp, p, layer, info);
  bindFaceLayer(comp, p, layer, info);
}

const COLOR_TARGETS = { person: 1, background: 2 };
