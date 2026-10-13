/**
 * Compositor side of the face and hair tools (model/retouch.js): finds the
 * face landmarks and the hair matte of the frame a layer is showing, keeps
 * them per clip until the frame changes (steadying landmarks between
 * neighbouring frames), and binds what LAYER_FS needs:
 *  - face shape: warp handles in a small float texture (WARP_UNIT)
 *  - skin fixes: region masks around the faces (FACE_MASK_UNIT)
 *  - hair color: the hair matte of a square around the heads (HAIR_UNIT)
 *  - makeup: color and sculpt region masks (MAKEUP_UNIT, SCULPT_UNIT)
 * Body shape has its own landmarks (engine/body-render.js). Landmarks and masks live in source pixels with y down; the shader maps
 * its source uv (y up) to them.
 */
import { detectFaces, faceModelReady, faceModelState, onFaceModelChange } from '../media/face-landmarks.js';
import { HAIR_SIZE, segmentHair, hairModelReady, hairModelState, onHairModelChange } from '../media/hair-segmenter.js';
import { trackFaces, warpPlan, packHandles, faceMasks, faceWidth, spotRadius, hairRegion } from './face-geometry.js';
import { steadyMatte } from '../model/cutout.js';
import { makeupMasks } from './makeup-geometry.js';
import { poseModelReady, onPoseModelChange } from '../media/pose-landmarks.js';
import { faceShapeAmounts, skinFixAmounts, hairColorOn, faceModelsFor, makeupAmounts } from '../model/retouch.js';

export const FACE_MASK_UNIT = 8;
export const HAIR_UNIT = 9;
export const WARP_UNIT = 10;
export const MAKEUP_UNIT = 12;
export const SCULPT_UNIT = 13;

/** Longest side of the picture the face model is given. */
const DETECT_SIDE = 640;

const makeCanvas = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** The source time of a layer and a key that changes with the frame it shows. */
export function frameOf(layer, info) {
  const src = info.source;
  const sec = typeof src?.currentTime === 'number' ? src.currentTime : (layer.sourceTime || 0) / 1e6;
  return { sec, key: `${info.key}|${info.version ?? ''}|${info.dynamic ? sec.toFixed(4) : ''}|${layer.sourceTime || 0}` };
}

/**
 * Draw a frame upright into a 2D context of size w x h, the whole frame or
 * the part crop = [x, y, w, h] of it (source pixels, y down; srcH is the
 * frame's height). Bitmaps reach the compositor upside down (WebGL ignores
 * UNPACK_FLIP_Y for them) and are turned back here.
 */
export function drawUpright(g, src, w, h, crop = null, srcH = 0) {
  g.save();
  g.clearRect(0, 0, w, h);
  const flipped = typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap;
  if (flipped) {
    g.translate(0, h);
    g.scale(1, -1);
  }
  try {
    if (crop) g.drawImage(src, crop[0], flipped ? srcH - crop[1] - crop[3] : crop[1], crop[2], crop[3], 0, 0, w, h);
    else g.drawImage(src, 0, 0, w, h);
    return true;
  } catch {
    return false;
  } finally {
    g.restore();
  }
}

/** Whether a project uses the face, hair or pose model, by model. */
export function faceModelsIn(project) {
  const out = { face: false, hair: false, pose: false };
  for (const t of project?.tracks || []) {
    for (const c of t.clips) {
      const n = faceModelsFor(c);
      out.face ||= n.face;
      out.hair ||= n.hair;
      out.pose ||= n.pose;
    }
  }
  return out;
}

/** Load the face, hair and pose models a project needs. Resolves to whether they can render. */
export async function ensureFaceModels(project) {
  const n = faceModelsIn(project);
  const ok = await Promise.all([n.face ? faceModelReady() : true, n.hair ? hairModelReady() : true, n.pose ? poseModelReady() : true]);
  return ok.every(Boolean);
}

/** Call fn whenever the face, hair or pose model finishes loading. */
export function onFaceModelsReady(fn) {
  const offs = [onFaceModelChange, onHairModelChange, onPoseModelChange].map((on) => on((s) => s === 'ready' && fn()));
  return () => offs.forEach((off) => off());
}

/** Landmarks per clip: the frame they were found on and the faces, steadied. */
export class FaceCache {
  constructor() {
    this.entries = new Map(); // clipId -> { frameKey, sec, W, H, tracks, faces, version, masks, makeup, plan... }
    this.input = null;
    this.ctx = null;
  }

  /** Faces (source pixels) on the frame of a layer, or null while the model loads. */
  get(layer, info) {
    if (faceModelState() !== 'ready') {
      faceModelReady();
      return null;
    }
    const { sec, key } = frameOf(layer, info);
    let e = this.entries.get(layer.clip.id);
    if (e && e.frameKey === key) return e;
    const W = info.width || layer.width || 1;
    const H = info.height || layer.height || 1;
    const found = this._detect(info.source, W, H);
    if (!found) return e || null;
    const near = e && e.W === W && e.H === H && Math.abs(e.sec - sec) < 0.25;
    const tracks = trackFaces(near ? e.tracks : null, found, sec, near ? Math.abs(sec - e.sec) : 0);
    if (!e) {
      e = { version: 0, masks: null, masksFor: -1, makeup: null, makeupFor: -1, plan: null, planFor: '', planVersion: 0 };
      this.entries.set(layer.clip.id, e);
    }
    Object.assign(e, { frameKey: key, sec, W, H, tracks, faces: tracks.map((t) => t.pts) });
    e.version++;
    return e;
  }

  _detect(src, W, H) {
    const k = Math.min(1, DETECT_SIDE / Math.max(W, H));
    const w = Math.max(16, Math.round(W * k));
    const h = Math.max(16, Math.round(H * k));
    if (!this.input) {
      this.input = makeCanvas(w, h);
      this.ctx = this.input.getContext('2d', { willReadFrequently: true });
    }
    if (this.input.width !== w || this.input.height !== h) Object.assign(this.input, { width: w, height: h });
    if (!drawUpright(this.ctx, src, w, h)) return null;
    let faces;
    try {
      faces = detectFaces(this.input);
    } catch (err) {
      console.error(err);
      return null;
    }
    if (!faces) return null;
    for (const f of faces) {
      for (let i = 0; i < f.length; i += 2) {
        f[i] *= W;
        f[i + 1] *= H;
      }
    }
    return faces;
  }

  /** Region masks of the skin fixes for an entry (made once per frame). */
  masks(e) {
    if (e.masksFor !== e.version) {
      e.masks = faceMasks(e.faces, e.W, e.H);
      e.masksFor = e.version;
    }
    return e.masks;
  }

  /** Makeup region masks for an entry (made once per frame). */
  makeup(e) {
    if (e.makeupFor !== e.version) {
      e.makeup = makeupMasks(e.faces, e.W, e.H);
      e.makeupFor = e.version;
    }
    return e.makeup;
  }

  /** Warp plan of an entry for the clip's face shape. */
  plan(e, amounts, which) {
    const k = `${e.version}|${which}|${Object.values(amounts).join(',')}`;
    if (e.planFor !== k) {
      e.plan = warpPlan(e.faces, amounts, which);
      e.planFor = k;
      e.planVersion++;
    }
    return e.plan;
  }

  dispose() {
    this.entries.clear();
  }
}

/**
 * Hair mattes per clip over a square around the heads (the framing the hair
 * model expects; elsewhere dark clothes can pass for hair), steadied
 * between neighbouring frames while the square stays put, with the hair's
 * mean brightness.
 */
export class HairCache {
  constructor() {
    this.entries = new Map();
    this.input = null;
    this.ctx = null;
  }

  /** Hair matte for a layer whose frame shows `faces` (source pixels), or null. */
  get(layer, info, faces, srcH) {
    if (hairModelState() !== 'ready') {
      hairModelReady();
      return null;
    }
    const rect = hairRegion(faces);
    if (!rect) return null;
    const { sec, key } = frameOf(layer, info);
    const frameKey = `${key}|${rect.join(',')}`;
    let e = this.entries.get(layer.clip.id);
    if (e && e.frameKey === frameKey) return e;
    if (!this.input) {
      this.input = makeCanvas(HAIR_SIZE, HAIR_SIZE);
      this.ctx = this.input.getContext('2d', { willReadFrequently: true });
    }
    if (!drawUpright(this.ctx, info.source, HAIR_SIZE, HAIR_SIZE, rect, srcH)) return e || null;
    let m;
    try {
      m = segmentHair(this.input);
    } catch (err) {
      console.error(err);
      return e || null;
    }
    if (!m) return e || null;
    const near = e && Math.abs(e.sec - sec) < 0.25 && e.raw.length === m.data.length;
    const raw = steadyMatte(m.data, near && e.rect.join() === rect.join() ? e.raw : null, 40);
    const luma = meanLuma(this.ctx.getImageData(0, 0, HAIR_SIZE, HAIR_SIZE).data, raw, HAIR_SIZE, HAIR_SIZE, m.width, m.height);
    if (!e) {
      e = { version: 0 };
      this.entries.set(layer.clip.id, e);
    }
    const prevLuma = near ? e.luma : null;
    Object.assign(e, { frameKey, rect, sec, raw, w: m.width, h: m.height, luma: luma == null ? prevLuma ?? 0.25 : prevLuma == null ? luma : prevLuma * 0.7 + luma * 0.3 });
    e.version++;
    return e;
  }

  dispose() {
    this.entries.clear();
  }
}

/**
 * Mean brightness (0..1) of the pixels a matte covers, weighted by it, or
 * null when it covers next to nothing. rgba is w x h; the matte mw x mh.
 */
export function meanLuma(rgba, matte, w, h, mw, mh) {
  let sum = 0;
  let wsum = 0;
  for (let y = 0; y < mh; y += 2) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / mh));
    for (let x = 0; x < mw; x += 2) {
      const a = matte[y * mw + x];
      if (a < 64) continue;
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / mw));
      const i = (sy * w + sx) * 4;
      sum += a * (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
      wsum += a;
    }
  }
  return wsum > 255 * 20 ? sum / wsum / 255 : null;
}

/** Upload (or reuse) a texture from raw data, kept with the compositor's textures. */
export function rawTexture(comp, unit, key, version, w, h, internal, format, type, data, filter) {
  const gl = comp.gl;
  gl.activeTexture(gl.TEXTURE0 + unit);
  let t = comp.textures.get(key);
  if (!t) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t = { tex, version: null, w: 0, h: 0, used: 0 };
    comp.textures.set(key, t);
  }
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  if (t.version !== version) {
    comp._rawUpload(() => gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data));
    Object.assign(t, { version, w, h });
  }
  t.used = comp.frame;
  gl.activeTexture(gl.TEXTURE0);
  return t;
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Set the face shape, skin fix, makeup and hair color uniforms of the layer program. */
export function bindFaceLayer(comp, p, layer, info) {
  const gl = comp.gl;
  const media = layer.kind === 'media' && layer.clip && info?.source;
  const shape = media ? faceShapeAmounts(layer.faceShape) : null;
  const fixes = media ? skinFixAmounts(layer.retouch) : null;
  const paint = media ? makeupAmounts(layer.makeup) : null;
  const hair = media && hairColorOn(layer.hairColor);
  let faces = 0;
  let fixOn = 0;
  let makeupOn = 0;
  let hairOn = 0;
  if (shape || fixes || paint || hair) {
    comp._faceCache ||= new FaceCache();
    const cache = comp._faceCache;
    const e = cache.get(layer, info);
    if (e?.faces.length) {
      const id = layer.clip.id;
      comp._set(p, 'u_srcSize', e.W, e.H);
      if (shape) {
        const plan = cache.plan(e, shape, layer.faceShape.faces);
        if (plan.handles.length) {
          rawTexture(comp, WARP_UNIT, `faceWarp:${id}`, `${e.planVersion}|${e.planFor}`, plan.handles.length, 3, gl.RGBA32F, gl.RGBA, gl.FLOAT, packHandles(plan.handles), gl.NEAREST);
          const fv = new Float32Array(12);
          const ends = [0, 0, 0];
          plan.groups.slice(0, 3).forEach((g, i) => {
            fv.set([g.cx, g.cy, g.reach, g.first], i * 4);
            ends[i] = g.end;
          });
          const loc = p.u.get('u_warpFace');
          if (loc) gl.uniform4fv(loc, fv);
          comp._set(p, 'u_warpEnd', ends);
          faces = Math.min(3, plan.groups.length);
        }
      }
      if (hair) {
        comp._hairCache ||= new HairCache();
        const he = comp._hairCache.get(layer, info, e.faces, e.H);
        if (he) {
          rawTexture(comp, HAIR_UNIT, `hair:${id}`, he.version, he.w, he.h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, he.raw, gl.LINEAR);
          comp._set(p, 'u_hairRect', he.rect);
          comp._set(p, 'u_hairTexel', 1 / he.w, 1 / he.h);
          comp._set(p, 'u_hairColor', hexRgb(layer.hairColor.color));
          comp._set(p, 'u_hairAmount', layer.hairColor.strength / 100);
          comp._set(p, 'u_hairLuma', he.luma);
          hairOn = 1;
        }
      }
      if (fixes) {
        const m = cache.masks(e);
        if (m) {
          rawTexture(comp, FACE_MASK_UNIT, `faceMask:${id}`, e.masksFor, m.width, m.height, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.data, gl.LINEAR);
          comp._set(p, 'u_faceMaskRect', m.rect);
          comp._set(p, 'u_faceFix', fixes);
          comp._set(p, 'u_lipColor', hexRgb(layer.retouch.lipColor || '#b8434e'));
          comp._set(p, 'u_spotR', spotRadius(Math.max(...e.faces.map(faceWidth))));
          fixOn = 1;
        }
      }
      if (paint) {
        const m = cache.makeup(e);
        if (m) {
          rawTexture(comp, MAKEUP_UNIT, `makeup:${id}`, e.makeupFor, m.width, m.height, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.color, gl.LINEAR);
          rawTexture(comp, SCULPT_UNIT, `sculpt:${id}`, e.makeupFor, m.width, m.height, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m.sculpt, gl.LINEAR);
          const [blush, shadow, liner, brows, contour, glow] = paint.colors.map(hexRgb);
          comp._set(p, 'u_makeupRect', m.rect);
          comp._set(p, 'u_makeup', paint.amounts.slice(0, 4));
          comp._set(p, 'u_sculpt', paint.amounts[4], paint.amounts[5]);
          comp._set(p, 'u_blushColor', blush);
          comp._set(p, 'u_shadowColor', shadow);
          comp._set(p, 'u_linerColor', liner);
          comp._set(p, 'u_browColor', brows);
          comp._set(p, 'u_contourColor', contour);
          comp._set(p, 'u_glowColor', glow);
          makeupOn = 1;
        }
      }
    }
  }
  comp._seti(p, 'u_warpTex', WARP_UNIT);
  comp._seti(p, 'u_faceMask', FACE_MASK_UNIT);
  comp._seti(p, 'u_hairTex', HAIR_UNIT);
  comp._seti(p, 'u_makeupMask', MAKEUP_UNIT);
  comp._seti(p, 'u_sculptMask', SCULPT_UNIT);
  comp._seti(p, 'u_makeupOn', makeupOn);
  comp._seti(p, 'u_warpFaces', faces);
  comp._seti(p, 'u_faceFixOn', fixOn);
  comp._seti(p, 'u_hairOn', hairOn);
}
