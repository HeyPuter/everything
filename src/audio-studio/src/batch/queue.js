// Batch Process queue: the file list, output names and a cancellable runner.
// Pure apart from the `process` callback the caller supplies (decode, apply
// a favorite, encode, write), so the logic is testable without workers.
//
// Item: { id, name, source: { type: 'doc', doc } | { type: 'local', file } |
//         { type: 'puter', path, item } | { type: 'range', doc, start, end, name },
//         status, progress, message, output }  (range: part of an open file, from the Markers panel)
// status: 'ready' | 'waiting' | 'running' | 'done' | 'error' | 'cancelled' | 'skipped'

import { withExtension, stripExtension, sanitizeFileName, getFormat, conformOptions } from '../export/formats.js';

let nextItem = 1;

export const STATUS_LABELS = {
  ready: 'Ready',
  waiting: 'Waiting',
  running: 'Processing',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** A stable identity so the same file is not queued twice. */
export function sourceIdentity(source) {
  if (source.type === 'doc') return `doc:${source.doc.id}`;
  if (source.type === 'range') return `range:${source.doc.id}:${source.start}:${source.end}`;
  if (source.type === 'puter') return `puter:${source.path}`;
  const f = source.file;
  return `local:${f.name}:${f.size}:${f.lastModified || 0}`;
}

export function makeItem(source, name) {
  return { id: `b${nextItem++}`, name: name || (source.type === 'range' ? source.name : null) || source.doc?.name || source.file?.name || source.path?.split('/').pop() || 'Untitled', source, status: 'ready', progress: 0, message: '', output: '' };
}

/** Adds sources (skipping ones already listed). Returns { items, added }. */
export function addSources(items, sources) {
  const seen = new Set(items.map((i) => sourceIdentity(i.source)));
  const out = items.slice();
  let added = 0;
  for (const s of sources) {
    const key = sourceIdentity(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(makeItem(s));
    added++;
  }
  return { items: out, added };
}

export function removeItems(items, ids) {
  const gone = new Set(ids);
  return items.filter((i) => !gone.has(i.id));
}

/** Items back to Ready (before a new run), keeping ones still running. */
export function resetItems(items) {
  return items.map((i) => (i.status === 'running' ? i : { ...i, status: 'ready', progress: 0, message: '', output: '' }));
}

// --------------------------------------------------------- export settings

export const BATCH_DEFAULTS = {
  format: 'wav',
  sampleRate: 'source',
  channels: 'source',
  bitDepth: 24,
  dither: 'triangular',
  settings: {},
  prefix: '',
  suffix: '',
  location: 'download',
  dir: null,
  collision: 'rename',
  favorite: '',
};

/** Settings completed with defaults. */
export function batchSettings(saved) {
  return { ...BATCH_DEFAULTS, ...(saved || {}), settings: { ...(saved?.settings || {}) } };
}

/** Export options (formats.js) for one source with the batch settings. */
export function exportOptionsFor(settings, source) {
  const f = getFormat(settings.format) || getFormat('wav');
  const fmtSettings = {};
  for (const s of f.settings) fmtSettings[s.id] = settings.settings?.[s.id] ?? s.default;
  return conformOptions(f.id, {
    format: f.id,
    sampleRate: settings.sampleRate === 'source' ? source.sampleRate : Number(settings.sampleRate),
    channels: settings.channels === 'source' ? source.channels : Number(settings.channels),
    bitDepth: settings.bitDepth,
    dither: settings.dither,
    settings: fmtSettings,
    markers: true,
    meta: true,
  }).options;
}

/** Output file name: prefix + name without extension + suffix + the format's extension. */
export function outputName(name, settings) {
  const stem = stripExtension(name || 'Untitled');
  const base = sanitizeFileName(`${settings.prefix || ''}${stem}${settings.suffix || ''}`) || 'Untitled';
  return withExtension(base, settings.format);
}

/** Makes `name` unique against `taken` (a Set of lower-case names) by adding " 2", " 3"... */
export function uniqueName(name, taken) {
  const m = /^(.*?)(\.[a-z0-9]+)?$/i.exec(name);
  const stem = m[1];
  const ext = m[2] || '';
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} ${i}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** Output names for items in order, unique within the batch. */
export function plannedNames(items, settings) {
  const taken = new Set();
  return items.map((i) => uniqueName(outputName(i.name, settings), taken));
}

/** Sample type of a queued source when known without decoding: open files, and local files once probed (item.probe). */
export function sourceSampleType(item) {
  const d = item.source.doc;
  if (d) {
    const bits = d.info?.bitDepth;
    const ch = d.channelCount === 1 ? 'Mono' : d.channelCount === 2 ? 'Stereo' : `${d.channelCount} ch`;
    return [`${d.sampleRate} Hz`, bits ? (bits === 32 ? '32-bit float' : `${bits}-bit`) : '', ch].filter(Boolean).join(', ');
  }
  const p = item.probe;
  if (!p?.sampleRate) return '';
  const ch = p.channels === 1 ? 'Mono' : p.channels === 2 ? 'Stereo' : p.channels ? `${p.channels} ch` : '';
  return [`${p.sampleRate} Hz`, p.bitDepth && /WAV|AIFF|FLAC/.test(p.format || '') ? `${p.bitDepth}-bit` : '', ch].filter(Boolean).join(', ');
}

/** Short text for the settings summary. */
export function describeBatch(settings) {
  const f = getFormat(settings.format) || getFormat('wav');
  const parts = [f.label.replace(/ \(.*/, '')];
  if (f.bitDepths) parts.push(settings.bitDepth === 32 ? '32-bit float' : `${settings.bitDepth}-bit`);
  for (const s of f.settings) {
    const v = settings.settings?.[s.id] ?? s.default;
    parts.push(s.unit ? `${v} ${s.unit}` : `${s.label.toLowerCase()} ${v}`);
  }
  parts.push(settings.sampleRate === 'source' ? 'source rate' : `${settings.sampleRate} Hz`);
  if (settings.channels !== 'source') parts.push(Number(settings.channels) === 1 ? 'mono' : 'stereo');
  return parts.join(', ');
}

// ------------------------------------------------------------------ runner

/**
 * Runs `process(item, { signal, onProgress })` for each item in order.
 * `onUpdate(items)` receives a new array after every change. Cancelling the
 * signal stops the current item and marks the rest Cancelled. Resolves
 * { items, done, failed, cancelled }.
 */
export async function runQueue(items, { process, onUpdate, signal, names }) {
  let list = items.map((i, k) => ({ ...i, status: 'waiting', progress: 0, message: '', output: names?.[k] || '' }));
  const set = (id, patch) => {
    list = list.map((i) => (i.id === id ? { ...i, ...patch } : i));
    onUpdate?.(list);
  };
  onUpdate?.(list);
  for (const item of items) {
    if (signal?.aborted) break;
    set(item.id, { status: 'running', progress: 0 });
    try {
      const current = list.find((i) => i.id === item.id);
      const result = await process(current, {
        signal,
        onProgress: (f) => set(item.id, { progress: Math.max(0, Math.min(1, Number(f) || 0)) }),
      });
      if (signal?.aborted) {
        set(item.id, { status: 'cancelled', message: 'Cancelled', progress: 0 });
        break;
      }
      set(item.id, { status: result?.skipped ? 'skipped' : 'done', progress: 1, message: result?.message || '', output: result?.output || current.output });
    } catch (err) {
      const cancelled = signal?.aborted || err?.name === 'AbortError' || err?.message === 'Cancelled';
      set(item.id, { status: cancelled ? 'cancelled' : 'error', message: cancelled ? 'Cancelled' : err?.message || 'Processing failed', progress: 0 });
      if (cancelled) break;
    }
  }
  list = list.map((i) => (i.status === 'waiting' ? { ...i, status: 'cancelled', message: 'Cancelled' } : i));
  onUpdate?.(list);
  return {
    items: list,
    done: list.filter((i) => i.status === 'done').length,
    failed: list.filter((i) => i.status === 'error').length,
    cancelled: list.filter((i) => i.status === 'cancelled').length,
  };
}
