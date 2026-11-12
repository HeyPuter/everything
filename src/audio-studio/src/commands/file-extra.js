// File menu extras: Close Unused Media, Close Session and its Media, Save All
// Audio as Batch Process, Import > Raw Data and Export > Audio within Range
// Markers.

import { h } from '../lib/dom.js';
import { AudioFile } from '../model/audio-file.js';
import { Channel } from '../audio/channel.js';
import { baseName } from '../audio/decode.js';
import { openDialog } from '../ui/dialog.js';
import { pickLocalFiles, openFiles } from '../storage/files.js';
import { FORMATS, getFormat, sanitizeFileName, withExtension } from '../export/formats.js';
import { exportAudio } from '../export/export.js';
import { withProgress } from '../export/progress.js';
import { exportOptionsFor, batchSettings, uniqueName } from '../batch/queue.js';
import { outputWriter } from '../batch/export-settings.js';
import * as puter from '../storage/puter.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);

// ------------------------------------------------------------- media usage

/** Ids of audio documents that a session uses through its media pool. */
function linkedDocIds(session) {
  const used = new Set();
  const sources = new Set(session.state.clips.map((c) => c.sourceId));
  for (const src of session.pool?.values?.() || []) if (src.docId && sources.has(src.id)) used.add(src.docId);
  return used;
}

/** Audio documents no open session uses. */
export function unusedAudioDocs(documents) {
  const used = new Set();
  for (const d of documents) if (d.kind === 'session') for (const id of linkedDocIds(d)) used.add(id);
  return documents.filter((d) => d.kind === 'audio' && !used.has(d.id));
}

/** Audio documents used by `session` and by no other open session. */
export function sessionOnlyMedia(documents, session) {
  const mine = linkedDocIds(session);
  for (const d of documents) if (d.kind === 'session' && d !== session) for (const id of linkedDocIds(d)) mine.delete(id);
  return documents.filter((d) => d.kind === 'audio' && mine.has(d.id));
}

async function closeAll(app, docs) {
  for (const d of docs) if (!(await app.closeDocument(d))) return false;
  return true;
}

// ---------------------------------------------------------------- raw data

export const RAW_ENCODINGS = [
  { id: 'u8', label: '8-bit unsigned integer', bytes: 1 },
  { id: 's8', label: '8-bit signed integer', bytes: 1 },
  { id: 's16', label: '16-bit integer', bytes: 2 },
  { id: 's24', label: '24-bit integer', bytes: 3 },
  { id: 's32', label: '32-bit integer', bytes: 4 },
  { id: 'f32', label: '32-bit float', bytes: 4 },
  { id: 'f64', label: '64-bit float', bytes: 8 },
  { id: 'ulaw', label: 'μ-law (8-bit)', bytes: 1 },
  { id: 'alaw', label: 'A-law (8-bit)', bytes: 1 },
];

function ulaw(b) {
  b = ~b & 0xff;
  const sign = b & 0x80;
  const exp = (b >> 4) & 7;
  const mant = b & 0x0f;
  const v = (((mant << 3) + 0x84) << exp) - 0x84;
  return (sign ? -v : v) / 32768;
}

function alaw(b) {
  b ^= 0x55;
  const sign = b & 0x80;
  const exp = (b >> 4) & 7;
  const mant = b & 0x0f;
  const v = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1);
  return (sign ? v : -v) / 32768;
}

/**
 * Decodes headerless interleaved samples. Returns one Float32Array per
 * channel; a trailing partial frame is dropped.
 * @param {Uint8Array} bytes
 * @param {{ encoding: string, channels: number, bigEndian?: boolean, offset?: number }} o
 */
export function decodeRaw(bytes, { encoding, channels, bigEndian = false, offset = 0 }) {
  const enc = RAW_ENCODINGS.find((e) => e.id === encoding);
  if (!enc) throw new Error(`Unknown sample type ${encoding}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = !bigEndian;
  const frameBytes = enc.bytes * channels;
  const frames = Math.max(0, Math.floor((bytes.byteLength - offset) / frameBytes));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const read = {
    u8: (p) => (view.getUint8(p) - 128) / 128,
    s8: (p) => view.getInt8(p) / 128,
    s16: (p) => view.getInt16(p, le) / 32768,
    s24: (p) => {
      const [a, b, c] = le ? [view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2)] : [view.getUint8(p + 2), view.getUint8(p + 1), view.getUint8(p)];
      return (((c << 24) | (b << 16) | (a << 8)) >> 8) / 8388608;
    },
    s32: (p) => view.getInt32(p, le) / 2147483648,
    f32: (p) => view.getFloat32(p, le),
    f64: (p) => view.getFloat64(p, le),
    ulaw: (p) => ulaw(view.getUint8(p)),
    alaw: (p) => alaw(view.getUint8(p)),
  }[enc.id];
  for (let i = 0, p = offset; i < frames; i++) {
    for (let c = 0; c < channels; c++, p += enc.bytes) out[c][i] = read(p);
  }
  return out;
}

async function importRawDialog(app) {
  const [file] = await pickLocalFiles({ accept: '*/*', multiple: false });
  if (!file) return;
  // The last settings used come back (raw files usually arrive in batches of one kind).
  const last = { rate: 44100, channels: 2, encoding: 's16', order: 'le', offset: 0, ...(app.prefs.get('importRaw') || {}) };
  const rate = h('select.select', { 'aria-label': 'Sample rate' }, [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000].map((r) => h('option', { value: r, selected: r === last.rate }, `${r} Hz`)));
  const channels = h('input.input.num', { type: 'number', min: 1, max: 8, value: last.channels, 'aria-label': 'Channels' });
  const enc = h('select.select', { 'aria-label': 'Sample type' }, RAW_ENCODINGS.map((e) => h('option', { value: e.id, selected: e.id === last.encoding }, e.label)));
  const order = h('select.select', { 'aria-label': 'Byte order' }, h('option', { value: 'le' }, 'Little-endian'), h('option', { value: 'be' }, 'Big-endian'));
  order.value = last.order === 'be' ? 'be' : 'le';
  const offset = h('input.input.num', { type: 'number', min: 0, value: last.offset, 'aria-label': 'Start byte offset' });
  const info = h('p.faint', { style: { margin: '8px 0 0' } });
  const update = () => {
    const e = RAW_ENCODINGS.find((x) => x.id === enc.value);
    order.disabled = e.bytes === 1;
    const frames = Math.max(0, Math.floor((file.size - Number(offset.value || 0)) / (e.bytes * Math.max(1, Number(channels.value) || 1))));
    info.textContent = `${file.name}: ${file.size.toLocaleString()} bytes, about ${app.formatTime(frames, Number(rate.value))} of audio.`;
  };
  for (const el of [rate, channels, enc, offset]) el.addEventListener('input', update);
  update();
  const r = await openDialog({
    title: 'Import Raw Data',
    body: h(
      'div',
      h('div.form-grid', h('label', 'Sample Rate:'), rate, h('label', 'Channels:'), channels, h('label', 'Sample Type:'), enc, h('label', 'Byte Order:'), order, h('label', 'Start Byte Offset:'), offset),
      info,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Import', value: 'ok', primary: true },
    ],
  });
  if (r !== 'ok') return;
  const ch = Math.max(1, Math.min(8, Math.round(Number(channels.value) || 1)));
  app.prefs.set('importRaw', { rate: Number(rate.value), channels: ch, encoding: enc.value, order: order.value, offset: Math.max(0, Math.round(Number(offset.value) || 0)) });
  const data = decodeRaw(new Uint8Array(await file.arrayBuffer()), { encoding: enc.value, channels: ch, bigEndian: order.value === 'be', offset: Math.max(0, Math.round(Number(offset.value) || 0)) });
  if (!data[0].length) return app.notify('The file has no complete sample frames with those settings.', { error: true });
  const bits = { u8: 8, s8: 8, ulaw: 16, alaw: 16, s16: 16, s24: 24 }[enc.value] || 32;
  const doc = new AudioFile({ name: app.uniqueName(`${baseName(file.name)}.wav`), sampleRate: Number(rate.value), channels: data.map((d) => Channel.fromSamples(d)), info: { bitDepth: bits, format: 'wav' }, source: { type: 'local' } });
  app.addDocument(doc);
}

// ------------------------------------------------- export range markers

/** File names for exported range markers: the marker name, or prefix + number. */
export function rangeExportNames(markers, { naming, prefix, format }) {
  const taken = new Set();
  return markers.map((m, i) => {
    const stem = naming === 'prefix' ? `${prefix || 'Region'} ${String(i + 1).padStart(2, '0')}` : m.name || `Range ${i + 1}`;
    return uniqueName(withExtension(sanitizeFileName(stem) || `Range ${i + 1}`, format), taken);
  });
}

async function exportRangesDialog(app) {
  const doc = audio(app);
  const ranges = doc.state.markers.filter((m) => m.duration > 0);
  const preselected = new Set(app.selectedMarkerIds?.() || []);
  const useSelected = ranges.some((m) => preselected.has(m.id));
  const checks = ranges.map((m) => h('input', { type: 'checkbox', checked: !useSelected || preselected.has(m.id), 'aria-label': m.name || 'Range marker' }));
  const list = h(
    'div.range-export-list',
    ranges.map((m, i) => h('label.check', checks[i], h('span', m.name || `Range ${i + 1}`), h('span.faint', ` ${app.formatTime(m.start, doc.sampleRate)} – ${app.formatTime(m.start + m.duration, doc.sampleRate)}`))),
  );
  const saved = batchSettings(app.prefs.get('batchExport'));
  const fmt = h('select.select', { 'aria-label': 'Format' }, FORMATS.map((f) => h('option', { value: f.id, selected: f.id === saved.format }, f.label)));
  const naming = h('select.select', { 'aria-label': 'File names' }, h('option', { value: 'name' }, 'Marker names'), h('option', { value: 'prefix' }, 'Prefix and number'));
  const prefix = h('input.input', { type: 'text', value: baseName(doc.name), 'aria-label': 'Name prefix', disabled: true });
  naming.addEventListener('change', () => (prefix.disabled = naming.value !== 'prefix'));
  const sdk = Boolean(puter.sdk());
  const loc = h('select.select', { 'aria-label': 'Location' }, h('option', { value: 'puter', disabled: !sdk }, sdk ? `Puter folder (~/${puter.APP_DIR})` : 'Puter folder (not available)'), h('option', { value: 'download', selected: !sdk || saved.location !== 'puter' }, 'Download (ZIP for several files)'));
  const r = await openDialog({
    title: 'Export Audio within Range Markers',
    body: h(
      'div',
      h('p.muted', { style: { margin: '0 0 8px' } }, 'Each checked range is saved as its own file.'),
      list,
      h('div.form-grid', { style: { marginTop: '10px' } }, h('label', 'Format:'), fmt, h('label', 'File Names:'), naming, h('label', 'Prefix:'), prefix, h('label', 'Location:'), loc),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Export', value: 'ok', primary: true },
    ],
    onSubmit: () => {
      if (checks.some((c) => c.checked)) return true;
      app.notify('Check at least one range.', { error: true });
      return false;
    },
  });
  if (r !== 'ok') return;
  const chosen = ranges.filter((_, i) => checks[i].checked);
  const settings = { ...saved, format: getFormat(fmt.value).id };
  const options = exportOptionsFor(settings, { sampleRate: doc.sampleRate, channels: doc.channelCount });
  const names = rangeExportNames(chosen, { naming: naming.value, prefix: prefix.value, format: settings.format });
  // The Batch Process writer: files already in the Puter folder are kept (or replaced) as its
  // "If a file exists" setting says, and downloads too big for one ZIP arrive separately.
  const out = await outputWriter(app, { ...settings, location: loc.value });
  if (!out) return;
  const dir = out.dir;
  const done = await withProgress(`Exporting ${chosen.length} range${chosen.length === 1 ? '' : 's'}`, async (onProgress, signal) => {
    for (let i = 0; i < chosen.length; i++) {
      const m = chosen[i];
      const blob = await exportAudio(
        { channels: doc.state.channels, sampleRate: doc.sampleRate, start: m.start, end: m.start + m.duration, markers: [], meta: doc.state.meta || {} },
        options,
        { signal, onProgress: (f) => onProgress((i + f) / chosen.length) },
      );
      await out.write(names[i], blob);
    }
    return true;
  });
  if (!done) return app.setStatus('Cancelled');
  await out.finish(`${baseName(doc.name)} Ranges.zip`);
  app.setStatus(dir ? `Exported ${chosen.length} files to ${dir}` : `Exported ${chosen.length} file${chosen.length === 1 ? '' : 's'}`);
}

// ------------------------------------------------------------ registration

export function installFileExtraCommands(app) {
  app.commands.register([
    {
      id: 'file.closeUnused',
      label: 'Close Unused Media',
      enabled: (a) => unusedAudioDocs(a.documents).length > 0 && a.documents.some((d) => d.kind === 'session'),
      run: () => closeAll(app, unusedAudioDocs(app.documents)),
    },
    {
      id: 'file.closeSessionMedia',
      label: 'Close Session and its Media',
      enabled: (a) => a.active?.kind === 'session',
      run: async () => {
        const session = app.active;
        const media = sessionOnlyMedia(app.documents, session);
        if (await app.closeDocument(session)) await closeAll(app, media);
      },
    },
    {
      id: 'file.saveAllBatch',
      label: 'Save All Audio as Batch Process...',
      enabled: (a) => a.documents.some((d) => d.kind === 'audio') && a.panels.has('batch'),
      run: () => {
        app.dock.openPanel('batch');
        app.dock.instance('batch')?.api?.add(app.documents.filter((d) => d.kind === 'audio').map((doc) => ({ type: 'doc', doc })));
      },
    },
    { id: 'file.importRaw', label: 'Raw Data...', run: () => importRawDialog(app) },
    {
      id: 'file.revealInMedia',
      label: 'Reveal in Media Browser',
      enabled: (a) => a.active?.source?.type === 'puter' && Boolean(a.active.source.path) && a.panels.has('media'),
      run: async () => {
        app.dock.openPanel('media');
        await app.dock.instance('media')?.reveal?.(app.active.source.path);
      },
    },
    {
      id: 'edit.editOriginal',
      label: 'Edit Original',
      enabled: (a) => Boolean(audio(a)?.origin),
      run: async () => {
        const o = audio(app).origin;
        const open = app.documents.find((d) => d.kind === 'session' && (d.id === o.sessionId || (o.path && d.source?.path === o.path)));
        if (open) return app.activate(open);
        if (!o.path) return app.notify(`The session "${o.name}" is no longer open.`, { error: true });
        try {
          await openFiles(app, [Object.assign(await puter.readFile(o.path), { name: o.name })]).then((docs) => docs[0] && (docs[0].source = { type: 'puter', path: o.path }));
        } catch {
          app.notify(`"${o.name}" could not be opened. It may have been moved or deleted.`, { error: true });
        }
      },
    },
    {
      id: 'file.exportRanges',
      label: 'Audio within Range Markers...',
      enabled: (a) => Boolean(audio(a)?.state.markers.some((m) => m.duration > 0)),
      run: () => exportRangesDialog(app),
    },
  ]);
}
