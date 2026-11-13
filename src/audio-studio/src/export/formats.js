// Export formats and the option logic shared by the Save As / Export File
// dialog, the export pipeline and Save. Pure functions: no DOM, no workers.
//
// Options object (what the dialog edits and the pipeline consumes):
//   { format, sampleRate, channels, bitDepth, dither, settings: { level, bitrate }, markers, meta }

import { MP3_RATES, mp3Bitrates } from './mp3.js';

export const COMMON_RATES = [8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

export const FORMATS = [
  {
    id: 'wav',
    label: 'Wave PCM (*.wav)',
    ext: 'wav',
    exts: ['wav', 'wave', 'bwf', 'rf64'],
    mime: 'audio/wav',
    lossy: false,
    bitDepths: [8, 16, 24, 32],
    // As many channels as the format holds: multitrack recorder files often have 10 or more.
    maxChannels: 65535,
    markers: true,
    settings: [],
  },
  {
    id: 'aiff',
    label: 'AIFF (*.aif, *.aiff)',
    ext: 'aif',
    exts: ['aif', 'aiff', 'aifc'],
    mime: 'audio/aiff',
    lossy: false,
    bitDepths: [8, 16, 24, 32],
    maxChannels: 32767,
    markers: true,
    settings: [],
  },
  {
    id: 'flac',
    label: 'FLAC (*.flac)',
    ext: 'flac',
    exts: ['flac'],
    mime: 'audio/flac',
    lossy: false,
    bitDepths: [8, 16, 24],
    maxChannels: 8,
    maxRate: 655350,
    markers: false,
    settings: [{ id: 'level', label: 'Compression Level', options: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => ({ value: v, label: v === 0 ? '0 (Fastest)' : v === 8 ? '8 (Smallest)' : v === 5 ? '5 (Default)' : String(v) })), default: 5 }],
  },
  {
    id: 'mp3',
    label: 'MP3 Audio (*.mp3)',
    ext: 'mp3',
    exts: ['mp3'],
    mime: 'audio/mpeg',
    lossy: true,
    rates: MP3_RATES,
    maxChannels: 2,
    markers: false,
    defaultDither: 'none',
    settings: [{ id: 'bitrate', label: 'Bitrate (CBR)', options: (o) => mp3Bitrates(o.sampleRate).map((b) => ({ value: b, label: `${b} kbps` })), default: 192, unit: 'kbps' }],
  },
  {
    id: 'opus',
    label: 'Ogg Opus (*.opus)',
    ext: 'opus',
    exts: ['opus'],
    mime: 'audio/ogg',
    lossy: true,
    rates: [48000],
    maxChannels: 2,
    markers: false,
    webcodecs: true,
    settings: [{ id: 'bitrate', label: 'Bitrate', options: [32, 48, 64, 96, 128, 160, 192, 256].map((b) => ({ value: b, label: `${b} kbps` })), default: 128, unit: 'kbps' }],
  },
  {
    id: 'm4a',
    label: 'AAC in MPEG-4 (*.m4a)',
    ext: 'm4a',
    exts: ['m4a', 'mp4', 'aac'],
    mime: 'audio/mp4',
    lossy: true,
    rates: [44100, 48000],
    maxChannels: 2,
    markers: false,
    webcodecs: true,
    // 96 to 192 kbps is what every platform AAC encoder accepts (Windows Media
    // Foundation allows only these; macOS rejects 64 kbps stereo).
    settings: [{ id: 'bitrate', label: 'Bitrate', options: [96, 128, 160, 192].map((b) => ({ value: b, label: `${b} kbps` })), default: 192, unit: 'kbps' }],
  },
];

export function getFormat(id) {
  return FORMATS.find((f) => f.id === id) || null;
}

/** Format id for a file name's extension, or null. */
export function formatForName(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  return FORMATS.find((f) => f.exts.includes(ext))?.id || null;
}

/** Closest value in `list`; ties go to the larger value (more quality, not less). */
function nearest(list, value) {
  return list.reduce((best, v) => {
    const d = Math.abs(v - value);
    const bd = Math.abs(best - value);
    return d < bd || (d === bd && v > best) ? v : best;
  }, list[0]);
}

/** The bit depth a document is stored at, as the default for integer formats. */
export function docBitDepth(doc) {
  const b = doc?.info?.bitDepth;
  return b === 32 ? 32 : b >= 24 ? 24 : b >= 16 ? 16 : b === 8 ? 8 : 16;
}

/** Default export options for a document and format. */
export function defaultOptions(source, formatId = 'wav') {
  const settings = {};
  for (const s of getFormat(formatId)?.settings || []) settings[s.id] = s.default;
  return conformOptions(formatId, {
    format: formatId,
    sampleRate: source.sampleRate,
    channels: source.channels,
    bitDepth: source.bitDepth ?? 32,
    dither: 'triangular',
    settings,
    markers: true,
    meta: true,
  }).options;
}

/**
 * Makes options valid for a format: allowed rate, channel count, bit depth
 * and settings. Returns { options, notes } where notes explain changes.
 */
export function conformOptions(formatId, input) {
  const f = getFormat(formatId) || getFormat('wav');
  const o = { ...input, format: f.id, settings: { ...(input.settings || {}) } };
  const notes = [];
  o.sampleRate = Math.round(Number(o.sampleRate) || 48000);
  if (f.rates && !f.rates.includes(o.sampleRate)) {
    const to = nearest(f.rates, o.sampleRate);
    notes.push(`${f.label.replace(/ \(.*/, '')} supports ${f.rates.length === 1 ? `only ${f.rates[0]} Hz` : 'a limited set of sample rates'}; the audio will be converted to ${to} Hz.`);
    o.sampleRate = to;
  }
  if (f.maxRate && o.sampleRate > f.maxRate) o.sampleRate = f.maxRate;
  o.channels = Math.max(1, Math.min(f.maxChannels, Math.round(o.channels) || 1));
  if (input.channels > f.maxChannels) notes.push(`${f.label.replace(/ \(.*/, '')} stores at most ${f.maxChannels} channels; extra channels are left out.`);
  if (f.bitDepths) {
    if (!f.bitDepths.includes(o.bitDepth)) {
      const to = o.bitDepth === 32 ? Math.max(...f.bitDepths) : nearest(f.bitDepths, o.bitDepth || 16);
      if (o.bitDepth) notes.push(`${f.label.replace(/ \(.*/, '')} does not store ${o.bitDepth === 32 ? '32-bit float' : `${o.bitDepth}-bit`} audio; ${to}-bit will be used.`);
      o.bitDepth = to;
    }
  } else o.bitDepth = undefined;
  if (!['none', 'triangular', 'shaped'].includes(o.dither)) o.dither = f.defaultDither || 'triangular';
  for (const s of f.settings) {
    const opts = typeof s.options === 'function' ? s.options(o) : s.options;
    const values = opts.map((x) => x.value);
    if (!values.includes(o.settings[s.id])) o.settings[s.id] = values.includes(s.default) ? s.default : nearest(values, Number(o.settings[s.id]) || s.default);
  }
  for (const key of Object.keys(o.settings)) if (!f.settings.some((s) => s.id === key)) delete o.settings[key];
  return { options: o, notes };
}

/** Whether samples are requantized (dither applies). */
export function usesDither(options) {
  const f = getFormat(options.format);
  if (!f) return false;
  if (f.id === 'mp3') return true;
  return Boolean(f.bitDepths) && options.bitDepth < 32;
}

/** Estimated output size in bytes for `frames` source frames at `sourceRate`. */
export function estimateSize(options, frames, sourceRate = options.sampleRate) {
  const f = getFormat(options.format);
  const outFrames = Math.round((frames * options.sampleRate) / (sourceRate || options.sampleRate));
  const seconds = outFrames / options.sampleRate;
  if (!f) return 0;
  if (f.id === 'wav' || f.id === 'aiff') return 44 + outFrames * options.channels * (options.bitDepth / 8);
  if (f.id === 'flac') return Math.round(8300 + outFrames * options.channels * (options.bitDepth / 8) * 0.58);
  const kbps = options.settings?.bitrate ?? 128;
  return Math.round((seconds * kbps * 1000) / 8 * (f.id === 'mp3' ? 1 : 1.015) + 600);
}

export function formatBytesShort(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function channelLabel(n) {
  return n === 1 ? 'Mono' : n === 2 ? 'Stereo' : `${n} Channels`;
}

/** "48000 Hz Stereo, 24-bit" */
export function describeSampleType(o) {
  const depth = o.bitDepth === undefined ? '' : o.bitDepth === 32 ? ', 32-bit (float)' : `, ${o.bitDepth}-bit`;
  return `${o.sampleRate} Hz ${channelLabel(o.channels)}${depth}`;
}

/** "Level 5", "192 kbps CBR", "Uncompressed" */
export function describeSettings(o) {
  const f = getFormat(o.format);
  if (!f) return '';
  if (f.id === 'wav' || f.id === 'aiff') return o.bitDepth === 32 ? 'Uncompressed, 32-bit floating point' : 'Uncompressed, integer';
  if (f.id === 'flac') return `Lossless, level ${o.settings.level}`;
  if (f.id === 'mp3') return `${o.settings.bitrate} kbps CBR`;
  return `${o.settings.bitrate} kbps`;
}

/** Output frame count after sample-rate conversion. */
export function outputFrames(frames, from, to) {
  return from === to ? frames : Math.round((frames * to) / from);
}

/**
 * Why `frames` output frames cannot be written in this format, or ''. Only WAV and AIFF hold
 * no audio at all: an empty FLAC, MP3, Opus or AAC file is one browsers cannot decode, so it
 * would open again only as "damaged".
 */
export function emptyExportError(formatId, frames) {
  if (frames > 0 || formatId === 'wav' || formatId === 'aiff') return '';
  const ext = getFormat(formatId)?.ext || formatId;
  return `There is no audio to save, and an empty .${ext} file cannot be opened again. Choose WAV or AIFF to save an empty file.`;
}

/** Markers moved into an export range and scaled to the output rate. */
export function exportMarkers(markers, start, end, from, to) {
  const k = to / from;
  return markers
    .filter((m) => m.start >= start && m.start < end)
    .map((m) => ({ ...m, start: Math.round((m.start - start) * k), duration: Math.round(Math.min(m.duration || 0, end - m.start) * k) }));
}

/**
 * `name` without a file extension. Only a suffix with a letter counts, so the
 * version in "Mix 1.5" is kept (".wav", ".mp3" and ".m4a" are removed).
 */
export function stripExtension(name) {
  return String(name).replace(/\.(?=[0-9]*[a-z])[a-z0-9]{1,5}$/i, '');
}

/** Replaces the extension of `name` with the format's. */
export function withExtension(name, formatId) {
  const f = getFormat(formatId);
  // Trailing dots go first ("Song." is not "Song..wav"); most file systems drop them anyway.
  const base = stripExtension(String(name || 'Untitled').replace(/\.+$/, ''));
  return `${base}.${f ? f.ext : 'wav'}`;
}

/** Removes characters Puter and most file systems reject. Empty input stays empty. */
export function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
}
