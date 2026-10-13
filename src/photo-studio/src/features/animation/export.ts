// Exporting the frame animation: animated GIF, PNG (APNG) and WebP files, and
// WebM video rendered with WebCodecs (or recorded from a canvas stream where
// WebCodecs video encoding is unavailable), with the video timeline's sound
// mixed in (audio-export.ts) or written alone as a WAV file.
import type { Editor } from '../../editor';
import type { RGBA8 } from '../../imaging/types';
import { download } from '../../persistence/puter';
import type { PhotoDocument } from '../../model/document';
import { frameDocument, gifLoop, loopLabel, sampleFrames, totalDuration, type FrameAnimation } from '../../model/animation';
import { fpsLabel, timecode, timeDocument, workArea } from '../../model/video-timeline-ops';
import { encodeApng } from '../../imaging/codecs/apng';
import { muxAnimatedWebp } from '../../imaging/codecs/webp-anim';
import { muxWebm, type WebmAudio, type WebmFrame } from '../../imaging/codecs/webm';
import { audioPlan } from '../../model/audio-timeline';
import { outputSize, prepareExport, type ExportSettings } from '../files/encode';
import { bytesBlob, documentSource, effectiveSettings, encodeGifOffThread, encodeOffThread, exportContext, formatBytes, loadSettings } from '../files/pipeline';
import { zipStore, type ZipEntry } from '../files/zip';
import { rgba16To8 } from '../files/png';
import { modal, fieldChecked, fieldValue } from '../files/ui';
import { animationOf, selectedFrames } from './state';
import { stop } from './playback';
import { timelineOf } from './video-state';

export type AnimationFormat = 'gif' | 'png' | 'webp';
const prefsKey = 'photo-studio-animation-export';
type Prefs = { format: AnimationFormat; scale: number; colors: number; dither: boolean; palette: 'global' | 'local'; quality: number; transparency: boolean; fps: number; videoQuality: string; codec: string; background: string; output: 'webm' | 'png' | 'wav'; audio: boolean };
const defaults: Prefs = { format: 'gif', scale: 100, colors: 256, dither: true, palette: 'global', quality: 90, transparency: true, fps: 30, videoQuality: 'high', codec: 'vp9', background: '#ffffff', output: 'webm', audio: true };
function loadPrefs(): Prefs {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(prefsKey) ?? '{}') };
  } catch {
    return { ...defaults };
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(prefsKey, JSON.stringify(p));
  } catch {
    /* Optional. */
  }
}

let webpSupport: Promise<boolean> | undefined;
/** True when the browser's canvas encoder writes WebP (not a PNG fallback). */
export function canEncodeWebp() {
  return (webpSupport ??= (async () => {
    try {
      const blob = await new OffscreenCanvas(2, 2).convertToBlob({ type: 'image/webp' });
      return blob.type === 'image/webp';
    } catch {
      return false;
    }
  })());
}

/** Render frames at the output size as 8-bit RGBA (sRGB when the export
 * settings convert), one at a time through the compositor. */
export async function renderFrames(e: Editor, indices: number[], settings: ExportSettings, label = 'frame'): Promise<RGBA8[]> {
  const doc = e.doc;
  const s = effectiveSettings(doc, settings);
  const ctx = exportContext(doc);
  const out: RGBA8[] = [];
  // Identical frames (for example video samples) render once.
  const done = new Map<number, RGBA8>();
  for (const [k, i] of indices.entries()) {
    let img = done.get(i);
    if (!img) {
      e.message(`Rendering ${label} ${k + 1} of ${indices.length}…`);
      const src = await documentSource(e, frameDocument(doc, i));
      const p = prepareExport(src, s, ctx);
      img = { width: p.width, height: p.height, data: p.data instanceof Uint16Array ? rgba16To8(p.data) : p.data };
      done.set(i, img);
    }
    out.push(img);
  }
  return out;
}

const loopOptions = (anim: FrameAnimation) => {
  const list = [1, 3, 0];
  if (!list.includes(anim.loop)) list.splice(2, 0, anim.loop);
  return list.map((n) => `<option value="${n}" ${n === anim.loop ? 'selected' : ''}>${loopLabel(n)}</option>`).join('');
};

export async function exportAnimation(e: Editor, preset?: AnimationFormat) {
  const anim = animationOf(e);
  if (!anim) throw new Error('Create a frame animation in the Timeline first.');
  stop(e, false);
  const doc = e.doc;
  const prefs = loadPrefs();
  const webp = await canEncodeWebp();
  const format = preset ?? (prefs.format === 'webp' && !webp ? 'gif' : prefs.format);
  const sel = selectedFrames(e);
  const result = await modal({
    title: 'Export Animation',
    submit: 'Export',
    className: 'animation-export-dialog',
    body: `<label class="dialog-field">Format<select name="format"><option value="gif">GIF</option><option value="png">Animated PNG</option>${webp ? '<option value="webp">Animated WebP</option>' : ''}</select></label>
      ${sel.length > 1 ? `<label class="dialog-field">Frames<select name="frames"><option value="all">All ${anim.frames.length} frames</option><option value="selected">${sel.length} selected frames</option></select></label>` : ''}
      <label class="dialog-field">Size (%)<input name="scale" type="number" min="1" max="400" step="1" value="${prefs.scale}"></label>
      <p class="animation-export-size" aria-live="polite"></p>
      <label class="dialog-field">Looping<select name="loop">${loopOptions(anim)}</select></label>
      <div data-for="gif"><label class="dialog-field">Colors<input name="colors" type="number" min="2" max="256" step="1" value="${prefs.colors}"></label>
      <label class="dialog-field">Palette<select name="palette"><option value="global" ${prefs.palette === 'global' ? 'selected' : ''}>One palette for all frames</option><option value="local" ${prefs.palette === 'local' ? 'selected' : ''}>A palette per frame</option></select></label>
      <label class="dialog-field checkbox-field">Dither<input name="dither" type="checkbox" ${prefs.dither ? 'checked' : ''}></label></div>
      <div data-for="webp"><label class="dialog-field">Quality<input name="quality" type="number" min="1" max="100" step="1" value="${prefs.quality}"></label></div>
      <label class="dialog-field checkbox-field">Transparency<input name="transparency" type="checkbox" ${prefs.transparency ? 'checked' : ''}></label>`,
    bind: (dialog) => {
      const form = dialog.querySelector('form')!;
      (form.elements.namedItem('format') as HTMLSelectElement).value = format;
      const sync = () => {
        const f = fieldValue(form, 'format');
        dialog.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== f));
        const scale = Math.max(1, Math.min(400, Number(fieldValue(form, 'scale')) || 100));
        const [w, h] = outputSize(doc.width, doc.height, { sizeMode: 'percent', scale, width: 0, height: 0 });
        const count = fieldValue(form, 'frames') === 'selected' ? sel.length : anim.frames.length;
        dialog.querySelector('.animation-export-size')!.textContent = `${w} × ${h} px · ${count} frames · ${(totalDuration(anim) / 1000).toFixed(2)} s per play`;
      };
      form.addEventListener('input', sync);
      sync();
    },
  });
  if (!result) return;
  const f = result.form;
  const next: Prefs = {
    ...prefs,
    format: fieldValue(f, 'format') as AnimationFormat,
    scale: Math.max(1, Math.min(400, Math.round(Number(fieldValue(f, 'scale')) || 100))),
    colors: Math.max(2, Math.min(256, Math.round(Number(fieldValue(f, 'colors')) || 256))),
    palette: fieldValue(f, 'palette') === 'local' ? 'local' : 'global',
    dither: fieldChecked(f, 'dither'),
    quality: Math.max(1, Math.min(100, Math.round(Number(fieldValue(f, 'quality')) || 90))),
    transparency: fieldChecked(f, 'transparency'),
  };
  const plays = Math.max(0, Math.round(Number(fieldValue(f, 'loop'))));
  const indices = fieldValue(f, 'frames') === 'selected' ? sel : anim.frames.map((_, i) => i);
  result.close();
  savePrefs(next);
  const settings: ExportSettings = { ...loadSettings(), format: next.format === 'gif' ? 'gif' : 'png', depth: 8, sizeMode: 'percent', scale: next.scale, canvasWidth: 0, canvasHeight: 0, transparency: next.transparency };
  const images = await renderFrames(e, indices, settings);
  const delays = indices.map((i) => anim.frames[i].delay);
  e.message(`Encoding ${images.length} frames…`);
  let bytes: Uint8Array, mime: string, ext: string;
  if (next.format === 'gif') {
    bytes = await encodeGifOffThread(images.map((rgba, k) => ({ rgba, delayMs: delays[k] })), { colors: next.colors, dither: next.dither, loop: gifLoop(plays), palette: next.palette });
    [mime, ext] = ['image/gif', 'gif'];
  } else if (next.format === 'png') {
    bytes = encodeApng(images.map((rgba, k) => ({ rgba, delayMs: delays[k] })), { plays });
    [mime, ext] = ['image/png', 'png'];
  } else {
    const { width, height } = images[0];
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d')!;
    const stills: Uint8Array[] = [];
    for (const img of images) {
      g.clearRect(0, 0, width, height);
      g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
      stills.push(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality: next.quality / 100 })).arrayBuffer()));
    }
    // Every frame covers the canvas and replaces it, so transparent areas
    // never show the previous frame.
    bytes = muxAnimatedWebp(stills.map((webp, k) => ({ webp, width, height, delayMs: delays[k], blend: false })), { width, height, plays });
    [mime, ext] = ['image/webp', 'webp'];
  }
  download(bytesBlob(bytes, mime), `${doc.name}.${ext}`);
  e.message(`Animation exported: ${images.length} frames, ${formatBytes(bytes.length)}`);
}

// ----- Video -----

const qualityBits: Record<string, number> = { low: 0.05, medium: 0.1, high: 0.2, maximum: 0.4 };
type VideoCodec = { id: string; label: string; webcodecs: string; matroska: 'V_VP8' | 'V_VP9'; recorder: string };
const videoCodecs: VideoCodec[] = [
  { id: 'vp9', label: 'VP9', webcodecs: 'vp09.00.41.08', matroska: 'V_VP9', recorder: 'video/webm;codecs=vp9' },
  { id: 'vp8', label: 'VP8', webcodecs: 'vp8', matroska: 'V_VP8', recorder: 'video/webm;codecs=vp8' },
];

async function webCodecsSupport(codec: VideoCodec, width: number, height: number, bitrate: number, fps: number) {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const r = await VideoEncoder.isConfigSupported({ codec: codec.webcodecs, width, height, bitrate, framerate: fps });
    return !!r.supported;
  } catch {
    return false;
  }
}

/** The documents a render shows, one per output frame. Consecutive frames
 * that show the same source state render once. */
type Sequence = { count: number; key(k: number): number; doc(k: number): Promise<PhotoDocument>; seconds: number };
function frameSequence(doc: PhotoDocument, anim: FrameAnimation, fps: number, plays: number): Sequence {
  const samples = sampleFrames(anim, fps, plays);
  return { count: samples.length, key: (k) => samples[k], doc: async (k) => frameDocument(doc, samples[k]), seconds: samples.length / fps };
}
/** Timeline frames for each output frame of [a, b) at `fps`. */
export function timelineSamples(a: number, b: number, timelineFps: number, fps: number) {
  const n = Math.max(1, Math.round(((b - a) * fps) / timelineFps));
  return Array.from({ length: n }, (_, k) => Math.min(b - 1, a + Math.floor((k * timelineFps) / fps + 1e-6)));
}
async function timeSequence(e: Editor, doc: PhotoDocument, range: [number, number], fps: number): Promise<Sequence> {
  const tl = doc.timeline!;
  const times = timelineSamples(range[0], range[1], tl.fps, fps);
  const { ensureFrames } = await import('./video-frames');
  const s = e.session;
  return { count: times.length, key: (k) => times[k], doc: async (k) => timeDocument(doc, times[k], await ensureFrames(s, doc, times[k])), seconds: times.length / fps };
}

export async function renderVideo(e: Editor) {
  const anim = animationOf(e);
  const tl = timelineOf(e);
  if (!anim && !tl) throw new Error('Create a frame animation or a video timeline in the Timeline first.');
  stop(e, false);
  (await import('./video-playback')).stopVideo(e, false);
  const doc = e.doc;
  const prefs = loadPrefs();
  const plays0 = anim ? anim.loop || 1 : 1;
  const rates = [12, 15, 24, 25, 30, 50, 60];
  if (tl && !rates.includes(tl.fps)) rates.push(tl.fps);
  rates.sort((a, b) => a - b);
  const fps0 = tl ? tl.fps : prefs.fps;
  const [ws, we] = tl ? workArea(tl) : [0, 0];
  // Sound: the timeline's audio clips that play (after mute and solo).
  const sound = !!tl && audioPlan(doc).length > 0;
  const output0 = prefs.output === 'wav' && !sound ? 'webm' : prefs.output;
  const result = await modal({
    title: 'Render Video',
    submit: 'Render',
    className: 'animation-export-dialog',
    body: `<p>${tl ? 'Renders the video timeline (every layer at each time, with keyframes and transitions)' : 'Renders the Timeline frames'} to a WebM video or a ZIP of numbered PNG images at a fixed frame rate.</p>
      <label class="dialog-field">Format<select name="output"><option value="webm" ${output0 === 'webm' ? 'selected' : ''}>WebM video</option><option value="png" ${output0 === 'png' ? 'selected' : ''}>PNG image sequence (ZIP)</option>${sound ? `<option value="wav" ${output0 === 'wav' ? 'selected' : ''}>WAV audio only</option>` : ''}</select></label>
      ${tl ? `<label class="dialog-field">Range<select name="range"><option value="work" ${tl.work ? 'selected' : ''}>Work area (${timecode(ws, tl.fps)} to ${timecode(we, tl.fps)})</option><option value="all" ${tl.work ? '' : 'selected'}>Whole timeline (${timecode(tl.duration, tl.fps)})</option></select></label>` : ''}
      <div data-for="webm png"><label class="dialog-field">Size (%)<input name="scale" type="number" min="1" max="400" step="1" value="${prefs.scale}"></label>
      <label class="dialog-field">Frame rate<select name="fps">${rates.map((n) => `<option value="${n}" ${n === fps0 ? 'selected' : ''}>${fpsLabel(n)}${tl && n === tl.fps ? ' (timeline)' : ''}</option>`).join('')}</select></label>
      ${anim ? `<label class="dialog-field">Play the animation (times)<input name="plays" type="number" min="1" max="1000" step="1" value="${plays0}"></label>` : ''}</div>
      <div data-for="webm">${sound ? `<label class="dialog-field checkbox-field">Include audio (mixed, Opus)<input name="audio" type="checkbox" ${prefs.audio ? 'checked' : ''}></label>` : ''}<label class="dialog-field">Quality<select name="quality">${['low', 'medium', 'high', 'maximum'].map((q) => `<option value="${q}" ${q === prefs.videoQuality ? 'selected' : ''}>${q[0].toUpperCase()}${q.slice(1)}</option>`).join('')}</select></label>
      <label class="dialog-field">Codec<select name="codec">${videoCodecs.map((c) => `<option value="${c.id}" ${c.id === prefs.codec ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
      <label class="dialog-field">Background<input name="background" type="color" value="${prefs.background}"></label>
      <p>Video has no transparency; transparent areas show the background color.</p></div>
      <div data-for="png"><label class="dialog-field checkbox-field">Transparency<input name="transparency" type="checkbox" ${prefs.transparency ? 'checked' : ''}></label></div>
      <p class="animation-export-size" aria-live="polite"></p>`,
    bind: (dialog) => {
      const form = dialog.querySelector('form')!;
      const sync = () => {
        const output = fieldValue(form, 'output');
        dialog.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => (el.hidden = !el.dataset.for!.split(' ').includes(output)));
        const scale = Math.max(1, Math.min(400, Number(fieldValue(form, 'scale')) || 100));
        const [w, h] = outputSize(doc.width, doc.height, { sizeMode: 'percent', scale, width: 0, height: 0 });
        const fps = Number(fieldValue(form, 'fps')) || 30;
        let seconds: number;
        if (tl) {
          const [a, b] = fieldValue(form, 'range') === 'work' ? [ws, we] : [0, tl.duration];
          seconds = timelineSamples(a, b, tl.fps, fps).length / fps;
        } else seconds = (totalDuration(anim!) * Math.max(1, Number(fieldValue(form, 'plays')) || 1)) / 1000;
        const even = output === 'webm';
        dialog.querySelector('.animation-export-size')!.textContent =
          output === 'wav' ? `Stereo, 48 kHz, 16-bit · ${seconds.toFixed(2)} s` : `${even ? w + (w & 1) : w} × ${even ? h + (h & 1) : h} px · ${Math.max(1, Math.round(seconds * fps))} frames · ${seconds.toFixed(2)} s${even && sound && fieldChecked(form, 'audio') ? ' · with sound' : ''}`;
      };
      form.addEventListener('input', sync);
      sync();
    },
  });
  if (!result) return;
  const f = result.form;
  const next: Prefs = {
    ...prefs,
    output: fieldValue(f, 'output') === 'png' ? 'png' : fieldValue(f, 'output') === 'wav' && sound ? 'wav' : 'webm',
    audio: sound ? fieldChecked(f, 'audio') : prefs.audio,
    scale: Math.max(1, Math.min(400, Math.round(Number(fieldValue(f, 'scale')) || 100))),
    fps: Number(fieldValue(f, 'fps')) || 30,
    videoQuality: fieldValue(f, 'quality'),
    codec: fieldValue(f, 'codec'),
    background: /^#[0-9a-f]{6}$/i.test(fieldValue(f, 'background')) ? fieldValue(f, 'background') : '#ffffff',
    transparency: fieldChecked(f, 'transparency'),
  };
  const plays = Math.max(1, Math.min(1000, Math.round(Number(fieldValue(f, 'plays')) || 1)));
  const range: [number, number] = tl ? (fieldValue(f, 'range') === 'work' ? [ws, we] : [0, tl.duration]) : [0, 0];
  result.close();
  savePrefs(next);
  const seq = tl ? await timeSequence(e, doc, range, next.fps) : frameSequence(doc, anim!, next.fps, plays);
  if (next.output === 'png') return renderSequence(e, doc, seq, next);
  // The sound of the rendered range (as long as the frames last).
  const audioMod = sound && (next.output === 'wav' || next.audio) ? await import('./audio-export') : undefined;
  const mix = audioMod && tl ? await audioMod.mixDocument(e, doc, range[0] / tl.fps, next.output === 'wav' ? (range[1] - range[0]) / tl.fps : seq.seconds) : undefined;
  if (next.output === 'wav') {
    const wav = audioMod!.wavBlob(mix!);
    download(wav, `${doc.name}.wav`);
    e.message(`Audio rendered: ${(mix![0].length / audioMod!.outputRate).toFixed(2)} s, ${formatBytes(wav.size)}`);
    return;
  }
  const settings: ExportSettings = { ...loadSettings(), format: 'png', depth: 8, sizeMode: 'percent', scale: next.scale, canvasWidth: 0, canvasHeight: 0, transparency: false, matte: next.background };
  // 4:2:0 video needs even dimensions; frames are padded by repeating the last row/column.
  const render = renderer(e, doc, seq, settings, 'video frame');
  const first = evenSize(await render(0));
  const { width, height } = first;
  const codec = videoCodecs.find((c) => c.id === next.codec) ?? videoCodecs[0];
  const bitrate = Math.round(width * height * next.fps * (qualityBits[next.videoQuality] ?? 0.2));
  const frame = async (k: number) => (k === 0 ? first : evenSize(await render(k)));
  let blob: Blob;
  // Sound needs an audio encoder too; without one the recording fallback carries it.
  const opus = mix ? await audioMod!.canEncodeOpus() : true;
  if (opus && (await webCodecsSupport(codec, width, height, bitrate, next.fps))) {
    const audio = mix ? await audioMod!.encodeOpus(e, mix) : undefined;
    blob = await encodeWithWebCodecs(e, seq.count, frame, width, height, codec, bitrate, next.fps, audio);
  } else if (typeof MediaRecorder !== 'undefined') blob = await recordWithMediaRecorder(e, seq.count, frame, width, height, codec, bitrate, next.fps, mix);
  else throw new Error('This browser cannot encode video.');
  download(blob, `${doc.name}.webm`);
  e.message(`Video rendered: ${seq.count} frames at ${fpsLabel(next.fps)}${mix ? ' with sound' : ''}, ${formatBytes(blob.size)}`);
}

/** A frame renderer for a sequence: renders frame k at the export settings,
 * reusing the previous result when frame k shows the same source state. */
function renderer(e: Editor, doc: PhotoDocument, seq: Sequence, settings: ExportSettings, label: string) {
  const s = effectiveSettings(doc, settings);
  const ctx = exportContext(doc);
  let last: { key: number; img: RGBA8 } | undefined;
  return async (k: number): Promise<RGBA8> => {
    const key = seq.key(k);
    if (last?.key === key) return last.img;
    if (k % 5 === 0) e.message(`Rendering ${label} ${k + 1} of ${seq.count}…`);
    const src = await documentSource(e, await seq.doc(k));
    const p = prepareExport(src, s, ctx);
    const img = { width: p.width, height: p.height, data: p.data instanceof Uint16Array ? rgba16To8(p.data) : p.data };
    last = { key, img };
    return img;
  };
}

/** Numbered PNG files in a ZIP, one per output frame. */
async function renderSequence(e: Editor, doc: PhotoDocument, seq: Sequence, prefs: Prefs) {
  const settings: ExportSettings = { ...loadSettings(), format: 'png', depth: 8, sizeMode: 'percent', scale: prefs.scale, canvasWidth: 0, canvasHeight: 0, transparency: prefs.transparency, ...(prefs.transparency ? {} : { matte: '#ffffff' }) };
  const s = effectiveSettings(doc, settings);
  const ctx = exportContext(doc);
  const digits = Math.max(4, String(seq.count).length);
  const stem = doc.name.replace(/[\\/:*?"<>|]+/g, '_') || 'frame';
  const entries: ZipEntry[] = [];
  let last: { key: number; bytes: Uint8Array } | undefined;
  let total = 0;
  for (let k = 0; k < seq.count; k++) {
    const key = seq.key(k);
    if (last?.key !== key) {
      if (k % 5 === 0) e.message(`Rendering image ${k + 1} of ${seq.count}…`);
      const src = await documentSource(e, await seq.doc(k));
      last = { key, bytes: (await encodeOffThread(src, s, ctx)).bytes };
    }
    total += last.bytes.length;
    if (total > 3.5 * 1024 ** 3) throw new Error('The image sequence exceeds the 4 GB limit of a ZIP archive.');
    entries.push({ name: `${stem}_${String(k + 1).padStart(digits, '0')}.png`, data: last.bytes });
  }
  const zip = zipStore(entries);
  download(bytesBlob(zip, 'application/zip'), `${stem} frames.zip`);
  e.message(`Image sequence rendered: ${seq.count} PNG files at ${fpsLabel(prefs.fps)}, ${formatBytes(zip.length)}`);
}

function evenSize(img: RGBA8): RGBA8 {
  const w = img.width + (img.width & 1),
    h = img.height + (img.height & 1);
  if (w === img.width && h === img.height) return img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(y, img.height - 1);
    data.set(img.data.subarray(sy * img.width * 4, (sy + 1) * img.width * 4), y * w * 4);
    if (w > img.width) data.copyWithin((y * w + img.width) * 4, (y * w + img.width - 1) * 4, (y * w + img.width) * 4);
  }
  return { width: w, height: h, data };
}

/** Encode frames as they render (only one frame is held at a time). */
async function encodeWithWebCodecs(e: Editor, count: number, frameAt: (k: number) => Promise<RGBA8>, width: number, height: number, codec: VideoCodec, bitrate: number, fps: number, audio?: WebmAudio): Promise<Blob> {
  const chunks: WebmFrame[] = [];
  let failure: unknown;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestampMs: chunk.timestamp / 1000, key: chunk.type === 'key' });
    },
    error: (err) => (failure = err),
  });
  encoder.configure({ codec: codec.webcodecs, width, height, bitrate, framerate: fps, latencyMode: 'quality' });
  const step = 1e6 / fps;
  for (let k = 0; k < count; k++) {
    if (failure) break;
    if (k % 10 === 0) e.message(`Encoding video frame ${k + 1} of ${count}…`);
    const img = await frameAt(k);
    const frame = new VideoFrame(img.data, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: Math.round(k * step), duration: Math.round(step) });
    // A key frame every two seconds keeps the file seekable.
    encoder.encode(frame, { keyFrame: k % Math.max(1, Math.round(fps * 2)) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  chunks.sort((a, b) => a.timestampMs - b.timestampMs);
  const bytes = muxWebm(chunks, { width, height, codec: codec.matroska, frameRate: fps, durationMs: (count * 1000) / fps, ...(audio?.frames.length ? { audio } : {}) });
  return bytesBlob(bytes, 'video/webm');
}

/** Real-time fallback: draw each frame into a canvas stream while recording. */
async function recordWithMediaRecorder(e: Editor, count: number, frameAt: (k: number) => Promise<RGBA8>, width: number, height: number, codec: VideoCodec, bitrate: number, fps: number, mix?: Float32Array[]): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  // The mix plays into the stream one frame's time at a time.
  const sound = mix ? new (await import('./audio-export')).RecorderSound(mix) : undefined;
  if (sound) stream.addTrack(sound.track);
  const wanted = sound ? `${codec.recorder},opus` : codec.recorder;
  const mimeType = MediaRecorder.isTypeSupported(wanted) ? wanted : MediaRecorder.isTypeSupported(codec.recorder) ? codec.recorder : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  const parts: Blob[] = [];
  recorder.ondataavailable = (ev) => ev.data.size && parts.push(ev.data);
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  await sound?.start();
  recorder.start();
  try {
    for (let k = 0; k < count; k++) {
      if (k % 10 === 0) e.message(`Recording video frame ${k + 1} of ${count}…`);
      const img = await frameAt(k);
      g.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
      track.requestFrame?.();
      if (sound) await sound.play(1 / fps);
      else await new Promise((r) => setTimeout(r, 1000 / fps));
    }
  } finally {
    recorder.stop();
    await done;
    stream.getTracks().forEach((t) => t.stop());
    sound?.close();
  }
  return new Blob(parts, { type: 'video/webm' });
}
