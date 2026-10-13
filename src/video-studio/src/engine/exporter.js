/**
 * Export: renders the project frame by frame (not in real time) with a
 * dedicated compositor on an offscreen canvas, decodes video sources with
 * WebCodecs through Mediabunny, mixes the sound offline and encodes
 * everything into MP4, MOV or WebM. Audio-only exports write WAV, M4A, Ogg
 * or FLAC.
 *
 * The pure helpers at the top (sizes, bitrates, codec and container
 * matching, frame times, size estimates) are shared with the dialog and
 * covered by unit tests.
 */
import {
  Output, BufferTarget, StreamTarget, Mp4OutputFormat, MovOutputFormat, WebMOutputFormat, OggOutputFormat,
  FlacOutputFormat, CanvasSource, AudioSampleSource, AudioSample, Quality, Input, BlobSource, ALL_FORMATS,
  VideoSampleSink, canEncodeVideo, canEncodeAudio,
} from 'mediabunny';
import { US } from '../lib/time.js';
import { projectDuration } from '../model/timeline.js';
import { Compositor } from './compositor.js';
import { ensureLuts } from './luts.js';
import { ensureCutout } from './cutout.js';
import { TextCache, fontString } from './text.js';
import { expandProject } from './compound.js';
import { evaluate, audibleClips } from './scene.js';
import { mixChunks, wavHeader, pcm16 } from './audio-mix.js';
import { framePosition, needsBetween, FRAME_SNAP } from '../model/slow-motion.js';

/* Choices --------------------------------------------------------------------- */

export const RESOLUTIONS = [
  { value: 480, label: '480p' },
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '2K' },
  { value: 2160, label: '4K' },
];

export const FRAME_RATES = [24, 25, 30, 50, 60];

export const BITRATE_LEVELS = [
  { value: 'small', label: 'Smaller file' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'high', label: 'High quality' },
  { value: 'custom', label: 'Custom' },
];

export const VIDEO_CODECS = [
  { value: 'avc', label: 'H.264' },
  { value: 'hevc', label: 'HEVC' },
  { value: 'vp9', label: 'VP9' },
  { value: 'av1', label: 'AV1' },
];

/** Containers and the codecs each one carries in this app, most compatible first. */
export const CONTAINERS = {
  mp4: { label: 'MP4', ext: 'mp4', mime: 'video/mp4', video: ['avc', 'hevc', 'av1'], audio: ['aac', 'opus'] },
  mov: { label: 'MOV', ext: 'mov', mime: 'video/quicktime', video: ['avc', 'hevc'], audio: ['aac'] },
  webm: { label: 'WebM', ext: 'webm', mime: 'video/webm', video: ['vp9', 'av1'], audio: ['opus'] },
};

/** Audio-only formats; codec null means our own WAV writer. */
export const AUDIO_FORMATS = {
  wav: { label: 'WAV', ext: 'wav', mime: 'audio/wav', codec: null },
  m4a: { label: 'M4A (AAC)', ext: 'm4a', mime: 'audio/mp4', codec: 'aac' },
  ogg: { label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', codec: 'opus' },
  flac: { label: 'FLAC', ext: 'flac', mime: 'audio/flac', codec: 'flac' },
};

/** Default container for a codec (when the codec is chosen first). */
export const CODEC_HOME = { avc: 'mp4', hevc: 'mp4', av1: 'mp4', vp9: 'webm' };

/** Rough compression efficiency relative to H.264 at equal visual quality. */
const CODEC_EFFICIENCY = { avc: 1, hevc: 0.6, vp9: 0.65, av1: 0.5 };
const LEVEL_FACTOR = { small: 0.5, balanced: 1, high: 2 };
/** H.264 bits per pixel at 30 fps for the Balanced level (1080p30 is about 10 Mbps). */
const BASE_BPP = 0.16;

export const AUDIO_BITRATE = { aac: 192_000, opus: 160_000 };

export const DEFAULT_SETTINGS = Object.freeze({
  name: '',
  destination: 'device',
  video: true,
  resolution: 1080,
  bitrate: 'balanced',
  customMbps: 12,
  codec: 'avc',
  format: 'mp4',
  fps: 30,
  includeAudio: true,
  audio: false,
  audioFormat: 'wav',
});

/* Pure helpers ---------------------------------------------------------------- */

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output pixel size: project aspect, short side = resolution, even dimensions. */
export function outputSize(projW, projH, resolution) {
  const k = resolution / Math.min(projW, projH);
  return { width: even(projW * k), height: even(projH * k) };
}

/** Video bitrate in bits per second for a preset level (or custom Mbps). */
export function videoBitrate({ width, height, fps, codec = 'avc', level = 'balanced', customMbps = 12 }) {
  if (level === 'custom') return Math.max(100_000, Math.round(customMbps * 1e6));
  const fpsFactor = (fps / 30) ** 0.7;
  const bps = width * height * 30 * BASE_BPP * fpsFactor * (CODEC_EFFICIENCY[codec] ?? 1) * (LEVEL_FACTOR[level] ?? 1);
  return Math.max(200_000, Math.round(bps / 1000) * 1000);
}

/** Number of output frames for a duration (a trailing partial frame counts). */
export function frameCount(durationUs, fps) {
  if (durationUs <= 0) return 0;
  return Math.max(1, Math.ceil((durationUs * fps) / US - 1e-6));
}

/** Timeline time (integer microseconds) of output frame i. */
export function frameTime(i, fps, start = 0) {
  return start + Math.round((i * US) / fps);
}

/** Estimated output size in bytes. */
export function estimateSize(settings, durationUs, { projW = 1920, projH = 1080 } = {}) {
  const sec = durationUs / US;
  let bytes = 0;
  if (settings.video) {
    const { width, height } = outputSize(projW, projH, settings.resolution);
    const v = videoBitrate({ width, height, fps: settings.fps, codec: settings.codec, level: settings.bitrate, customMbps: settings.customMbps });
    const a = settings.includeAudio ? AUDIO_BITRATE[audioCodecFor(settings.format)] || 0 : 0;
    // Variable bitrate lands a little under target on most footage; container overhead adds about 1%.
    bytes += ((v * 0.95 + a) * sec) / 8 * 1.01;
  }
  if (settings.audio) {
    const f = AUDIO_FORMATS[settings.audioFormat];
    if (!f?.codec) bytes += 44 + Math.round(sec * 48000) * 2 * 2;
    else if (f.codec === 'flac') bytes += sec * 48000 * 2 * 2 * 0.6;
    else bytes += (AUDIO_BITRATE[f.codec] * sec) / 8 * 1.02;
  }
  return Math.round(bytes);
}

/** Audio codec used inside a video container. */
export function audioCodecFor(format, encodableAudio) {
  const list = CONTAINERS[format]?.audio || [];
  if (!encodableAudio) return list[0] || null;
  return list.find((c) => encodableAudio.includes(c)) || null;
}

/**
 * Make codec and format agree and only use encodable codecs. changed says
 * which one the user just picked ('codec' or 'format'); the other one adapts.
 * caps = { video: [codec], audio: [codec] } from detectCapabilities().
 */
export function reconcile(settings, caps, changed = 'format') {
  const s = { ...settings };
  const can = (c) => !caps || caps.video.includes(c);
  if (!CONTAINERS[s.format]) s.format = 'mp4';
  if (changed === 'codec' && can(s.codec) && !CONTAINERS[s.format].video.includes(s.codec)) {
    s.format = CODEC_HOME[s.codec] || Object.keys(CONTAINERS).find((f) => CONTAINERS[f].video.includes(s.codec)) || s.format;
  }
  if (!CONTAINERS[s.format].video.includes(s.codec) || !can(s.codec)) {
    const inFormat = CONTAINERS[s.format].video.find(can);
    if (inFormat) s.codec = inFormat;
    else {
      // Nothing encodable in this container: move to the first one that works.
      for (const [f, info] of Object.entries(CONTAINERS)) {
        const c = info.video.find(can);
        if (c) {
          s.format = f;
          s.codec = c;
          break;
        }
      }
    }
  }
  if (caps && !caps.audioFormats?.includes(s.audioFormat)) s.audioFormat = caps.audioFormats?.[0] || 'wav';
  return s;
}

/** Codecs the browser can actually encode for the chosen size. */
export async function detectCapabilities({ width = 1920, height = 1080, fps = 30 } = {}) {
  const video = [];
  await Promise.all(VIDEO_CODECS.map(async ({ value }) => {
    const bitrate = videoBitrate({ width, height, fps, codec: value });
    const ok = await canEncodeVideo(value, { width, height, bitrate, frameRate: fps }).catch(() => false);
    if (ok) video.push(value);
  }));
  const audio = [];
  await Promise.all(['aac', 'opus', 'flac'].map(async (codec) => {
    const ok = await canEncodeAudio(codec, { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE[codec] || 128_000 }).catch(() => false);
    if (ok) audio.push(codec);
  }));
  const order = (list, ref) => ref.filter((c) => list.includes(c));
  const audioFormats = Object.entries(AUDIO_FORMATS).filter(([, f]) => !f.codec || audio.includes(f.codec)).map(([k]) => k);
  return { video: order(video, VIDEO_CODECS.map((c) => c.value)), audio: order(audio, ['aac', 'opus', 'flac']), audioFormats };
}

/** File-system safe base name. */
export function safeFileName(name, fallback = 'Untitled') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (s || fallback).slice(0, 120);
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Human readable message for an export failure. */
export function describeError(err, settings = {}) {
  if (err?.name === 'AbortError') return 'Export canceled.';
  const msg = String(err?.message || err || '');
  const codec = VIDEO_CODECS.find((c) => c.value === settings.codec)?.label || settings.codec;
  if (err instanceof RangeError || /out of memory|allocation|array buffer/i.test(msg) || err?.name === 'QuotaExceededError') {
    return 'The export ran out of memory or storage space. Try a lower resolution, a shorter project, or free up disk space.';
  }
  if (/not supported|unsupported|NotSupportedError|EncodingError|configure/i.test(msg) || err?.name === 'NotSupportedError') {
    return `This browser could not encode ${codec || 'the video'} at this resolution. Try H.264, a lower resolution or another format.`;
  }
  if (/WebGL/i.test(msg)) return 'The graphics context was lost or WebGL2 is unavailable, so frames could not be rendered.';
  if (/decod/i.test(msg)) return `A media file could not be decoded: ${msg}`;
  return msg ? `Export failed: ${msg}` : 'Export failed for an unknown reason.';
}

/* Runtime helpers ------------------------------------------------------------- */

const abortError = () => new DOMException('Export canceled', 'AbortError');

/** Let the page breathe between frames (macrotask, not clamped like setTimeout). */
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const waiting = [];
if (channel) channel.port1.onmessage = () => waiting.shift()?.();
function yieldToEventLoop() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => {
    waiting.push(r);
    channel.port2.postMessage(0);
  });
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Load every font used by text clips so the first frames do not fall back. */
async function preloadFonts(project) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const specs = new Set();
  for (const t of expandProject(project).tracks) for (const c of t.clips) if (c.type === 'text' && c.style) specs.add(fontString(c.style, 32));
  await Promise.all([...specs].map((s) => document.fonts.load(s).catch(() => null)));
}

/**
 * Video frames for one clip. Source times only move forward while a clip is
 * on screen (also through transitions), so a sequential decode is enough:
 * keep the latest sample at or before the wanted time and the one after it
 * (smooth slow motion draws between the two), close the rest.
 */
class ClipFrames {
  constructor(clip, track) {
    this.clip = clip;
    this.track = track;
    this.iter = null;
    this.cur = null;
    this.next = null;
    this.ended = false;
    // Compositor-ready pictures of cur and of next: { of, frame, version, rot }.
    this.shown = { of: null, frame: null, version: 0, rot: null };
    this.after = { of: null, frame: null, version: 0, rot: null };
  }

  async _pull() {
    if (this.ended) return null;
    const r = await this.iter.next();
    if (r.done) {
      this.ended = true;
      return null;
    }
    return r.value;
  }

  /**
   * Texture info for source time sec, or null when nothing is decodable yet.
   * With smooth ('blend' or 'flow') and sec between two samples it also
   * carries between = { mode, frac, next } (see engine/slow-motion.js).
   */
  async at(sec, smooth = null) {
    if (!this.iter) {
      const first = await this.track.getFirstTimestamp().catch(() => 0);
      const sink = new VideoSampleSink(this.track);
      this.iter = sink.samples(Math.max(first, sec));
      this.cur = await this._pull();
      this.next = await this._pull();
    }
    const eps = 1e-6;
    while (this.next && this.next.timestamp <= sec + eps) {
      this.cur?.close();
      this.cur = this.next;
      this.next = await this._pull();
    }
    const s = this.cur || this.next;
    if (!s) return null;
    const info = this._info(this.shown, s, `vid:${this.clip.id}`);
    if (smooth && this.cur && this.next) {
      const frac = framePosition(sec, this.cur.timestamp, this.next.timestamp);
      const next = () => this._info(this.after, this.next, `vid:${this.clip.id}:next`);
      // A hair before the next frame (whole-microsecond times): that frame, as it is.
      if (frac >= 1 - FRAME_SNAP) return next();
      if (needsBetween(frac)) info.between = { mode: smooth, frac, next: next() };
    }
    return info;
  }

  /** Texture info for sample s through a picture slot (converted once per sample). */
  _info(slot, s, key) {
    if (slot.of !== s) {
      this._release(slot);
      slot.of = s;
      slot.version++;
      if (s.rotation || s.flip) {
        // Rotated phone footage: draw upright once, the compositor gets a plain canvas.
        const w = s.displayWidth;
        const h = s.displayHeight;
        if (!slot.rot || slot.rot.width !== w || slot.rot.height !== h) slot.rot = makeCanvas(w, h);
        s.draw(slot.rot.getContext('2d'), 0, 0, w, h);
        slot.frame = slot.rot;
      } else {
        slot.frame = s.toVideoFrame();
      }
    }
    return { key, source: slot.frame, width: s.displayWidth, height: s.displayHeight, version: slot.version };
  }

  _release(slot) {
    if (slot.frame && slot.frame !== slot.rot) slot.frame.close?.();
    slot.frame = null;
    slot.of = null;
  }

  async close() {
    this._release(this.shown);
    this._release(this.after);
    this.cur?.close();
    this.next?.close();
    this.cur = this.next = null;
    try {
      await this.iter?.return?.();
    } catch {
      /* decoder already gone */
    }
    this.iter = null;
  }
}

/** Decoded media shared by the frame loop: one Input per video file, clip streams, images. */
class MediaFrames {
  constructor(project, library) {
    this.project = project;
    this.library = library;
    this.inputs = new Map(); // assetId -> Promise<{ input, track }>
    this.clips = new Map(); // clipId -> ClipFrames
    this.images = new Map(); // assetId -> ImageBitmap
    this.used = new Set();
    this.resolved = new Map(); // clipId -> texture info for the current frame
  }

  _input(asset) {
    let p = this.inputs.get(asset.id);
    if (!p) {
      p = (async () => {
        const blob = await this.library.mediaBlob(asset);
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`${asset.name} has no video track`);
        if (!(await track.canDecode())) throw new Error(`${asset.name} cannot be decoded in this browser`);
        return { input, track };
      })();
      this.inputs.set(asset.id, p);
    }
    return p;
  }

  async _image(asset) {
    let bmp = this.images.get(asset.id);
    if (!bmp) {
      const blob = await this.library.mediaBlob(asset);
      // WebGL ignores UNPACK_FLIP_Y for ImageBitmap sources, so flip while decoding (EXIF orientation still applies).
      bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
      this.images.set(asset.id, bmp);
    }
    return bmp;
  }

  /** Decode whatever the layers need for this frame. */
  async prepare(layers) {
    this.used.clear();
    this.resolved.clear();
    const want = async (layer) => {
      if (layer.kind === 'transition') {
        await want(layer.from);
        await want(layer.to);
        return;
      }
      if (layer.kind !== 'media' || !layer.asset) return;
      const { clip, asset } = layer;
      if (clip.type === 'image') {
        const bmp = await this._image(asset);
        this.resolved.set(clip.id, { key: `img:${asset.id}`, source: bmp, width: bmp.width, height: bmp.height, version: 1 });
        return;
      }
      let stream = this.clips.get(clip.id);
      if (!stream) {
        const { track } = await this._input(asset);
        stream = new ClipFrames(clip, track);
        this.clips.set(clip.id, stream);
      }
      this.used.add(clip.id);
      const info = await stream.at(layer.sourceTime / US, layer.smoothSlow || null);
      if (info) this.resolved.set(clip.id, info);
    };
    for (const l of layers) await want(l);
  }

  /** Clips stay on screen for one contiguous stretch; close the ones that left. */
  async sweep() {
    for (const [id, stream] of this.clips) {
      if (this.used.has(id)) continue;
      await stream.close();
      this.clips.delete(id);
    }
  }

  async dispose() {
    for (const s of this.clips.values()) await s.close();
    this.clips.clear();
    for (const bmp of this.images.values()) bmp.close?.();
    this.images.clear();
    for (const p of this.inputs.values()) {
      const r = await p.catch(() => null);
      r?.input.dispose();
    }
    this.inputs.clear();
  }
}

/** Frame renderer around a private compositor (export and stills). */
class FrameRenderer {
  constructor(project, library, width, height) {
    this.project = project;
    this.width = width;
    this.height = height;
    const { width: pw, height: ph } = project.settings;
    this.canvas = makeCanvas(width, height);
    this.media = new MediaFrames(project, library);
    this.text = new TextCache();
    this.scale = width / pw;
    this.compositor = new Compositor(this.canvas, { resolve: (l) => this._resolve(l), preserveDrawingBuffer: true });
    this.compositor.resize(width, height, pw, ph);
  }

  _resolve(layer) {
    if (layer.kind === 'text' || layer.kind === 'sticker' || layer.kind === 'avatar') return this.text.get(layer, this.scale);
    if (layer.kind === 'media') return this.media.resolved.get(layer.clip.id) || null;
    return null;
  }

  async render(t) {
    const layers = evaluate(this.project, t);
    await this.media.prepare(layers);
    if (!this.compositor.render(layers, { settings: this.project.settings, time: t / US })) throw new Error('WebGL context lost while rendering');
    await this.media.sweep();
  }

  async dispose() {
    await this.media.dispose();
    this.compositor.dispose();
  }
}

/** A downscaled snapshot of the canvas for progress previews. */
async function thumbnail(canvas, maxW = 360) {
  if (typeof createImageBitmap !== 'function') return null;
  const w = Math.min(maxW, canvas.width);
  const h = Math.max(2, Math.round((canvas.height * w) / canvas.width));
  return createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' }).catch(() => null);
}

/** Render one frame of the project at time t to an ImageBitmap (previews and thumbnails). */
export async function renderStill(project, library, t = 0, { maxWidth = 640 } = {}) {
  const snap = structuredClone(project);
  const { width: pw, height: ph } = snap.settings;
  const k = Math.min(1, maxWidth / pw);
  const r = new FrameRenderer(snap, library, even(pw * k), even(ph * k));
  try {
    await preloadFonts(snap);
    await ensureLuts(snap, library).catch(() => {});
    await ensureCutout(snap);
    await r.render(Math.max(0, t));
    return await createImageBitmap(r.canvas);
  } finally {
    await r.dispose();
  }
}

/* Targets --------------------------------------------------------------------- */

const LARGE_OUTPUT = 400 * 1024 * 1024;
const liveFiles = new Set(); // temp export files still referenced by a result

/**
 * Where encoded bytes go: memory for normal sizes, a temporary file in the
 * origin private file system for large ones so memory stays flat.
 */
async function openTarget(estimated, force) {
  const wantFile = force === 'file' || (force !== 'memory' && estimated > LARGE_OUTPUT);
  if (wantFile && navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('video-studio-exports', { create: true });
      // Leftovers from earlier sessions.
      for await (const old of dir.keys()) if (!liveFiles.has(old)) await dir.removeEntry(old).catch(() => {});
      const name = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`;
      liveFiles.add(name);
      const handle = await dir.getFileHandle(name, { create: true });
      if (handle.createWritable) {
        const writable = await handle.createWritable();
        return {
          kind: 'file',
          target: new StreamTarget(writable, { chunked: true }),
          async result(type) {
            const file = await handle.getFile();
            return new Blob([file], { type });
          },
          async discard() {
            await writable.abort?.().catch(() => {});
            await dir.removeEntry(name).catch(() => {});
            liveFiles.delete(name);
          },
        };
      }
    } catch {
      /* fall back to memory */
    }
  }
  const target = new BufferTarget();
  return {
    kind: 'memory',
    target,
    async result(type) {
      return new Blob([target.buffer], { type });
    },
    async discard() {},
  };
}

/* Export ---------------------------------------------------------------------- */

/**
 * Export the project. settings follow DEFAULT_SETTINGS; one call produces one
 * file: kind 'video' (video settings, optional sound) or 'audio' (audio-only
 * format). Returns { blob, fileName, mimeType, kind, width, height, frames,
 * duration, elapsed, fps }.
 *
 * onProgress({ phase, done, total, fraction, elapsed, remaining, preview? })
 * fires often; preview is an ImageBitmap about every 0.5 s (the receiver
 * closes it).
 */
export async function exportProject(project, library, settings, { kind = 'video', onProgress, signal, target: forceTarget } = {}) {
  const snap = structuredClone(project);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const duration = projectDuration(snap);
  if (duration <= 0) throw new Error('The timeline is empty. Add some media before exporting.');
  if (signal?.aborted) throw abortError();
  const base = safeFileName(s.name || snap.name);
  return kind === 'audio' ? exportAudio(snap, library, s, duration, base, { onProgress, signal, forceTarget }) : exportVideo(snap, library, s, duration, base, { onProgress, signal, forceTarget });
}

async function exportVideo(project, library, s, duration, base, { onProgress, signal, forceTarget }) {
  const container = CONTAINERS[s.format];
  if (!container) throw new Error(`Unknown format ${s.format}`);
  if (!container.video.includes(s.codec)) throw new Error(`${s.codec} cannot go in ${container.label}`);
  const fps = s.fps;
  const { width, height } = outputSize(project.settings.width, project.settings.height, s.resolution);
  const bitrate = videoBitrate({ width, height, fps, codec: s.codec, level: s.bitrate, customMbps: s.customMbps });
  const total = frameCount(duration, fps);
  const supported = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps }).catch(() => false);
  if (!supported) {
    const label = VIDEO_CODECS.find((c) => c.value === s.codec)?.label || s.codec;
    throw new Error(`This browser cannot encode ${label} at ${width}x${height} (not supported). Try a lower resolution or another codec.`);
  }
  const hw = await canEncodeVideo(s.codec, { width, height, bitrate, frameRate: fps, hardwareAcceleration: 'prefer-hardware' }).catch(() => false);
  let audioCodec = null;
  // A silent project gets no audio track at all.
  if (s.includeAudio && audibleClips(project).length) {
    for (const c of container.audio) {
      if (await canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: AUDIO_BITRATE[c] }).catch(() => false)) {
        audioCodec = c;
        break;
      }
    }
  }
  const sampleRate = 48000;
  const totalSamples = Math.round((duration * sampleRate) / US);
  const estimated = estimateSize({ ...s, audio: false }, duration, { projW: project.settings.width, projH: project.settings.height });
  const sink = await openTarget(estimated, forceTarget);
  const fileTarget = sink.kind === 'file';
  const format = s.format === 'webm' ? new WebMOutputFormat() : s.format === 'mov' ? new MovOutputFormat({ fastStart: fileTarget ? 'reserve' : 'in-memory' }) : new Mp4OutputFormat({ fastStart: fileTarget ? 'reserve' : 'in-memory' });
  const output = new Output({ format, target: sink.target });
  let renderer = null;
  let audioGen = null;
  const started = performance.now();
  try {
    renderer = new FrameRenderer(project, library, width, height);
    const videoSource = new CanvasSource(renderer.canvas, {
      codec: s.codec,
      quality: new Quality({ bitrate, bitrateMode: 'variable' }),
      keyFrameInterval: 2,
      latencyMode: 'quality',
      hardwareAcceleration: hw ? 'prefer-hardware' : 'no-preference',
    });
    output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: total + 2 });
    let audioSource = null;
    if (audioCodec) {
      audioSource = new AudioSampleSource({ codec: audioCodec, quality: new Quality({ bitrate: AUDIO_BITRATE[audioCodec] }) });
      // Packets hold 1024 (AAC) or 960 (Opus) samples; reserve generously.
      output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(totalSamples / 480) + 64 });
    }
    output.setMetadataTags({ title: s.name || project.name, date: new Date() });
    await output.start();
    await preloadFonts(project);
    await ensureLuts(project, library).catch(() => {});
    await ensureCutout(project);

    let audioAt = 0; // seconds of sound handed to the encoder
    let audioDone = !audioSource;
    if (audioSource) audioGen = mixChunks(project, library, { end: duration, sampleRate, channels: 2, signal });
    const pumpAudio = async (untilSec) => {
      while (!audioDone && audioAt < untilSec) {
        const r = await audioGen.next();
        if (r.done) {
          audioDone = true;
          break;
        }
        const { channels, frames } = r.value;
        const data = new Float32Array(frames * channels.length);
        channels.forEach((ch, c) => data.set(ch, c * frames));
        const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels.length, sampleRate, timestamp: audioAt });
        await audioSource.add(sample);
        sample.close();
        audioAt += frames / sampleRate;
      }
    };

    let lastPreview = 0;
    let lastYield = performance.now();
    let lastReport = 0;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw abortError();
      const t = frameTime(i, fps);
      // Keep sound about a second ahead so the muxer can interleave without buffering everything.
      await pumpAudio(t / US + 1);
      await renderer.render(t);
      await videoSource.add(i / fps, 1 / fps);
      const now = performance.now();
      if (onProgress && (now - lastReport > 100 || i === total - 1)) {
        lastReport = now;
        const elapsed = (now - started) / 1000;
        const done = i + 1;
        const progress = { phase: 'video', done, total, fraction: done / total, elapsed, remaining: (elapsed / done) * (total - done), fps: done / Math.max(0.001, elapsed) };
        if (now - lastPreview > 500 || i === 0) {
          lastPreview = now;
          progress.preview = await thumbnail(renderer.canvas);
        }
        onProgress(progress);
      }
      if (now - lastYield > 12) {
        await yieldToEventLoop();
        lastYield = performance.now();
      }
    }
    await pumpAudio(Infinity);
    videoSource.close();
    audioSource?.close();
    onProgress?.({ phase: 'finalizing', done: total, total, fraction: 1, elapsed: (performance.now() - started) / 1000, remaining: 0 });
    await output.finalize();
    const mimeType = container.mime;
    const blob = await sink.result(mimeType);
    const elapsed = (performance.now() - started) / 1000;
    return { kind: 'video', blob, release: () => sink.discard(), fileName: `${base}.${container.ext}`, mimeType, width, height, frames: total, duration, elapsed, fps: total / elapsed, codec: s.codec, audioCodec, bitrate, hardware: hw };
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    await sink.discard();
    throw err;
  } finally {
    await audioGen?.return?.().catch(() => {});
    await renderer?.dispose().catch(() => {});
  }
}

async function exportAudio(project, library, s, duration, base, { onProgress, signal, forceTarget }) {
  const f = AUDIO_FORMATS[s.audioFormat];
  if (!f) throw new Error(`Unknown audio format ${s.audioFormat}`);
  const sampleRate = 48000;
  const channels = 2;
  const started = performance.now();
  const report = ({ done, total }) => {
    const elapsed = (performance.now() - started) / 1000;
    onProgress?.({ phase: 'audio', done, total, fraction: total ? done / total : 1, elapsed, remaining: done ? (elapsed / done) * (total - done) : 0 });
  };
  let sink = null;
  const result = (blob) => {
    const elapsed = (performance.now() - started) / 1000;
    return { kind: 'audio', blob, release: () => sink?.discard(), fileName: `${base}.${f.ext}`, mimeType: f.mime, frames: 0, duration, elapsed };
  };
  if (!f.codec) {
    const totalFrames = Math.round((duration * sampleRate) / US);
    const parts = [wavHeader(totalFrames, channels, sampleRate)];
    for await (const chunk of mixChunks(project, library, { end: duration, sampleRate, channels, signal, onProgress: report })) {
      parts.push(pcm16(chunk.channels));
      await yieldToEventLoop();
    }
    return result(new Blob(parts, { type: f.mime }));
  }
  if (!(await canEncodeAudio(f.codec, { numberOfChannels: channels, sampleRate }).catch(() => false))) {
    throw new Error(`This browser cannot encode ${f.label} audio (not supported). Choose WAV instead.`);
  }
  sink = await openTarget(0, forceTarget);
  const format = s.audioFormat === 'm4a' ? new Mp4OutputFormat({ fastStart: sink.kind === 'file' ? false : 'in-memory' }) : s.audioFormat === 'ogg' ? new OggOutputFormat() : new FlacOutputFormat();
  const output = new Output({ format, target: sink.target });
  try {
    const source = new AudioSampleSource({ codec: f.codec, quality: new Quality({ bitrate: AUDIO_BITRATE[f.codec] || 192_000 }) });
    output.addAudioTrack(source);
    output.setMetadataTags({ title: s.name || project.name, date: new Date() });
    await output.start();
    let at = 0;
    for await (const chunk of mixChunks(project, library, { end: duration, sampleRate, channels, signal, onProgress: report })) {
      const data = new Float32Array(chunk.frames * channels);
      chunk.channels.forEach((ch, c) => data.set(ch, c * chunk.frames));
      const sample = new AudioSample({ data, format: 'f32-planar', numberOfChannels: channels, sampleRate, timestamp: at });
      await source.add(sample);
      sample.close();
      at += chunk.frames / sampleRate;
      await yieldToEventLoop();
    }
    source.close();
    await output.finalize();
    return result(await sink.result(f.mime));
  } catch (err) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    await sink.discard();
    throw err;
  }
}

/**
 * Render frames of [start, end) at a size and frame rate, one at a time
 * (GIF and image exports). Yields { canvas, index, total }; the canvas is
 * reused, so read it before asking for the next frame.
 */
export async function* renderFrames(project, library, { width, height, fps, start = 0, end, signal } = {}) {
  const snap = structuredClone(project);
  const stop = end ?? projectDuration(snap);
  const total = Math.max(1, frameCount(stop - start, fps));
  const r = new FrameRenderer(snap, library, even(width), even(height));
  try {
    await preloadFonts(snap);
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw abortError();
      await r.render(Math.min(stop - 1, start + Math.round((i * US) / fps)));
      yield { canvas: r.canvas, index: i, total };
    }
  } finally {
    await r.dispose();
  }
}
