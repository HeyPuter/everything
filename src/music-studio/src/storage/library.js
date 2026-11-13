// Where projects and imported audio live, without any UI:
//
//   This device (IndexedDB, works signed out): projects saved with Save while
//   signed out, the bytes of every imported sample, and the autosaved session.
//   Puter cloud (signed in only): Projects/<name>.msproj and
//   Samples/<storage key>.<ext> in the app's own Puter folder (~/AppData/<app id>) (each sample is uploaded once, the
//   first time a project using it is saved to the cloud).
//
// Every cloud method checks the sign-in state first and throws a friendly
// error instead of letting Puter pop up a sign-in prompt.
//
// A project downloaded with "Save to your device" is the same JSON with the
// samples embedded (base64 under `embedded`), so it opens anywhere.

import * as puterApi from './puter.js';
import { serializeProject, parseProject } from '../model/serialize.js';
import { decodeAudio } from '../audio/samples.js';
import { audioExtension } from '../io/wav.js';
import { safeFileName } from '../io/download.js';
import { uid } from '../lib/util.js';
import { FILE_EXT } from '../model/project.js';

/** Largest audio file accepted for import. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** Samples larger than this in total are left out of downloaded project files. */
export const MAX_EMBED_BYTES = 80 * 1024 * 1024;

// Independent embedded copies use a content hash, or a random key without Web
// Crypto. Falling back to their project ID could select unrelated older audio.
const isEmbeddedKey = (key) => typeof key === 'string' && /^embedded-(?:[a-z0-9]{16}|[a-f0-9]{64})$/i.test(key);
const isHashedKey = (key) => typeof key === 'string' && /^embedded-[a-f0-9]{64}$/i.test(key);
const temporaryRecord = (temporary, ref) => temporary.get(ref.local || ref.id) || (!isEmbeddedKey(ref.local) ? temporary.get(ref.id) : null);

export class Library {
  /**
   * @param {object} o
   * @param {Promise|object} o.db  storage adapter from idb.js (or a promise of one)
   * @param {object} o.puter       the Puter wrapper (storage/puter.js); injectable for tests
   */
  constructor({ db, puter = puterApi, decode = decodeAudio, now = () => Date.now() }) {
    this.dbReady = Promise.resolve(db);
    this.puter = puter;
    this.decode = decode;
    this.now = now;
    this.temporarySamples = new Map(); // failed writes, retained for playback and recovery saves
  }

  db() {
    return this.dbReady;
  }

  // ---------------------------------------------------------------- local projects

  /** Projects saved on this device, newest first: [{ key, name, modified, size }]. */
  async listLocal() {
    const db = await this.db();
    return (await db.all('projects')).map(([, v]) => v).filter(Boolean).sort((a, b) => b.modified - a.modified);
  }

  async saveLocal(project, view, { key = uid(), name = project.name } = {}) {
    const db = await this.db();
    const json = serializeProject(project, view);
    await db.batch([
      { type: 'put', store: 'projectData', key, value: json },
      { type: 'put', store: 'projects', key, value: { key, name, modified: this.now(), size: json.length } },
    ]);
    return { key, name, persistent: db.persistent !== false };
  }

  async loadLocal(key) {
    const db = await this.db();
    const json = await db.get('projectData', key);
    if (!json) throw new Error('That project is no longer saved on this device.');
    return parseProject(json);
  }

  async deleteLocal(key) {
    const db = await this.db();
    await db.batch([
      { type: 'delete', store: 'projectData', key },
      { type: 'delete', store: 'projects', key },
    ]);
  }

  async renameLocal(key, name) {
    const db = await this.db();
    const meta = await db.get('projects', key);
    if (meta) await db.put('projects', key, { ...meta, name });
  }

  // ---------------------------------------------------------------- samples

  /** Stores imported audio bytes on this device (kept for every sample, also when signed in). */
  async putSample(id, { data, name = 'Sample', type = '', path = null }, { temporary = this.temporarySamples } = {}) {
    const record = { id, name, type, size: data.byteLength, data, path };
    const previous = temporary.get(id);
    const retained = () => temporary !== this.temporarySamples && previous && this.temporarySamples.get(id) === previous;
    try {
      const db = await this.db();
      await db.put('samples', id, record);
      temporary.delete(id);
      if (retained()) this.temporarySamples.delete(id);
    } catch (err) {
      temporary.set(id, record);
      if (retained()) this.temporarySamples.set(id, record);
      throw err;
    }
  }

  /** Whether this project still depends on audio with no durable copy. */
  hasTemporarySamples(project) {
    return Object.values(project.samples || {}).some((ref) => {
      const rec = temporaryRecord(this.temporarySamples, ref);
      return rec && !ref.path && !rec.path;
    });
  }

  dropTemporarySample(id) {
    this.temporarySamples.delete(id);
  }

  /** Project replacement clears undo, so only the replacement's samples remain needed. */
  pruneTemporarySamples(project) {
    const keep = new Set(Object.values(project.samples || {}).flatMap((ref) => isEmbeddedKey(ref.local) ? [ref.local] : [ref.id, ref.local]));
    // Saves already in progress retain their original map until they finish.
    this.temporarySamples = new Map([...this.temporarySamples].filter(([id]) => keep.has(id)));
  }

  async sampleRecord(id) {
    if (this.temporarySamples.has(id)) return this.temporarySamples.get(id);
    const db = await this.db();
    return db.get('samples', id);
  }

  /**
   * The encoded bytes of a sample: this device first (no download cost),
   * then the Puter copy when signed in (cached here afterwards). Null if missing.
   */
  async sampleBytes(ref) {
    const temporary = this.temporarySamples;
    // An unreadable local cache must not prevent recovery from another copy.
    const rec = (await this.sampleRecord(ref.local || ref.id).catch(() => null)) || (ref.local && ref.local !== ref.id && !isEmbeddedKey(ref.local) ? await this.sampleRecord(ref.id).catch(() => null) : null);
    if (rec?.data) return rec.data;
    if (!ref.path || !this.puter.isSignedIn()) return null;
    try {
      const blob = await this.puter.readFile(ref.path);
      const data = await blob.arrayBuffer();
      const key = isEmbeddedKey(ref.local) ? ref.local : ref.id;
      if (isHashedKey(key)) {
        const hash = await hashBytes(data);
        if (!hash) return data; // Play without caching when Web Crypto is unavailable.
        if (key !== `embedded-${hash}`) return null;
      }
      await this.putSample(key, { data, name: ref.name, type: blob.type || '', path: ref.path }, { temporary }).catch(() => {});
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Decodes every sample of a project that the cache does not hold yet.
   * Resolves { loaded, missing: [sample names] }; missing samples keep their channels.
   */
  async loadSamples(project, cache, { isCurrent = () => true } = {}) {
    const missing = [];
    let loaded = 0;
    for (const ref of Object.values(project.samples || {})) {
      if (!isCurrent()) break;
      if (cache.has(ref.id)) continue;
      const bytes = await this.sampleBytes(ref);
      if (!isCurrent()) break;
      if (!bytes) {
        missing.push(ref.name);
        continue;
      }
      try {
        const decoded = await this.decode(bytes);
        if (!isCurrent()) break;
        cache.set(ref.id, decoded);
        loaded++;
      } catch {
        missing.push(ref.name);
      }
    }
    return { loaded, missing };
  }

  // ---------------------------------------------------------------- cloud

  async cloudProjectsDir() {
    return this.puter.appSubdir('Projects');
  }

  async cloudPathFor(name) {
    return this.puter.joinPath(await this.cloudProjectsDir(), `${safeFileName(name)}${FILE_EXT}`);
  }

  /**
   * Uploads samples that have no Puter copy yet (each once; the path is
   * remembered with the bytes). Resolves the project's samples with paths
   * filled in, and the names of samples whose bytes are not on this device.
   */
  async uploadSamples(project) {
    this.puter.requireSignedIn();
    const temporary = this.temporarySamples;
    const samples = { ...project.samples };
    const missing = [];
    let dir = null;
    for (const ref of Object.values(project.samples || {})) {
      if (ref.path) continue;
      const key = ref.local || ref.id;
      const rec = temporaryRecord(temporary, ref) || await this.sampleRecord(key);
      if (rec?.path) {
        samples[ref.id] = { ...ref, path: rec.path };
        continue;
      }
      if (!rec?.data) {
        missing.push(ref.name);
        continue;
      }
      dir ??= await this.puter.appSubdir('Samples');
      // Embedded files may reuse a project sample ID for different audio.
      const fileId = isEmbeddedKey(key) ? key : ref.id;
      const path = this.puter.joinPath(dir, `${fileId}.${audioExtension(rec.name, rec.data)}`);
      const item = await this.puter.writeFile(path, new Blob([rec.data], { type: rec.type || 'application/octet-stream' }));
      const saved = item?.path || path;
      await this.putSample(key, { ...rec, path: saved }, { temporary }).catch(() => {});
      samples[ref.id] = { ...ref, path: saved };
    }
    return { samples, missing };
  }

  /** Saves to a Puter path (uploading new samples first). Resolves { path, missing }. */
  async saveCloud(project, view, { path }) {
    this.puter.requireSignedIn();
    const { samples, missing } = await this.uploadSamples(project);
    const json = serializeProject({ ...project, samples }, view);
    const item = await this.puter.writeFile(path, new Blob([json], { type: 'application/json' }));
    return { path: item?.path || path, missing, samples };
  }

  async loadCloud(path) {
    this.puter.requireSignedIn();
    const blob = await this.puter.readFile(path);
    return this.readProjectText(await blob.text());
  }

  // ---------------------------------------------------------------- session draft

  // Drafts are keyed per tab (storage/tabs.js); 'session' is the shared key
  // used before tabs had their own, and where the Web Locks API is missing.

  async saveDraft(draft, key = 'session') {
    const db = await this.db();
    const record = { ...draft, at: this.now(), revision: uid() };
    await db.put('drafts', key, record);
    return record;
  }

  /** Transfer recovery ownership without leaving a second abandoned copy on failure. */
  async adoptDraft(draft, from, to) {
    const db = await this.db();
    const record = { ...draft, at: this.now(), revision: uid() };
    await db.batch([
      { type: 'put', store: 'drafts', key: to, value: record },
      { type: 'delete', store: 'drafts', key: from },
    ]);
    return record;
  }

  async loadDraft(key = 'session') {
    const db = await this.db();
    return db.get('drafts', key);
  }

  async clearDraft(key = 'session') {
    const db = await this.db();
    await db.delete('drafts', key);
  }

  /** Discard only the version this tab owns, even when legacy tabs share a key. */
  async discardDraft(key, expected) {
    if (!expected) return false;
    const db = await this.db();
    return db.deleteIf('drafts', key, (record) => expected.revision
      ? record.revision === expected.revision
      : JSON.stringify(record) === JSON.stringify(expected));
  }

  /** Every stored draft as [[key, draft], ...]. */
  async allDrafts() {
    const db = await this.db();
    return db.all('drafts');
  }

  // ---------------------------------------------------------------- device files

  /**
   * A self-contained project file for download: the project JSON with the
   * sample bytes embedded. Resolves { blob, missing, skipped } (skipped: too large to embed).
   */
  async exportFile(project, view) {
    const temporary = this.temporarySamples;
    const embedded = {};
    const missing = [];
    let total = 0;
    let skipped = false;
    for (const ref of Object.values(project.samples || {})) {
      const retained = temporaryRecord(temporary, ref);
      const bytes = retained?.data || await this.sampleBytes(ref);
      if (!bytes) {
        missing.push(ref.name);
        continue;
      }
      if (total + bytes.byteLength > MAX_EMBED_BYTES) {
        skipped = true;
        continue;
      }
      total += bytes.byteLength;
      const rec = retained || await this.sampleRecord(ref.local || ref.id).catch(() => null);
      embedded[ref.id] = { name: ref.name, type: rec?.type || '', data: toBase64(bytes) };
    }
    let text = serializeProject(project, view);
    if (Object.keys(embedded).length) text = `${text.slice(0, -1)},"embedded":${JSON.stringify(embedded)}}`;
    return { blob: new Blob([text], { type: 'application/json' }), missing, skipped };
  }

  /** Parses project JSON, storing any embedded samples on this device. */
  async readProjectText(text) {
    const temporary = this.temporarySamples;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('The file is not a Music Studio project.');
    }
    const project = parseProject(data);
    const embedded = data && typeof data.embedded === 'object' ? data.embedded : null;
    if (embedded) {
      const samples = { ...project.samples };
      for (const ref of Object.values(project.samples)) {
        if (!Object.hasOwn(embedded, ref.id)) continue;
        const e = embedded[ref.id];
        try {
          if (!e || typeof e.data !== 'string') throw new Error('Invalid embedded audio');
          const bytes = fromBase64(e.data);
          const oldKey = ref.local || ref.id;
          const existing = temporary.get(oldKey) || await this.sampleRecord(oldKey).catch(() => null);
          if (existing?.data && sameBytes(existing.data, bytes)) {
            samples[ref.id] = { ...ref, local: oldKey, path: existing.path || null };
          } else {
            // Never overwrite another project's audio, even before open approval
            // or when two embedded files with the same IDs are read concurrently.
            const hash = await hashBytes(bytes);
            const local = `embedded-${hash || uid(16)}`;
            const retained = temporary.get(local) || await this.sampleRecord(local).catch(() => null);
            const reusable = retained?.data && sameBytes(retained.data, bytes);
            if (!reusable) await this.putSample(local, { data: bytes, name: ref.name, type: typeof e.type === 'string' ? e.type : '' }, { temporary }).catch(() => {});
            samples[ref.id] = { ...ref, local, path: reusable ? retained.path || null : null };
          }
        } catch {
          // A damaged entry must not select older audio by its project ID.
          // Keep an explicit cloud path available as the recovery source.
          samples[ref.id] = { ...ref, local: `embedded-${uid(16)}` };
        }
      }
      project.samples = samples;
    }
    return project;
  }
}

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a), right = new Uint8Array(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false;
  return true;
}

async function hashBytes(bytes) {
  try {
    const digest = await globalThis.crypto.subtle?.digest('SHA-256', new Uint8Array(bytes));
    if (digest) return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  } catch { /* An independent random key still prevents overwriting another sample. */ }
  return null;
}

// ------------------------------------------------------------------ base64

export function toBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(str) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(str).buffer;
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
