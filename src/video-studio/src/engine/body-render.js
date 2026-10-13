/**
 * Compositor side of body shape (model/retouch.js): finds the pose
 * landmarks of the frame a layer is showing, keeps them per clip until the
 * frame changes (steadying them between neighbouring frames), and binds the
 * warp's offset field (engine/body-geometry.js) for LAYER_FS on BODY_UNIT.
 * The same path draws the preview and the export.
 */
import { detectPoses, poseModelReady, poseModelState } from '../media/pose-landmarks.js';
import { trackPoses, bodyPlan, bodyGrid } from './body-geometry.js';
import { frameOf, drawUpright, rawTexture } from './face-render.js';
import { bodyShapeAmounts } from '../model/retouch.js';

export const BODY_UNIT = 11;

/** Longest side of the picture the pose model is given. */
const DETECT_SIDE = 640;

const makeCanvas = (w, h) => (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** Pose landmarks per clip: the frame they were found on and the people, steadied. */
export class PoseCache {
  constructor() {
    this.entries = new Map(); // clipId -> { frameKey, sec, W, H, tracks, poses, version, grid, gridFor, gridVersion }
    this.input = null;
    this.ctx = null;
  }

  /** People (source pixels) on the frame of a layer, or null while the model loads. */
  get(layer, info) {
    if (poseModelState() !== 'ready') {
      poseModelReady();
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
    const tracks = trackPoses(near ? e.tracks : null, found, sec, near ? Math.abs(sec - e.sec) : 0);
    if (!e) {
      e = { version: 0, grid: null, gridFor: '', gridVersion: 0 };
      this.entries.set(layer.clip.id, e);
    }
    Object.assign(e, { frameKey: key, sec, W, H, tracks, poses: tracks.map((t) => t.pose) });
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
    let poses;
    try {
      poses = detectPoses(this.input);
    } catch (err) {
      console.error(err);
      return null;
    }
    if (!poses) return null;
    for (const p of poses) {
      for (let i = 0; i < p.pts.length; i += 2) {
        p.pts[i] *= W;
        p.pts[i + 1] *= H;
      }
    }
    return poses;
  }

  /** Offset field of an entry for the clip's body shape, or null when nothing moves. */
  grid(e, amounts, which) {
    const k = `${e.version}|${which}|${Object.values(amounts).join(',')}`;
    if (e.gridFor !== k) {
      const plan = bodyPlan(e.poses, amounts, which, e.W, e.H);
      e.grid = plan ? bodyGrid(plan) : null;
      e.gridFor = k;
      e.gridVersion++;
    }
    return e.grid;
  }

  dispose() {
    this.entries.clear();
  }
}

/** Set the body shape uniforms of the layer program. */
export function bindBodyLayer(comp, p, layer, info) {
  const gl = comp.gl;
  const media = layer.kind === 'media' && layer.clip && info?.source;
  const amounts = media ? bodyShapeAmounts(layer.bodyShape) : null;
  let on = 0;
  if (amounts) {
    comp._poseCache ||= new PoseCache();
    const cache = comp._poseCache;
    const e = cache.get(layer, info);
    const grid = e?.poses.length ? cache.grid(e, amounts, layer.bodyShape.people) : null;
    if (grid) {
      rawTexture(comp, BODY_UNIT, `bodyWarp:${layer.clip.id}`, `${e.gridVersion}|${e.gridFor}`, grid.cols, grid.rows, gl.RG32F, gl.RG, gl.FLOAT, grid.data, gl.NEAREST);
      comp._set(p, 'u_srcSize', e.W, e.H);
      on = 1;
    }
  }
  comp._seti(p, 'u_bodyTex', BODY_UNIT);
  comp._seti(p, 'u_bodyOn', on);
}
