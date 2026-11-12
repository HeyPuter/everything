// Opening and saving audio: local files, drag and drop, Puter files, downloads.

import { decodeAudio, extensionOf, AUDIO_ACCEPT } from '../audio/decode.js';
import { Channel } from '../audio/channel.js';
import { AudioFile } from '../model/audio-file.js';
import { createMarker, sortMarkers } from '../model/markers.js';
import { FORMATS, conformOptions, docBitDepth } from '../export/formats.js';
import { exportAudio } from '../export/export.js';
import * as puter from './puter.js';

/**
 * Encoders by format id: wav, aiff, flac, mp3, opus, m4a. Each encode(o)
 * runs in the export worker and resolves a Blob. `o` = { sampleRate,
 * channels: Channel[] | Float32Array[], bitDepth?, markers?, meta?,
 * targetRate?, targetChannels?, dither?, settings?, onProgress?, signal? }.
 */
export const ENCODERS = new Map(
  FORMATS.map((f) => [
    f.id,
    {
      label: f.label,
      ext: f.ext,
      mime: f.mime,
      lossy: f.lossy,
      encode: (o) =>
        exportAudio(
          { channels: o.channels, sampleRate: o.sampleRate, markers: o.markers || [], meta: o.meta || {} },
          { format: f.id, sampleRate: o.targetRate ?? o.sampleRate, channels: o.targetChannels ?? o.channels.length, bitDepth: o.bitDepth ?? 24, dither: o.dither ?? 'triangular', settings: o.settings || {}, markers: true, meta: true },
          { onProgress: o.onProgress, signal: o.signal },
        ),
    },
  ]),
);

/**
 * Openers for non-audio documents by file extension (e.g. multitrack
 * sessions): (app, blob, name, source, context) => doc. context.items lists
 * every item being opened; add items to context.consumed to skip them.
 */
export const OPENERS = new Map();
/**
 * Called for every audio document opened from a file (not through an opener):
 * async (app, doc, blob, name, source) => void, e.g. to keep a video's picture.
 */
export const OPEN_HOOKS = [];
/** Extra entries for the open pickers' accept lists (e.g. '.asesx'). */
export const EXTRA_ACCEPT = [];
export const openAccept = () => [AUDIO_ACCEPT, ...EXTRA_ACCEPT].join(',');

/** Shows the browser file picker. Resolves File[] (empty when cancelled). */
export function pickLocalFiles({ accept = openAccept(), multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let settled = false;
    const done = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** WAV chunks to keep on a later save (iXML...) and the file's sample type, as info.wavChunks. */
function wavChunksInfo(r) {
  if (!r.chunks?.length) return {};
  const frames = r.channels[0]?.length ?? 0;
  const channels = r.channels.length;
  return { wavChunks: { sampleRate: r.sampleRate, channels, frames, list: r.chunks } };
}

/** Decodes a Blob/File into a new AudioFile document. */
export async function audioFileFromBlob(blob, name, source = { type: 'local' }) {
  const buffer = await blob.arrayBuffer();
  const r = await decodeAudio(buffer, name);
  const doc = new AudioFile({
    name,
    sampleRate: r.sampleRate,
    channels: r.channels.map((c) => Channel.fromSamples(c)),
    markers: sortMarkers((r.markers || []).map((m, i) => createMarker({ ...m, name: m.name || `Marker ${String(i + 1).padStart(2, '0')}` }))),
    meta: r.meta || {},
    info: { bitDepth: r.bitDepth, format: r.format, size: blob.size, ...wavChunksInfo(r) },
    source,
  });
  return doc;
}

/** Opens files (File objects or Puter FSItems) as documents. Returns the docs opened. */
export async function openFiles(app, items, { activate = true } = {}) {
  const docs = [];
  const context = { items, consumed: new Set() };
  // Documents with openers (sessions) first, so they can claim their media.
  const ordered = [...items].sort((a, b) => Number(OPENERS.has(extensionOf(b.name || ''))) - Number(OPENERS.has(extensionOf(a.name || ''))));
  for (const item of ordered) {
    if (context.consumed.has(item)) continue;
    const t0 = performance.now();
    const name = item.name || 'Untitled';
    try {
      app.setStatus(`Opening ${name}...`);
      if (puter.isDir(item)) {
        app.notify(`"${name}" is a folder. Open audio files from it in the Media Browser.`);
        continue;
      }
      let blob = item;
      let source = { type: 'local' };
      // A Puter file that is already open is shown, not opened a second time: two copies
      // of one file would each save over the other's changes.
      const isOpen = (d) => d.source?.type === 'puter' && d.source.path === item.path;
      const already = !(item instanceof Blob) && item.path && app.documents?.find(isOpen);
      if (already) {
        docs.push(already);
        app.setStatus(`${name} is already open`);
        continue;
      }
      if (!(item instanceof Blob) && (typeof item.read === 'function' || item.path)) {
        // Puter FSItems (file pickers, "Open with", Media Browser) read through the SDK.
        blob = typeof item.read === 'function' ? await item.read() : await puter.readFile(item.path);
        source = { type: 'puter', path: item.path, uid: item.uid };
      }
      const opener = OPENERS.get(extensionOf(name));
      const doc = opener ? await opener(app, blob, name, source, context) : await audioFileFromBlob(blob, name, source);
      if (!opener) for (const hook of OPEN_HOOKS) await hook(app, doc, blob, name, source);
      app.addDocument(doc, { activate: activate && !docs.length });
      docs.push(doc);
      app.setStatus(`Opened in ${((performance.now() - t0) / 1000).toFixed(2)} seconds`);
      if (source.type === 'puter') rememberRecent(app, { name, path: item.path });
    } catch (err) {
      console.error(err);
      // With several files opening, say which one failed when the message does not.
      const message = String(err?.message || '');
      app.notify(message.includes(name) ? message : `"${name}" could not be opened.${message ? ` ${message}` : ''}`, { error: true });
      app.setStatus(`Could not open ${name}`);
    }
  }
  if (docs.length && activate) app.activate(docs[0]);
  return docs;
}

export function rememberRecent(app, entry) {
  const list = (app.prefs.get('recent') || []).filter((r) => r.path !== entry.path);
  list.unshift({ ...entry, time: Date.now() });
  app.prefs.set('recent', list.slice(0, 12));
}

/**
 * Encodes an audio document (or a range of it) to a Blob in `format`, in the
 * export worker. `options` may carry any export option (formats.js).
 */
export async function encodeDocument(doc, { format = 'wav', bitDepth, start = 0, end = doc.length, options = {}, onProgress, signal } = {}) {
  const opts = conformOptions(format, {
    format,
    sampleRate: doc.sampleRate,
    channels: doc.channelCount,
    bitDepth: bitDepth ?? docBitDepth(doc),
    dither: 'triangular',
    settings: {},
    ...options,
  }).options;
  return exportAudio({ channels: doc.state.channels, sampleRate: doc.sampleRate, start, end, markers: doc.state.markers, meta: doc.state.meta || {} }, opts, { onProgress, signal });
}

export { saveDocument } from '../export/save.js';

export async function openFromPuter(app) {
  if (!puter.sdk()) return openFiles(app, await pickLocalFiles());
  if (!puter.isSignedIn()) {
    const ok = await puter.signIn().catch(() => false);
    if (!ok) return [];
  }
  const items = await puter.pickFiles({ multiple: true, accept: openAccept() });
  return openFiles(app, items);
}

export { AUDIO_ACCEPT };
