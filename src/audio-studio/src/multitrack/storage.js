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
import { saveSessionVideo, prepareVideoBytes, videoZipEntry, loadSessionVideo } from '../video/session-media.js';

const dirOf = (path) => path.slice(0, path.lastIndexOf('/'));
const withExt = (name) => (/\.asesx$/i.test(name) ? name : `${sessionBaseName(name)}.${SESSION_EXT}`);

// What each media file a session saved to Puter holds: path -> the channels written there. Media
// names follow the sources in use, so a file can come to hold another source's audio (a source that
// stops being used gives its name to the next one); a source is skipped only while its file still
// holds its audio.
const savedMedia = new WeakMap();
const savedMediaOf = (session) => {
  if (!savedMedia.has(session)) savedMedia.set(session, new Map());
  return savedMedia.get(session);
};

function mediaBlob(session, m) {
  return encodeWav({ sampleRate: session.sampleRate, channels: m.channels, bitDepth: 32, float: true });
}

/**
 * Saves a session: to its Puter path, or after asking where (Save As / first
 * save). Without Puter it downloads a ZIP. Returns true when saved.
 */
export async function saveSession(app, doc, { saveAs = false, copy = false } = {}) {
  // Stretched and remixed clips save their finished audio, not the preview.
  if (doc.stretcher?.busy) await doc.stretcher.whenIdle();
  if (doc.remixer?.busy) await doc.remixer.whenIdle();
  if (puter.sdk() && puter.isSignedIn()) {
    let path = !saveAs && !copy && doc.source?.type === 'puter' && /\.asesx$/i.test(doc.source.path || '') ? doc.source.path : null;
    let name = withExt(doc.name);
    if (!path) {
      const draft = serializeSession(doc, { name });
      const item = await puter.pickSave(new Blob([draft.text], { type: 'application/json' }), name);
      if (!item) return false;
      path = item.path;
      name = item.name;
    }
    const dir = dirOf(path);
    // What the file holds: edits made while the media uploads stay unsaved.
    const saved = doc.state;
    const { text, media, video } = serializeSession(doc, { name });
    await saveSessionVideo(app, doc, video, dir, { copy });
    const onDisk = savedMediaOf(doc);
    let written = 0;
    for (const m of media) {
      const src = doc.pool.get(m.id);
      const target = `${dir}/${m.file}`;
      if (!src?.channels?.length) continue;
      if (onDisk.get(target) === m.channels) continue;
      app.setStatus(`Saving media ${++written}...`);
      // Unknown while it uploads (a failed write may leave it partly written).
      onDisk.delete(target);
      await puter.writeFile(target, mediaBlob(doc, m));
      // The audio written (the source may change during the upload: then the next save writes it again).
      if (!copy) onDisk.set(target, m.channels);
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
  await prepareVideoBytes(doc);
  const blob = sessionZip(doc);
  const fileName = `${sessionBaseName(doc.name)}.zip`;
  downloadBlob(blob, fileName);
  if (!copy) doc.markSaved();
  app.setStatus(`Downloaded ${fileName}`);
  return true;
}

/** The session file and its media as one stored ZIP. */
export function sessionZip(doc) {
  const name = withExt(doc.name);
  const { text, media, video } = serializeSession(doc, { name, embedVideo: true });
  const files = [{ name, data: new TextEncoder().encode(text) }];
  // ZIP entries need bytes, so media are encoded synchronously here (the video is read ahead by prepareVideoBytes).
  for (const m of media) {
    if (!m.channels?.length) continue;
    files.push({ name: m.file, data: wavBytes(doc.sampleRate, m.channels) });
  }
  const v = videoZipEntry(video);
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
      if (mediaSource.path) savedMediaOf(session).set(mediaSource.path, channels);
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
