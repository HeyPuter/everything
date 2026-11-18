/**
 * Crop dialog: the clip's source frame with a draggable crop rectangle,
 * aspect presets and exact percentages. The result is stored as clip.crop
 * ({ l, t, r, b } fractions of the source), which the compositor fits into
 * the frame.
 */
import { h, announce, clamp } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US, FRAME_SLACK } from '../lib/time.js';
import * as T from '../model/timeline.js';
import { pictureSizeFor } from '../model/picture-size.js';
import { toast } from './dialog.js';
import { frameDialog, openFrameDialog } from './frame-dialog.js';
import { abortable } from '../lib/abort.js';

const MIN = 0.02; // smallest crop side as a fraction of the source

export const CROP_RATIOS = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: 'project', label: 'Canvas' },
  { id: '16:9', label: '16:9', r: 16 / 9 },
  { id: '9:16', label: '9:16', r: 9 / 16 },
  { id: '1:1', label: '1:1', r: 1 },
  { id: '4:3', label: '4:3', r: 4 / 3 },
  { id: '3:4', label: '3:4', r: 3 / 4 },
  { id: '4:5', label: '4:5', r: 4 / 5 },
  { id: '21:9', label: '21:9', r: 21 / 9 },
];

/**
 * Largest centered crop rect with a pixel aspect ratio of `ratio` inside a
 * source of srcW x srcH, around the center of `around` (a rect of fractions).
 */
export function fitCrop(ratio, srcW, srcH, around = { x: 0, y: 0, w: 1, h: 1 }) {
  // Work in source pixels, then convert back to fractions.
  let w = srcW;
  let hgt = srcW / ratio;
  if (hgt > srcH) {
    hgt = srcH;
    w = srcH * ratio;
  }
  const fw = w / srcW;
  const fh = hgt / srcH;
  const cx = clamp(around.x + around.w / 2, fw / 2, 1 - fw / 2);
  const cy = clamp(around.y + around.h / 2, fh / 2, 1 - fh / 2);
  return { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
}

export const rectFromCrop = (c) => ({ x: c.l, y: c.t, w: 1 - c.l - c.r, h: 1 - c.t - c.b });
export const cropFromRect = (r) => ({ l: round(r.x), t: round(r.y), r: round(1 - r.x - r.w), b: round(1 - r.y - r.h) });
const round = (v) => Math.max(0, Math.round(v * 10000) / 10000);

/** The source frame of a clip at the playhead (or its first frame) as a canvas. */
async function sourceFrame(ctx, clip, signal) {
  const asset = ctx.store.project.assets[clip.assetId];
  if (!asset) throw new Error('This clip has no media.');
  const maxW = 1280;
  if (clip.type === 'image') {
    const img = new Image();
    img.src = await abortable(() => ctx.library.mediaURL(asset), signal);
    try {
      await abortable(() => img.decode(), signal);
      signal.throwIfAborted();
    } finally {
      if (signal.aborted) img.src = '';
    }
    const canvas = draw(img, img.naturalWidth, img.naturalHeight, maxW);
    const size = pictureSizeFor(clip, asset);
    if (size) {
      canvas.dataset.srcW = String(size.width);
      canvas.dataset.srcH = String(size.height);
      // Keep the bounded bitmap, but display and crop in the same logical
      // frame as the player. Bound width by both dialog and viewport height.
      canvas.style.aspectRatio = `${size.width} / ${size.height}`;
      canvas.style.width = `min(${canvas.width}px, calc(min(60vh, 560px) * ${size.width / size.height}))`;
    }
    return canvas;
  }
  // Decode the exact frame with WebCodecs (works in background tabs too).
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await abortable(() => import('mediabunny'), signal);
  const blob = await abortable(() => ctx.library.mediaBlob(asset), signal);
  signal.throwIfAborted();
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await abortable(() => input.getPrimaryVideoTrack(), signal);
    if (!track || !(await abortable(() => track.canDecode(), signal))) throw new Error('This video can not be decoded here.');
    const t = ctx.store.time;
    const local = clamp(t - clip.start, 0, clip.duration - 1);
    const sec = T.sourceTimeAt(clip, clip.start + local) / US;
    const w = asset.width || track.displayWidth;
    const hgt = asset.height || track.displayHeight;
    const sink = new CanvasSink(track, { width: Math.min(maxW, w), fit: 'contain', poolSize: 1 });
    const wrapped = (await abortable(() => sink.getCanvas(sec + FRAME_SLACK), signal)) || (await abortable(() => sink.getCanvas(0), signal));
    if (!wrapped) throw new Error('Could not read a frame from this video.');
    return draw(wrapped.canvas, w, hgt, maxW);
  } finally {
    input.dispose();
  }
}

/** Copy a frame into a fresh canvas, remembering the source's full pixel size. */
function draw(src, w, hgt, maxW) {
  const k = Math.min(1, maxW / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(hgt * k));
  c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
  c.dataset.srcW = String(w);
  c.dataset.srcH = String(hgt);
  return c;
}

export const openCropDialog = frameDialog(async (ctx, clipId = ctx.store.selected?.clip.id, signal) => {
  const { store, actions } = ctx;
  const f = clipId && T.findClip(store.project, clipId);
  if (!f || (f.clip.type !== 'video' && f.clip.type !== 'image')) {
    toast('Select a video or photo clip to crop.', { kind: 'info' });
    return;
  }
  if (f.track.locked) {
    toast('This clip is on a locked track.', { kind: 'info' });
    return;
  }
  const assetId = f.clip.assetId;
  const isCurrentSource = () => {
    const now = T.findClip(store.project, clipId);
    return !signal.aborted && now?.clip === f.clip && now.clip.assetId === assetId && !now.track.locked;
  };
  let frameCanvas;
  try {
    frameCanvas = await sourceFrame(ctx, f.clip, signal);
  } catch (err) {
    if (isCurrentSource()) toast(err?.message || 'Could not load this clip.', { kind: 'error' });
    return;
  }
  // Replacement edits the clip in place, so identity alone does not prove
  // that this frame still belongs to its current media.
  if (!isCurrentSource()) return;
  const srcW = Number(frameCanvas.dataset.srcW) || frameCanvas.width;
  const srcH = Number(frameCanvas.dataset.srcH) || frameCanvas.height;
  let rect = rectFromCrop(f.clip.crop || { l: 0, t: 0, r: 0, b: 0 });
  let ratio = 'free';

  const shade = h('div.crop-shade');
  const box = h('div.crop-box', { tabindex: '0', role: 'group', 'aria-label': 'Crop area. Arrow keys move it, Shift with arrows resizes it.' },
    h('div.crop-grid', h('span'), h('span'), h('span'), h('span')),
    ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((p) => h(`div.crop-handle.${p}`, { 'data-h': p })),
  );
  const stage = h('div.crop-stage', frameCanvas, shade, box);
  const readout = h('span.crop-readout');
  const ratioBtns = h('div.crop-ratios', { role: 'radiogroup', 'aria-label': 'Aspect ratio' }, CROP_RATIOS.map((r) => {
    const b = h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(r.id === ratio), 'data-r': r.id }, r.label);
    b.addEventListener('click', () => setRatio(r.id));
    return b;
  }));
  const reset = h('button.btn.ghost', { type: 'button' }, icon('reset', 14), 'Reset');
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const apply = h('button.btn.primary', { type: 'button' }, 'Apply');

  const ratioValue = () => {
    const r = CROP_RATIOS.find((x) => x.id === ratio);
    if (!r || r.id === 'free') return null;
    if (r.id === 'original') return srcW / srcH;
    if (r.id === 'project') return store.project.settings.width / store.project.settings.height;
    return r.r;
  };

  function setRatio(id) {
    ratio = id;
    ratioBtns.querySelectorAll('[role=radio]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.r === id)));
    const r = ratioValue();
    if (r) rect = fitCrop(r, srcW, srcH, rect);
    paint();
  }

  function paint() {
    const W = frameCanvas.clientWidth;
    const H = frameCanvas.clientHeight;
    Object.assign(box.style, { left: `${rect.x * W}px`, top: `${rect.y * H}px`, width: `${rect.w * W}px`, height: `${rect.h * H}px` });
    // Dim everything outside the crop with one big shadow.
    shade.style.clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect.x * 100}% ${rect.y * 100}%, ${rect.x * 100}% ${(rect.y + rect.h) * 100}%, ${(rect.x + rect.w) * 100}% ${(rect.y + rect.h) * 100}%, ${(rect.x + rect.w) * 100}% ${rect.y * 100}%, ${rect.x * 100}% ${rect.y * 100}%)`;
    readout.textContent = `${Math.round(rect.w * srcW)} x ${Math.round(rect.h * srcH)} px`;
  }

  box.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    box.focus();
    box.setPointerCapture(e.pointerId);
    const handle = e.target.closest('[data-h]')?.dataset.h || 'move';
    const W = frameCanvas.clientWidth;
    const H = frameCanvas.clientHeight;
    const start = { ...rect };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const r = ratioValue();
    const pr = r ? (r * srcH) / srcW : null; // aspect in fraction units (w/h)
    const move = (ev) => {
      const dx = (ev.clientX - x0) / W;
      const dy = (ev.clientY - y0) / H;
      let { x, y, w, h: hh } = start;
      if (handle === 'move') {
        x = clamp(start.x + dx, 0, 1 - w);
        y = clamp(start.y + dy, 0, 1 - hh);
      } else {
        let left = start.x;
        let top = start.y;
        let right = start.x + start.w;
        let bottom = start.y + start.h;
        if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN);
        if (handle.includes('e')) right = clamp(right + dx, left + MIN, 1);
        if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN);
        if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN, 1);
        x = left;
        y = top;
        w = right - left;
        hh = bottom - top;
        if (pr) {
          // Keep the ratio: follow the dragged axis, anchored at the opposite side.
          const byWidth = handle === 'e' || handle === 'w' || (handle.length === 2 && Math.abs(dx) >= Math.abs(dy));
          if (byWidth) hh = w / pr;
          else w = hh * pr;
          if (handle.includes('n')) y = start.y + start.h - hh;
          if (handle.includes('w')) x = start.x + start.w - w;
          if (handle === 'e' || handle === 'w') y = start.y + (start.h - hh) / 2;
          if (handle === 'n' || handle === 's') x = start.x + (start.w - w) / 2;
          if (x < 0 || y < 0 || x + w > 1 + 1e-6 || y + hh > 1 + 1e-6) return;
        }
      }
      rect = { x, y, w, h: hh };
      paint();
    };
    const up = () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', up);
      box.removeEventListener('pointercancel', up);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', up);
  });

  box.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const step = 0.01;
    if (e.shiftKey && ratio === 'free') {
      rect.w = clamp(rect.w + d[0] * step, MIN, 1 - rect.x);
      rect.h = clamp(rect.h + d[1] * step, MIN, 1 - rect.y);
    } else {
      rect.x = clamp(rect.x + d[0] * step, 0, 1 - rect.w);
      rect.y = clamp(rect.y + d[1] * step, 0, 1 - rect.h);
    }
    paint();
  });

  reset.addEventListener('click', () => {
    rect = { x: 0, y: 0, w: 1, h: 1 };
    setRatio('free');
  });

  const d = openFrameDialog({
    title: 'Crop',
    body: h('div.crop-editor', stage, h('div.crop-bar', ratioBtns, h('span.spacer'), readout)),
    actions: [reset, h('span.spacer'), cancel, apply],
    wide: true,
    className: 'crop-dialog',
  }, signal);
  const ro = new ResizeObserver(paint);
  ro.observe(frameCanvas);
  d.result.then(() => ro.disconnect());
  cancel.addEventListener('click', () => d.close());
  apply.addEventListener('click', () => {
    const crop = cropFromRect(rect);
    let mediaChanged = false;
    const ok = actions.editClip(clipId, 'Crop', (c) => {
      if (c.assetId !== assetId) {
        mediaChanged = true;
        return false;
      }
      c.crop = crop;
    });
    if (ok === false) toast(mediaChanged ? "The clip's media changed. Reopen Crop to edit its new picture." : 'This clip can no longer be cropped.', { kind: 'info' });
    else announce('Crop applied');
    d.close();
  });
  requestAnimationFrame(paint);
  box.focus();
});
