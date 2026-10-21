/**
 * Refine a cutout by hand: paint over the frame at the playhead to keep
 * parts the automatic matte missed or remove parts it kept. Strokes are
 * stored on the clip (model/cutout.js) and apply to every frame, so they
 * suit shots where the camera and the person stay roughly in place.
 */
import { h, announce, clamp } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { CUTOUT_DEFAULT, MAX_STROKES, normalizeStrokes, strokeOverride, applyOverride, matteWindow } from '../model/cutout.js';
import { SEG_SIZE, ready, segment, segmenterError } from '../media/segmenter.js';
import { segmented, sliderField } from './controls.js';
import { openDialog, toast } from './dialog.js';

const VIEW_W = 960;

/** The source frame of a clip at timeline time t, upright, as a canvas. */
async function sourceFrame(ctx, clip, t) {
  const asset = ctx.store.project.assets[clip.assetId];
  const blob = await ctx.library.mediaBlob(asset);
  const w = Math.min(VIEW_W, asset.width || VIEW_W);
  const hh = Math.round((w * (asset.height || 540)) / (asset.width || 960));
  const canvas = h('canvas.refine-frame', { width: w, height: hh });
  const g = canvas.getContext('2d');
  if (clip.type === 'image') {
    const bmp = await createImageBitmap(blob);
    g.drawImage(bmp, 0, 0, w, hh);
    bmp.close?.();
    return { canvas, asset };
  }
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can not be decoded here.');
    const sink = new CanvasSink(track, { width: w, height: hh, fit: 'fill', poolSize: 1 });
    const frame = await sink.getCanvas(T.sourceTimeAt(clip, t) / US);
    if (frame) g.drawImage(frame.canvas, 0, 0, w, hh);
  } finally {
    input.dispose();
  }
  return { canvas, asset };
}

export async function openCutoutRefine(ctx, clipId = ctx.store.selected?.clip.id) {
  const { store } = ctx;
  const f = clipId && T.findClip(store.project, clipId);
  if (!f || (f.clip.type !== 'video' && f.clip.type !== 'image')) {
    toast('Select a video or image clip first.', { kind: 'info' });
    return;
  }
  const clip = f.clip;
  const t = clamp(store.time, clip.start, T.clipEnd(clip) - 1);
  let frame;
  try {
    const [ok, fr] = await Promise.all([ready({ retry: true }), sourceFrame(ctx, clip, t)]);
    if (!ok) throw new Error(segmenterError() || 'Background removal could not start in this browser.');
    frame = fr;
  } catch (err) {
    toast(err?.message || 'Could not read this clip.', { kind: 'error' });
    return;
  }
  const { canvas } = frame;
  const aspect = canvas.width / canvas.height;
  // The model's matte for this frame.
  const seg = h('canvas', { width: SEG_SIZE, height: SEG_SIZE });
  seg.getContext('2d').drawImage(canvas, 0, 0, SEG_SIZE, SEG_SIZE);
  const m = segment(seg);
  if (!m) {
    toast('Could not find people in this frame.', { kind: 'error' });
    return;
  }

  let strokes = normalizeStrokes(clip.cutout?.strokes);
  const [lo, hi] = matteWindow(clip.cutout || CUTOUT_DEFAULT);
  let committed = strokeOverride(strokes, m.width, m.height, aspect);
  let current = null;
  // The matte is drawn small, scaled up smoothly, then given the clip's edge at full size.
  const small = h('canvas', { width: m.width, height: m.height });
  const smallImg = new ImageData(m.width, m.height);
  const veil = h('canvas.refine-veil', { width: canvas.width, height: canvas.height });
  const vg = veil.getContext('2d', { willReadFrequently: true });
  const paint = () => {
    let ov = committed;
    if (current) {
      const cur = strokeOverride([current], m.width, m.height, aspect);
      ov = committed.slice();
      for (let i = 0; i < ov.length; i++) if (cur[i] !== 0) ov[i] = ov[i] * (1 - Math.abs(cur[i])) + cur[i];
    }
    const data = applyOverride(Uint8ClampedArray.from(m.data), ov);
    const sp = smallImg.data;
    for (let i = 0; i < data.length; i++) sp[i * 4 + 3] = data[i];
    small.getContext('2d').putImageData(smallImg, 0, 0);
    vg.clearRect(0, 0, veil.width, veil.height);
    vg.imageSmoothingQuality = 'high';
    vg.drawImage(small, 0, 0, veil.width, veil.height);
    const big = vg.getImageData(0, 0, veil.width, veil.height);
    const px = big.data;
    for (let i = 0; i < px.length; i += 4) {
      // Removed parts are veiled, kept parts stay clear, with the clip's own edge.
      const x = Math.min(1, Math.max(0, (px[i + 3] / 255 - lo) / (hi - lo)));
      px[i] = 18;
      px[i + 1] = 20;
      px[i + 2] = 28;
      px[i + 3] = (1 - x * x * (3 - 2 * x)) * 200;
    }
    vg.putImageData(big, 0, 0);
    undo.disabled = !strokes.length;
    clear.disabled = !strokes.length;
  };

  let mode = 'erase';
  let size = 0.06;
  const modes = segmented({
    label: 'Brush',
    options: [
      { value: 'keep', label: 'Keep', icon: 'brush' },
      { value: 'erase', label: 'Remove', icon: 'eraser' },
    ],
    value: mode,
    onChange: (v) => {
      mode = v;
    },
  });
  const sizeField = sliderField({
    label: 'Brush size',
    min: 1,
    max: 30,
    value: Math.round(size * 100),
    onInput: (v) => {
      size = v / 100;
      sizeRing();
    },
  });
  const undo = h('button.btn.small', { type: 'button' }, icon('undo', 14), 'Undo stroke');
  const clear = h('button.btn.small', { type: 'button' }, 'Clear all');
  const ring = h('div.refine-ring', { hidden: true });
  const stage = h('div.refine-stage', canvas, veil, ring);
  const tools = h('div.refine-tools', h('div.field.insp-row', h('span.field-label', 'Brush'), modes.el), sizeField.el, h('div.refine-buttons', undo, clear));
  const hint = h('p.asset-hint', 'Paint with Keep over parts that should stay, and with Remove over parts that should go. Fixes stay in place on the picture, so they work best when the camera and the person move little. Hold Alt to switch brushes while painting.');
  const done = h('button.btn.primary', { type: 'button' }, 'Done');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const d = openDialog({ title: 'Refine cutout', body: h('div.refine-editor', stage, tools, hint), actions: [cancel, done], wide: true, className: 'refine-dialog', closeOnBackdrop: false });
  cancel.addEventListener('click', () => d.close());
  paint();

  let lastPos = null;
  const sizeRing = (e = lastPos) => {
    if (!e) return;
    const r = canvas.getBoundingClientRect();
    const s = r.height * size;
    Object.assign(ring.style, { width: `${s}px`, height: `${s}px`, left: `${e.clientX - r.left - s / 2}px`, top: `${e.clientY - r.top - s / 2}px` });
  };
  const uv = (e) => {
    const r = canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
  };
  let raf = 0;
  const schedule = () => {
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    }
  };
  stage.addEventListener('pointerenter', () => (ring.hidden = false));
  stage.addEventListener('pointerleave', () => (ring.hidden = true));
  stage.addEventListener('pointermove', (e) => {
    lastPos = e;
    sizeRing(e);
    if (!current) return;
    const p = uv(e);
    const q = current.pts[current.pts.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.002) return;
    current.pts.push(p);
    schedule();
  });
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    if (strokes.length >= MAX_STROKES) {
      toast('That is the most fixes one clip can hold. Clear some first.', { kind: 'info' });
      return;
    }
    const keep = (mode === 'keep') !== e.altKey;
    current = { keep, size, pts: [uv(e)] };
    schedule();
  });
  const end = () => {
    if (!current) return;
    strokes = [...strokes, current];
    committed = strokeOverride(strokes, m.width, m.height, aspect);
    current = null;
    schedule();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  undo.addEventListener('click', () => {
    strokes = strokes.slice(0, -1);
    committed = strokeOverride(strokes, m.width, m.height, aspect);
    paint();
  });
  clear.addEventListener('click', () => {
    strokes = [];
    committed = strokeOverride(strokes, m.width, m.height, aspect);
    paint();
  });
  done.addEventListener('click', () => {
    const list = normalizeStrokes(strokes);
    ctx.actions.editClip(clip.id, 'Refine cutout', (c) => {
      c.cutout ||= { ...CUTOUT_DEFAULT };
      if (list.length) c.cutout.strokes = list;
      else delete c.cutout.strokes;
    });
    announce(list.length ? `Cutout refined with ${list.length} stroke${list.length === 1 ? '' : 's'}` : 'Cutout fixes cleared');
    d.close();
  });
}
