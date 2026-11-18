// Saving and opening multitrack sessions. On Puter a session is a .asesx JSON
// file plus a "<Name>_Media" folder of WAV files next to it. Without Puter
// (or for a local copy) the session and its media download as one ZIP, which
// File > Open accepts again.

import { Session } from '../model/session.js';
import { serializeSession, parseSession, sessionBaseName, SESSION_EXT } from '../model/session-io.js';
import { encodeWav, wavHeader } from '../audio/wav.js';
import { audioFileFromBlob, downloadBlob, rememberRecent, OPENERS, EXTRA_ACCEPT } from '../storage/files.js';
import { channelsAtRate } from './insert.js';
import { zipStore, unzipStore } from '../lib/zip.js';
import * as puter from '../storage/puter.js';
import { saveSessionVideo, videoZipEntry, loadSessionVideo } from '../video/session-media.js';
import { sessionSaveDialog } from './save-dialog.js';

const dirOf = (path) => path.slice(0, path.lastIndexOf('/'));
const withExt = (name) => (/\.asesx$/i.test(name) ? name : `${sessionBaseName(name)}.${SESSION_EXT}`);

// Per session destination, source id -> the immutable media revision uploaded there.
// Keep old files intact: a failed save must not change audio used by its previous manifest.
const savedMedia = new WeakMap();
const savedMediaOf = (session, path) => {
  if (!savedMedia.has(session)) savedMedia.set(session, new Map());
  const destinations = savedMedia.get(session);
  if (!destinations.has(path)) destinations.set(path, new Map());
  return destinations.get(path);
};

const cloudSaves = new WeakMap();

function mediaRevision(file) {
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('');
  return file.replace(/(\.[^/.]+)$/, `-${id}$1`);
}

function mediaBlob(m) {
  return encodeWav({ sampleRate: m.sampleRate, channels: m.channels, bitDepth: 32, float: true });
}

/**
 * Saves a session: to its Puter path, or after asking where (Save As / first
 * save). Without Puter it downloads a ZIP. Returns true when saved.
 */
export function saveSession(app, doc, options = {}) {
  if (!puter.sdk() || !puter.isSignedIn()) return saveSessionNow(app, doc, options);
  // Finish one save before the next updates its manifest or cached revisions.
  const previous = cloudSaves.get(doc) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => saveSessionNow(app, doc, options));
  cloudSaves.set(doc, pending);
  return pending.finally(() => {
    if (cloudSaves.get(doc) === pending) cloudSaves.delete(doc);
  });
}

async function saveSessionNow(app, doc, { saveAs = false, copy = false } = {}) {
  // Stretched and remixed clips save their finished audio, not the preview.
  if (doc.stretcher?.busy) await doc.stretcher.whenIdle();
  if (doc.remixer?.busy) await doc.remixer.whenIdle();
  if (puter.sdk() && puter.isSignedIn()) {
    let path = !saveAs && !copy && doc.source?.type === 'puter' && /\.asesx$/i.test(doc.source.path || '') ? doc.source.path : null;
    let name = withExt(doc.name);
    if (!path) {
      const item = await sessionSaveDialog(app, doc, { copy });
      if (!item) return false;
      path = item.path;
      name = item.name;
    }
    const dir = dirOf(path);
    // What the file holds: edits made while the media uploads stay unsaved.
    const saved = doc.state;
    const onDisk = savedMediaOf(doc, path);
    const { text, media, video } = serializeSession(doc, {
      name,
      mediaPath: (id, src, file) => {
        const prior = onDisk.get(id);
        if (prior && prior.channels === src.channels && prior.sampleRate === saved.sampleRate) return prior.file;
        return src.channels?.length ? mediaRevision(file) : file;
      },
      // A replacement may have the same name as a video still used by Undo or
      // the saved manifest. Existing Puter paths remain references, not uploads.
      videoPath: (_id, src, file) => src.blob ? mediaRevision(file) : file,
    });
    await saveSessionVideo(app, doc, video, dir, { copy });
    let written = 0;
    for (const m of media) {
      const target = `${dir}/${m.file}`;
      if (!m.channels?.length) continue;
      if (onDisk.get(m.id)?.file === m.file) continue;
      app.setStatus(`Saving media ${++written}...`);
      await puter.writeFile(target, mediaBlob(m));
      // A completed upload is reusable even if the following manifest write fails.
      onDisk.set(m.id, m);
    }
    await puter.writeFile(path, new Blob([text], { type: 'application/json' }));
    if (!copy) {
      doc.source = { type: 'puter', path };
      if (doc.name !== name) doc.rename(name);
      doc.markSaved(saved);
      rememberRecent(app, { name, path });
    }
    app.setStatus(`Saved ${name}`);
    return true;
  }
  const { blob, fileName, state } = await prepareSessionZip(doc);
  downloadBlob(blob, fileName);
  if (!copy) doc.markSaved(state);
  app.setStatus(`Downloaded ${fileName}`);
  return true;
}

/** The session file and its media as one stored ZIP. */
export function sessionZip(doc, { videoBytes } = {}) {
  return packSessionZip(sessionZipData(doc), videoBytes);
}

function sessionZipData(doc) {
  const name = withExt(doc.name);
  return { name, state: doc.state, ...serializeSession(doc, { name, embedVideo: true }) };
}

/** Captures one session version, reads its video, and returns its ZIP and saved state. */
export async function prepareSessionZip(doc) {
  const data = sessionZipData(doc);
  const videoBytes = new WeakMap();
  const videoBlob = data.video?.blob;
  if (videoBlob) videoBytes.set(videoBlob, new Uint8Array(await videoBlob.arrayBuffer()));
  return { blob: packSessionZip(data, videoBytes), fileName: `${sessionBaseName(data.name)}.zip`, state: data.state };
}

function packSessionZip({ name, text, media, video }, videoBytes) {
  const files = [{ name, data: new TextEncoder().encode(text) }];
  // Media descriptors hold the same audio and rate used by the manifest.
  for (const m of media) {
    if (!m.channels?.length) continue;
    files.push({ name: m.file, data: wavBytes(m.sampleRate, m.channels) });
  }
  const v = videoZipEntry(video, videoBytes);
  if (v) files.push(v);
  return zipStore(files);
}

/** 32-bit float WAV bytes for Channels (synchronous). */
export function wavBytes(rate, channels) {
  const nch = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * nch * 4;
  const head = new Uint8Array(
    wavHeader({ sampleRate: rate, channels: nch, bitDepth: 32, float: true, frames }),
  );
  const out = new Uint8Array(head.length + dataSize);
  const dv = new DataView(out.buffer);
  out.set(head);
  const CH = 65536;
  const tmp = Array.from({ length: nch }, () => new Float32Array(CH));
  let p = head.length;
  for (let at = 0; at < frames; at += CH) {
    const n = Math.min(CH, frames - at);
    for (let c = 0; c < nch; c++) channels[c].read(at, tmp[c], 0, n);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        dv.setFloat32(p, tmp[c][i], true);
        p += 4;
      }
    }
  }
  return out;
}

/** Saves a copy of the session (and its media) to Puter, or downloads it. */
export function exportSession(app, doc) {
  return saveSession(app, doc, { copy: true, saveAs: true });
}

/**
 * Builds a Session from .asesx text, loading each source with `loadMedia(source)`
 * (resolves a Blob or null). Media open as audio documents in the Files panel.
 */
export async function sessionFromText(app, text, name, source, loadMedia) {
  const parsed = parseSession(text);
  const session = new Session({ name, state: parsed.state, source });
  if (parsed.view) session.setView(parsed.view.start, parsed.view.end, { silent: true });
  const missing = [];
  for (const src of parsed.sources) {
    const fileName = src.file.split('/').pop();
    let blob = null;
    try {
      blob = await loadMedia(src, fileName);
    } catch {
      blob = null;
    }
    if (!blob) {
      session.addSource({ id: src.id, name: src.name, channels: [], offline: true });
      missing.push(src.name);
      continue;
    }
    try {
      const mediaSource = source.type === 'puter' ? { type: 'puter', path: `${dirOf(source.path)}/${src.file}` } : { type: 'local' };
      const doc = await audioFileFromBlob(blob, src.name || fileName, mediaSource);
      app.addDocument(doc, { activate: false });
      const channels = await channelsAtRate(doc.state.channels, doc.sampleRate, session.sampleRate);
      session.addSource({ id: src.id, name: doc.name, channels, sampleRate: doc.sampleRate, docId: doc.id, path: mediaSource.path || null });
      session.pool.get(src.id).stateRef = doc.state;
      if (mediaSource.path) savedMediaOf(session, source.path).set(src.id, { file: src.file, channels, sampleRate: doc.sampleRate });
    } catch {
      session.addSource({ id: src.id, name: src.name, channels: [], offline: true });
      missing.push(src.name);
    }
  }
  if (parsed.video && !(await loadSessionVideo(session, parsed.video, { source, loadMedia }))) missing.push(parsed.video.name || 'Video');
  if (missing.length) app.notify(`${missing.length} media file${missing.length > 1 ? 's' : ''} could not be found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '...' : ''}. Those clips are offline.`, { error: true });
  return session;
}

async function openSessionFile(app, blob, name, source, context) {
  const text = await blob.text();
  return sessionFromText(app, text, name, source, async (src, fileName) => {
    if (source.type === 'puter' && source.path) return puter.readFile(`${dirOf(source.path)}/${src.file}`);
    // Local: media picked together with the session, matched by file name.
    const item = context.items.find((it) => it.name === fileName);
    if (item) {
      context.consumed.add(item);
      return item;
    }
    return null;
  });
}

async function openSessionZip(app, blob, name, source, context) {
  const files = unzipStore(await blob.arrayBuffer());
  const entry = [...files.keys()].find((k) => /\.asesx$/i.test(k) && !k.includes('/'));
  if (!entry) {
    // Not one of ours: let the caller report it like any undecodable file.
    throw new Error(`"${name}" is not an Audio Studio session archive.`);
  }
  const text = new TextDecoder().decode(files.get(entry));
  return sessionFromText(app, text, entry, { type: 'local' }, async (src) => {
    const bytes = files.get(src.file);
    return bytes ? new Blob([bytes], { type: 'audio/wav' }) : null;
  });
}

export function installSessionStorage() {
  OPENERS.set(SESSION_EXT, openSessionFile);
  OPENERS.set('zip', openSessionZip);
  if (!EXTRA_ACCEPT.includes('.asesx')) EXTRA_ACCEPT.push('.asesx', '.zip');
}
