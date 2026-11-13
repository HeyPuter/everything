// File > Import > Video Frames to Layers: decode a video with the browser's
// <video> element (seeking frame by frame) into a new document with one pixel
// layer per frame, optionally as a frame animation.
import type { Editor } from '../../editor';
import type { PhotoDocument } from '../../model/document';
import { assertSize } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { framesFromLayers } from '../../model/animation';
import { modal, fieldChecked, fieldValue } from '../files/ui';
import { setSelectedFrames } from './state';

const maxFrames = 500;
// Decoded frames stay in memory as tiles; keep imports to a sane total.
const maxTotalPixels = 400_000_000;

function pickVideo(): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.webm,.mp4,.mov,.m4v,.ogv';
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

function event(target: HTMLMediaElement, name: string, timeout = 15000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('The video did not respond in time.')), timeout);
    const ok = () => done();
    const fail = () => done(new Error('This browser cannot decode this video.'));
    const done = (err?: Error) => {
      clearTimeout(timer);
      target.removeEventListener(name, ok);
      target.removeEventListener('error', fail);
      if (err) reject(err);
      else resolve();
    };
    target.addEventListener(name, ok, { once: true });
    target.addEventListener('error', fail, { once: true });
  });
}

/** Video duration in seconds. Recorded WebM files often report Infinity until
 * the decoder has seen their end. */
async function videoDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return video.duration;
  const changed = event(video, 'durationchange', 8000).catch(() => {});
  video.currentTime = 1e7;
  await changed;
  await event(video, 'seeked', 8000).catch(() => {});
  return Number.isFinite(video.duration) ? video.duration : 0;
}

/** Number of samples in [from, to); an equal start/end requests one still.
 * Count arithmetically so the import preview never allocates a whole movie. */
export function frameCount(from: number, to: number, fps: number, step: number) {
  if (![from, to, fps, step].every(Number.isFinite) || to < from || fps <= 0 || step <= 0) return 0;
  return Math.max(1, Math.ceil(((to - from) * fps) / step - 1e-9));
}

/** Times of every `step`th frame, sampled mid-frame. The range end is a
 * boundary, not another frame: seeking there duplicates the final picture. */
export function frameTimes(from: number, to: number, fps: number, step: number, limit = maxFrames) {
  const count = Math.min(frameCount(from, to, fps, step), Math.max(0, Math.floor(limit)));
  return Array.from({ length: count }, (_, k) => Math.min(to, from + (k * step + 0.5) / fps));
}

export async function importVideoFrames(e: Editor, arg?: unknown) {
  const file = arg instanceof Blob ? arg : await pickVideo();
  if (!file) return;
  const name = file instanceof File ? file.name : 'Video';
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    video.src = url;
    await event(video, 'loadeddata');
    const duration = await videoDuration(video);
    const vw = video.videoWidth,
      vh = video.videoHeight;
    if (!vw || !vh) throw new Error('The video has no picture.');
    const fit = Math.min(1, 8192 / vw, 8192 / vh, Math.sqrt(24_000_000 / (vw * vh)));
    const result = await modal({
      title: 'Video Frames to Layers',
      submit: 'Import',
      className: 'animation-export-dialog',
      body: `<p>${escapeXML(name)}: ${vw} × ${vh} px, ${duration.toFixed(2)} s.</p>
        <div class="processor-row"><label class="dialog-field">From (s)<input name="from" type="number" min="0" max="${duration}" step="any" value="0"></label>
        <label class="dialog-field">To (s)<input name="to" type="number" min="0" max="${duration}" step="any" value="${duration}"></label></div>
        <div class="processor-row"><label class="dialog-field">Source frame rate<input name="fps" type="number" min="1" max="240" step="any" value="30"></label>
        <label class="dialog-field">Take every<select name="step">${[1, 2, 3, 4, 5, 6, 10, 15, 30].map((n) => `<option value="${n}" ${n === 2 ? 'selected' : ''}>${n === 1 ? 'frame' : `${n}th frame`}</option>`).join('')}</select></label></div>
        <label class="dialog-field">Size (%)<input name="scale" type="number" min="1" max="${Math.floor(fit * 100)}" step="1" value="${Math.min(100, Math.floor(fit * 100))}"></label>
        <label class="dialog-field checkbox-field">Make frame animation<input name="animate" type="checkbox" checked></label>
        <p class="animation-export-size" aria-live="polite"></p>`,
      bind: (dialog) => {
        const form = dialog.querySelector('form')!;
        const sync = () => {
          const o = options(form, duration, vw, vh, fit);
          const total = frameCount(o.from, o.to, o.fps, o.step);
          dialog.querySelector('.animation-export-size')!.textContent = `${Math.min(total, o.limit)} frames at ${o.width} × ${o.height} px${total > o.limit ? ` (limited from ${total})` : ''}`;
        };
        form.addEventListener('input', sync);
        sync();
      },
    });
    if (!result) return;
    const o = options(result.form, duration, vw, vh, fit);
    const animate = fieldChecked(result.form, 'animate');
    result.close();
    assertSize(o.width, o.height);
    const times = frameTimes(o.from, o.to, o.fps, o.step, o.limit);
    if (!times.length) throw new Error('The range holds no frames.');
    const canvas = new OffscreenCanvas(o.width, o.height);
    const g = canvas.getContext('2d', { willReadFrequently: true })!;
    const s = e.sessionForOpen();
    const title = name.replace(/\.[^.]+$/, '');
    const doc: PhotoDocument = { ...s.doc, name: title, width: o.width, height: o.height, layers: [], selection: null };
    for (const [k, t] of times.entries()) {
      e.message(`Reading frame ${k + 1} of ${times.length}…`);
      const seeked = event(video, 'seeked');
      video.currentTime = t;
      await seeked;
      g.clearRect(0, 0, o.width, o.height);
      g.drawImage(video, 0, 0, o.width, o.height);
      const img = g.getImageData(0, 0, o.width, o.height);
      doc.layers.push(newPixelLayer(`Frame ${k + 1}`, doc, gridFromImage(s.assets.tiles, { width: img.width, height: img.height, data: img.data })));
    }
    const delay = Math.round((1000 * o.step) / o.fps);
    if (animate && doc.layers.length > 1) framesFromLayers(doc, doc.layers.map(() => delay), 0);
    s.history.reset(doc);
    s.hasDocument = true;
    s.storage.reset();
    s.saved = s.doc;
    s.fileName = name;
    e.selected = doc.layers.at(animate ? 0 : -1)!.id;
    if (doc.animation) {
      setSelectedFrames(e, [0]);
      e.dock.show('timeline');
    }
    e.fit();
    e.update();
    e.message(`Imported ${times.length} frames from ${name}${doc.animation ? ' as a frame animation' : ''}.`);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

function options(form: HTMLFormElement, duration: number, vw: number, vh: number, fit: number) {
  const num = (k: string, d: number) => {
    const v = Number(fieldValue(form, k));
    return Number.isFinite(v) ? v : d;
  };
  const from = Math.max(0, Math.min(duration, num('from', 0)));
  const to = Math.max(from, Math.min(duration, num('to', duration)));
  const fps = Math.max(1, Math.min(240, num('fps', 30)));
  const step = Math.max(1, Math.round(num('step', 1)));
  const scale = Math.max(0.01, Math.min(fit, num('scale', 100) / 100));
  const width = Math.max(1, Math.round(vw * scale)),
    height = Math.max(1, Math.round(vh * scale));
  const limit = Math.max(1, Math.min(maxFrames, Math.floor(maxTotalPixels / (width * height))));
  return { from, to, fps, step, width, height, limit };
}
