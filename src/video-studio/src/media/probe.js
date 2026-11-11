/**
 * Read basic facts about an imported file: kind, duration, size, frame rate
 * and whether it has sound. Uses Mediabunny's demuxers (no full decode) and
 * falls back to a media element for formats it cannot parse.
 */
import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';
import { US } from '../lib/time.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;

export function guessKind(file) {
  const type = file.type || '';
  if (type.startsWith('image/') || IMAGE_EXT.test(file.name || '')) return 'image';
  if (type.startsWith('audio/') || AUDIO_EXT.test(file.name || '')) return 'audio';
  if (type.startsWith('video/') || VIDEO_EXT.test(file.name || '')) return 'video';
  return null;
}

export function extOf(name, mime = '') {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  if (m) return m[1].toLowerCase();
  const fromMime = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'weba', 'audio/ogg': 'ogg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  return fromMime[mime] || 'bin';
}

/** Longest side SVG pictures are drawn at when imported (sharp on a 4K frame). */
const SVG_SIDE = 2160;

export function isSvg(file) {
  return /svg/i.test(file?.type || '') || /\.svg$/i.test(file?.name || '');
}

/**
 * The SVG document to draw for an imported SVG picture, sized so its longest
 * side is `side` pixels: its own width and height, else its viewBox, give the
 * shape (300 x 150 when it has neither, as browsers do). Throws for a file
 * that is not an SVG picture.
 */
export function svgForRaster(text, side = SVG_SIDE) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length) throw new Error('This SVG file is damaged.');
  const len = (v) => {
    const m = /^\s*(\d*\.?\d+)\s*(px)?\s*$/.exec(v || '');
    return m ? Number(m[1]) : 0;
  };
  const vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const [vbw, vbh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : [0, 0];
  let w = len(root.getAttribute('width'));
  let h = len(root.getAttribute('height'));
  if (!w || !h) {
    if (vbw) [w, h] = w ? [w, (w * vbh) / vbw] : h ? [(h * vbw) / vbh, h] : [vbw, vbh];
    else [w, h] = [w || 300, h || 150];
  }
  // Without a viewBox the drawing is in the picture's own units: keep them while it is scaled up.
  if (!vbw) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const k = side / Math.max(w, h);
  const width = Math.max(1, Math.round(w * k));
  const height = Math.max(1, Math.round(h * k));
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return { text: new XMLSerializer().serializeToString(doc), width, height };
}

/**
 * Draw an SVG picture into a PNG file. The preview, thumbnails and export
 * decode pictures with createImageBitmap, which can't read SVG.
 */
async function svgToPng(file) {
  const { text, width, height } = svgForRaster(await file.text());
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error('This SVG file could not be drawn.');
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!png) throw new Error('This SVG file could not be drawn.');
    return new File([png], `${(file.name || 'Picture').replace(/\.svg$/i, '')}.png`, { type: 'image/png', lastModified: file.lastModified });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The file to store for an import: SVG pictures become PNG, everything else is kept as it is. */
export async function storableFile(file) {
  return isSvg(file) ? svgToPng(file) : file;
}

async function probeImage(file) {
  if (typeof createImageBitmap === 'function' && !isSvg(file)) {
    let bmp;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      throw new Error("This picture can't be opened. It may be damaged, or in a format this browser doesn't support (such as HEIC).");
    }
    const out = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return out;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { width: img.naturalWidth || 1080, height: img.naturalHeight || 1080 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeWithElement(file, kind) {
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.muted = true;
    el.src = url;
    await new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve;
      el.onerror = () => reject(new Error('This file type is not supported by your browser.'));
    });
    let duration = el.duration;
    if (!Number.isFinite(duration)) {
      // Some WebM recordings report Infinity until the end is reached.
      el.currentTime = 1e7;
      await new Promise((r) => (el.ontimeupdate = r));
      duration = el.duration;
    }
    return {
      duration: Math.round((Number.isFinite(duration) ? duration : 0) * US),
      width: el.videoWidth || 0,
      height: el.videoHeight || 0,
      fps: 30,
      hasAudio: kind === 'audio' ? true : el.mozHasAudio ?? el.webkitAudioDecodedByteCount !== 0,
      hasVideo: kind === 'video' ? Boolean(el.videoWidth) : false,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Facts about a media file. Throws with a readable message when unsupported. */
export async function probe(file) {
  const kind = guessKind(file);
  if (!kind) throw new Error(`${file.name || 'This file'} is not a video, audio or image file.`);
  if (!file.size) throw new Error('This file is empty.');
  if (kind === 'image') {
    const { width, height } = await probeImage(file);
    return { kind, width, height, duration: 0, fps: 0, hasAudio: false, hasVideo: false };
  }
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!video && !audio) throw new Error('no tracks');
    const duration = await input.computeDuration();
    let fps = 30;
    let width = 0;
    let height = 0;
    if (video) {
      [width, height] = await Promise.all([video.getDisplayWidth(), video.getDisplayHeight()]);
      try {
        const stats = await video.computePacketStats(60);
        if (stats?.averagePacketRate) fps = Math.round(stats.averagePacketRate * 100) / 100;
      } catch {
        /* keep the default */
      }
    }
    const canVideo = video ? await video.canDecode().catch(() => false) : false;
    const canAudio = audio ? await audio.canDecode().catch(() => false) : false;
    if (video && !canVideo) {
      // The demuxer understood it but WebCodecs cannot decode it here; the element may.
      input.dispose();
      return { kind: 'video', ...(await probeWithElement(file, 'video')), decodable: false };
    }
    const realKind = video ? 'video' : 'audio';
    return { kind: realKind, width, height, duration: Math.round(duration * US), fps, hasAudio: Boolean(audio) && canAudio, hasVideo: Boolean(video), decodable: true };
  } catch (err) {
    if (err?.message === 'This file type is not supported by your browser.') throw err;
    return { kind, ...(await probeWithElement(file, kind)), decodable: false };
  } finally {
    if (!input.disposed) input.dispose();
  }
}
