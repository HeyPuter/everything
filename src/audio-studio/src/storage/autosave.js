// Autosave and crash recovery. Unsaved audio documents are written to the
// origin private file system (OPFS, never puter.kv) as 32-bit float WAV plus
// a small JSON manifest, periodically and when the page is hidden. On start
// the app offers to recover files left by a session that is no longer
// running (each running tab holds a Web Lock named after its session).
// Entries are removed when a document is saved, reverted or closed, and the
// total size is capped.

export const DIR_NAME = 'audio-studio-autosave';
export const LOCK_PREFIX = 'audio-studio-session-';
const VERSION = 1;
const BLOCK = 1 << 16;

export function newSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Manifest describing one autosaved document. Pure. */
export function buildManifest(doc, { session, key, now = Date.now() }) {
  return {
    version: VERSION,
    key,
    session,
    docId: doc.id,
    name: doc.name,
    sampleRate: doc.sampleRate,
    channels: doc.channelCount,
    frames: doc.length,
    bitDepth: doc.info?.bitDepth ?? 32,
    format: doc.info?.format || 'wav',
    exportOptions: doc.info?.exportOptions || null,
    wavChunks: packChunks(doc.info?.wavChunks),
    source: doc.source?.type === 'puter' ? { type: 'puter', path: doc.source.path, uid: doc.source.uid } : { type: doc.source?.type || 'new' },
    markers: doc.state.markers.map(({ id, ...m }) => m),
    meta: doc.state.meta || {},
    savedAt: now,
    bytes: 44 + doc.length * doc.channelCount * 4,
  };
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

/** doc.info.wavChunks (iXML... kept for the next WAV save) as JSON, and back. */
export function packChunks(c) {
  if (!c?.list?.length) return null;
  return { ...c, list: c.list.map(({ id, bytes }) => ({ id, data: toBase64(bytes) })) };
}

export function unpackChunks(c) {
  if (!c?.list?.length) return undefined;
  const bytesOf = (data) => Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  return { ...c, list: c.list.map(({ id, data }) => ({ id, bytes: bytesOf(data) })) };
}

/** Whether a manifest is well formed (recovery skips anything else). */
export function validManifest(m) {
  return Boolean(m && m.version === VERSION && typeof m.key === 'string' && /^[a-z0-9-]+$/i.test(m.key) && m.sampleRate > 0 && m.channels > 0 && Number.isFinite(m.frames));
}

/**
 * Which documents to write this round: dirty audio documents whose state
 * changed since their last autosave, smallest first, within `maxBytes`
 * (documents that do not fit are skipped). Pure.
 */
export function planAutosave(docs, written, maxBytes) {
  const candidates = docs
    .filter((d) => d.kind === 'audio' && d.dirty && written.get(d.id) !== d.state)
    .map((d) => ({ doc: d, bytes: 44 + d.length * d.channelCount * 4 }))
    .sort((a, b) => a.bytes - b.bytes);
  const out = [];
  let total = 0;
  for (const c of candidates) {
    if (total + c.bytes > maxBytes) continue;
    total += c.bytes;
    out.push(c.doc);
  }
  return out;
}

/** Recoverable entries: valid manifests from sessions that are not running, newest first. Pure. */
export function recoverable(manifests, liveSessions) {
  return manifests.filter((m) => validManifest(m) && !liveSessions.has(m.session)).sort((a, b) => b.savedAt - a.savedAt);
}

function floatWavHeader(sampleRate, channels, frames) {
  const dataSize = frames * channels * 4;
  const b = new ArrayBuffer(44);
  const dv = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, Math.min(0xffffffff, 36 + dataSize), true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 4, true);
  dv.setUint16(32, channels * 4, true);
  dv.setUint16(34, 32, true);
  w(36, 'data');
  dv.setUint32(40, Math.min(0xffffffff, dataSize), true);
  return b;
}

export class AutosaveStore {
  /** @param {() => Promise<FileSystemDirectoryHandle>} getRoot OPFS root (navigator.storage.getDirectory) */
  constructor(getRoot) {
    this.getRoot = getRoot;
    this.dir = null;
  }

  async #dir() {
    if (!this.dir) this.dir = await (await this.getRoot()).getDirectoryHandle(DIR_NAME, { create: true });
    return this.dir;
  }

  /** Writes the document's audio and manifest. The manifest goes last, so a torn write is never offered. */
  async write(doc, manifest, { yieldEvery = 8 } = {}) {
    // The audio of the state the manifest was built from: the document may change while
    // the file opens, and a copy mixing two states would recover with the wrong length or markers.
    const channels = doc.state.channels;
    const dir = await this.#dir();
    const file = await dir.getFileHandle(`${manifest.key}.wav`, { create: true });
    const out = await file.createWritable();
    try {
      const nch = channels.length;
      const frames = manifest.frames;
      await out.write(floatWavHeader(doc.sampleRate, nch, frames));
      const tmp = Array.from({ length: nch }, () => new Float32Array(BLOCK));
      let blocks = 0;
      for (let at = 0; at < frames; at += BLOCK) {
        const n = Math.min(BLOCK, frames - at);
        const inter = new Float32Array(n * nch);
        for (let c = 0; c < nch; c++) {
          channels[c].read(at, tmp[c], 0, n);
          const src = tmp[c];
          for (let i = 0, p = c; i < n; i++, p += nch) inter[p] = src[i];
        }
        await out.write(inter);
        // Give the main thread room between blocks of a long file.
        if (++blocks % yieldEvery === 0) await new Promise((r) => setTimeout(r, 0));
      }
      await out.close();
    } catch (err) {
      await out.abort?.().catch(() => {});
      throw err;
    }
    const mf = await dir.getFileHandle(`${manifest.key}.json`, { create: true });
    const w = await mf.createWritable();
    await w.write(JSON.stringify(manifest));
    await w.close();
  }

  async remove(key) {
    const dir = await this.#dir();
    for (const name of [`${key}.json`, `${key}.wav`]) {
      try {
        await dir.removeEntry(name);
      } catch {
        // Already gone.
      }
    }
  }

  /** All manifests in the store (unreadable ones are deleted). */
  async list() {
    const dir = await this.#dir();
    const out = [];
    const names = [];
    for await (const [name, handle] of dir.entries()) names.push([name, handle]);
    for (const [name, handle] of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const m = JSON.parse(await (await handle.getFile()).text());
        if (validManifest(m)) out.push(m);
      } catch {
        await dir.removeEntry(name).catch(() => {});
      }
    }
    // Audio files without a manifest are leftovers of interrupted writes
    // (recent ones may still be being written by another tab).
    const keys = new Set(out.map((m) => m.key));
    for (const [name, handle] of names) {
      if (!name.endsWith('.wav') || keys.has(name.slice(0, -4))) continue;
      const file = await handle.getFile().catch(() => null);
      if (file && Date.now() - file.lastModified > 10 * 60 * 1000) await dir.removeEntry(name).catch(() => {});
    }
    return out;
  }

  async readAudio(key) {
    const dir = await this.#dir();
    const h = await dir.getFileHandle(`${key}.wav`);
    return h.getFile();
  }
}
