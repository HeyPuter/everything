/**
 * Motion tracking: pin a text, graphic or overlay clip to something moving
 * in a video clip under it. Draw a box around the object on the frame at the
 * playhead; it is followed forward and backward through the part where both
 * clips overlap, and the pinned clip gets position keyframes that move with it.
 */
import { boxPoint, inverse } from '../lib/geometry.js';
import { h, announce, clamp } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US, FRAME_SLACK, timecode } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { valueAt } from '../model/keyframes.js';
import { clipLayer } from '../engine/scene.js';
import { Tracker, grayFrames } from '../media/tracker.js';
import { thinKeys } from '../media/reframe.js';
import { openDialog, toast, oneAtATime } from './dialog.js';

const TW = 256;
const TH = 144;
const FPS = 15;

/** Media box (project px) of a video layer: center, size and rotation, as the compositor draws it. */
export function mediaBox(project, layer) {
  const W = project.settings.width;
  const H = project.settings.height;
  const a = layer.asset || {};
  const crop = layer.crop || { l: 0, t: 0, r: 0, b: 0 };
  const sw = (a.width || W) * (1 - crop.l - crop.r);
  const sh = (a.height || H) * (1 - crop.t - crop.b);
  const fit = Math.min(W / sw, H / sh);
  return { cx: W / 2 + layer.x * W, cy: H / 2 + layer.y * H, w: sw * fit * layer.scale * (layer.sx ?? 1), h: sh * fit * layer.scale * (layer.sy ?? 1), skew: sh * fit * layer.scale * (layer.skew || 0), rotation: layer.rotation, crop, flipH: layer.flipH, flipV: layer.flipV };
}

/** Project-pixel position of a point (u, v in 0..1 of the full source frame) inside a media box. */
export function sourcePointToFrame(box, u, v) {
  const { crop } = box;
  let x = (u - crop.l) / Math.max(1e-6, 1 - crop.l - crop.r) - 0.5;
  let y = (v - crop.t) / Math.max(1e-6, 1 - crop.t - crop.b) - 0.5;
  if (box.flipH) x = -x;
  if (box.flipV) y = -y;
  const [px, py] = boxPoint(box, box.rotation, x, y);
  return { x: px, y: py };
}

/**
 * Keyframes { x: [...], y: [...] } for the pinned clip from tracked points
 * [{ t (timeline), x, y (project px) }], keeping its offset from the object
 * at time t0.
 */
export function pinKeys(project, target, points, t0) {
  if (!points.length) return { x: [], y: [] };
  const W = project.settings.width;
  const H = project.settings.height;
  const ref = points.reduce((best, p) => (Math.abs(p.t - t0) < Math.abs(best.t - t0) ? p : best), points[0]);
  const local0 = clamp(t0 - target.start, 0, target.duration);
  const x0 = valueAt(target.keyframes, 'x', local0, target.transform.x);
  const y0 = valueAt(target.keyframes, 'y', local0, target.transform.y);
  const transformed = target.inherited?.length || target.parent || target.animIn || target.animOut || target.animLoop;
  const anchor = transformed ? clipLayer(project, target, target.start + local0, 0) : { x: x0, y: y0 };
  const probe = transformed ? { ...target, transform: { ...target.transform, x: 0, y: 0 }, keyframes: { ...target.keyframes } } : null;
  if (probe) { delete probe.keyframes.x; delete probe.keyframes.y; }
  let gainX = 1, gainY = 1;
  const keys = points
    .map((p) => {
      const t = Math.round(clamp(p.t - target.start, 0, target.duration));
      if (!probe) return { t, x: x0 + (p.x - ref.x) / W, y: y0 + (p.y - ref.y) / H };
      const at = target.start + t;
      // Evaluate the displayed position basis at this time. Animated parents and
      // the clip's own procedural motion can change both its origin and its axes.
      const origin = clipLayer(project, probe, at, 0);
      probe.transform.x = 1;
      const px = clipLayer(project, probe, at, 0);
      probe.transform.x = 0; probe.transform.y = 1;
      const py = clipLayer(project, probe, at, 0);
      probe.transform.y = 0;
      const matrix = [px.x - origin.x, px.y - origin.y, py.x - origin.x, py.y - origin.y];
      gainX = Math.max(gainX, Math.abs(matrix[0]), Math.abs(matrix[1]));
      gainY = Math.max(gainY, Math.abs(matrix[2]), Math.abs(matrix[3]));
      const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
      const area = Math.hypot(matrix[0], matrix[1]) * Math.hypot(matrix[2], matrix[3]);
      const inv = Math.abs(det) <= area * 1e-12 ? null : inverse(matrix);
      if (!inv) return { t, x: x0, y: y0 }; // A collapsed group has no unique position inverse.
      const dx = anchor.x + (p.x - ref.x) / W - origin.x;
      const dy = anchor.y + (p.y - ref.y) / H - origin.y;
      return { t, x: inv[0] * dx + inv[2] * dy, y: inv[1] * dx + inv[3] * dy };
    })
    .sort((a, b) => a.t - b.t);
  return {
    // Budget both local axes together in displayed frame coordinates.
    x: thinKeys(keys.map((k) => ({ t: k.t, v: k.x, ease: 'linear' })), 0.0015 / (2 * gainX)),
    y: thinKeys(keys.map((k) => ({ t: k.t, v: k.y, ease: 'linear' })), 0.0015 / (2 * gainY)),
  };
}

/** The video clip to track inside: under the target at the playhead, base track first. */
export function trackingSource(project, target, t) {
  const cands = [];
  project.tracks.forEach((track, ti) => {
    for (const c of track.clips) {
      if (c.id === target.id || c.type !== 'video' || c.freeze || c.disabled) continue;
      if (c.start <= t && T.clipEnd(c) > t && c.start < T.clipEnd(target) && T.clipEnd(c) > target.start) cands.push({ clip: c, track, ti });
    }
  });
  cands.sort((a, b) => (b.track.main ? 1 : 0) - (a.track.main ? 1 : 0) || b.ti - a.ti);
  return cands[0] || null;
}

export const openTrackingDialog = oneAtATime(async (ctx, targetId = ctx.store.selected?.clip.id) => {
  const { store } = ctx;
  const f = targetId && T.findClip(store.project, targetId);
  if (!f || !('transform' in f.clip)) {
    toast('Select a text, graphic or overlay clip to pin to a moving object.', { kind: 'info' });
    return;
  }
  const target = f.clip;
  const t0 = clamp(store.time, target.start, T.clipEnd(target) - 1);
  const src = trackingSource(store.project, target, t0);
  if (!src) {
    toast('Move the playhead to where the clip overlaps a video, then try again.', { kind: 'info' });
    return;
  }
  const asset = store.project.assets[src.clip.assetId];
  let blob;
  const canvas = h('canvas.track-frame', { width: TW * 3, height: TH * 3 });
  try {
    blob = await ctx.library.mediaBlob(asset);
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      const sink = new CanvasSink(track, { width: TW * 3, height: TH * 3, fit: 'fill', poolSize: 1 });
      const w = await sink.getCanvas(T.sourceTimeAt(src.clip, t0) / US + FRAME_SLACK);
      if (w) canvas.getContext('2d')?.drawImage(w.canvas, 0, 0, canvas.width, canvas.height);
    } finally {
      input.dispose();
    }
  } catch (err) {
    toast(err?.message || 'Could not read the video.', { kind: 'error' });
    return;
  }
  // Either clip may have been deleted while the frame was read.
  if (T.findClip(store.project, target.id)?.clip !== target || T.findClip(store.project, src.clip.id)?.clip !== src.clip) return;
  let box = null; // in 0..1 of the frame
  const boxEl = h('div.track-box', { hidden: true });
  const stage = h('div.track-stage', canvas, boxEl);
  const hint = h('p.dialog-text', `Drag a box around the object to follow in ${asset?.name || 'the video'} at ${timecode(t0, store.fps)}. Pick something with clear detail.`);
  const status = h('p.asset-hint', { role: 'status' });
  const bar = h('span');
  const progress = h('div.progress', { hidden: true }, bar);
  const go = h('button.btn.primary', { type: 'button', disabled: true }, icon('crosshair', 16), 'Track');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const d = openDialog({ title: 'Track motion', body: h('div.track-editor', hint, stage, progress, status), actions: [cancel, go], wide: true, className: 'track-dialog', closeOnBackdrop: false, onClose: () => ac?.abort() });
  let ac = null;
  cancel.addEventListener('click', () => d.close());

  const paintBox = () => {
    boxEl.hidden = !box;
    if (!box) return;
    Object.assign(boxEl.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
  };
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const ax = clamp((e.clientX - r.left) / r.width, 0, 1);
    const ay = clamp((e.clientY - r.top) / r.height, 0, 1);
    const move = (ev) => {
      const bx = clamp((ev.clientX - r.left) / r.width, 0, 1);
      const by = clamp((ev.clientY - r.top) / r.height, 0, 1);
      box = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
      paintBox();
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      go.disabled = !box || box.w * TW < 6 || box.h * TH < 6;
      if (go.disabled && box) status.textContent = 'Draw a slightly larger box.';
      else status.textContent = '';
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });

  go.addEventListener('click', async () => {
    if (!box || ac) return;
    ac = new AbortController();
    go.disabled = true;
    progress.hidden = false;
    const lo = Math.max(target.start, src.clip.start);
    const hi = Math.min(T.clipEnd(target), T.clipEnd(src.clip));
    const step = US / FPS;
    const fwd = [];
    for (let t = t0; t < hi; t += step) fwd.push(Math.round(t));
    const back = [];
    for (let t = t0 - step; t >= lo; t -= step) back.push(Math.round(t));
    const total = fwd.length + back.length;
    let done = 0;
    const points = [];
    const pxBox = { x: box.x * TW, y: box.y * TH, w: box.w * TW, h: box.h * TH };
    const run = async (times, skipFirst = false) => {
      if (!times.length) return;
      let tracker = null;
      const srcTimes = times.map((t) => T.sourceTimeAt(src.clip, t));
      let i = 0;
      for await (const { frame } of grayFrames(blob, srcTimes, { tw: TW, th: TH, signal: ac.signal })) {
        const t = times[i++];
        let c;
        if (!tracker) {
          tracker = new Tracker(frame, TW, TH, pxBox);
          c = tracker.center;
        } else c = tracker.step(frame);
        if (skipFirst && i === 1) continue;
        const layer = clipLayer(store.project, src.clip, t, src.ti);
        const p = sourcePointToFrame(mediaBox(store.project, layer), c.x / TW, c.y / TH);
        points.push({ t, x: p.x, y: p.y });
        done++;
        bar.style.width = `${Math.round((done / total) * 100)}%`;
      }
    };
    try {
      status.textContent = 'Following the object...';
      await run(fwd);
      // Backward pass starts again from the box at the playhead.
      if (back.length) await run([t0, ...back], true);
      const keys = pinKeys(store.project, target, points, t0);
      ctx.actions.editClip(target.id, 'Track motion', (c) => {
        c.keyframes ||= {};
        c.keyframes.x = keys.x;
        c.keyframes.y = keys.y;
      });
      announce('Motion tracked');
      toast(`${T.clipLabel(store.project, target)} now follows the object.`, { kind: 'success' });
      d.close();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error(err);
        status.textContent = err?.message || 'Tracking failed.';
      }
    } finally {
      ac = null;
      go.disabled = false;
    }
  });
});
