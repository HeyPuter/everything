// Where projects and imported audio live, without any UI:
//
//   This device (IndexedDB, works signed out): projects saved with Save while
//   signed out, the bytes of every imported sample, and the autosaved session.
//   Puter cloud (signed in only): Projects/<name>.msproj and
//   Samples/<sampleId>.<ext> in the app's own Puter folder (~/AppData/<app id>) (each sample is uploaded once, the
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
    await db.put('projectData', key, json);
    await db.put('projects', key, { key, name, modified: this.now(), size: json.length });
    return { key, name };
  }

  async loadLocal(key) {
    const db = await this.db();
    const json = await db.get('projectData', key);
    if (!json) throw new Error('That project is no longer saved on this device.');
    return parseProject(json);
  }

  async deleteLocal(key) {
    const db = await this.db();
    await db.delete('projectData', key);
    await db.delete('projects', key);
  }

  async renameLocal(key, name) {
    const db = await this.db();
    const meta = await db.get('projects', key);
    if (meta) await db.put('projects', key, { ...meta, name });
  }

  // ---------------------------------------------------------------- samples

  /** Stores imported audio bytes on this device (kept for every sample, also when signed in). */
  async putSample(id, { data, name = 'Sample', type = '', path = null }) {
    const db = await this.db();
    await db.put('samples', id, { id, name, type, size: data.byteLength, data, path });
  }

  async sampleRecord(id) {
    const db = await this.db();
    return db.get('samples', id);
  }

  /**
   * The encoded bytes of a sample: this device first (no download cost),
   * then the Puter copy when signed in (cached here afterwards). Null if missing.
   */
  async sampleBytes(ref) {
    const rec = (await this.sampleRecord(ref.local || ref.id)) || (ref.local ? await this.sampleRecord(ref.id) : null);
    if (rec?.data) return rec.data;
    if (!ref.path || !this.puter.isSignedIn()) return null;
    try {
      const blob = await this.puter.readFile(ref.path);
      const data = await blob.arrayBuffer();
      await this.putSample(ref.id, { data, name: ref.name, type: blob.type || '', path: ref.path }).catch(() => {});
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Decodes every sample of a project that the cache does not hold yet.
   * Resolves { loaded, missing: [sample names] }; missing samples keep their channels.
   */
  async loadSamples(project, cache) {
    const missing = [];
    let loaded = 0;
    for (const ref of Object.values(project.samples || {})) {
      if (cache.has(ref.id)) continue;
      const bytes = await this.sampleBytes(ref);
      if (!bytes) {
        missing.push(ref.name);
        continue;
      }
      try {
        cache.set(ref.id, await this.decode(bytes));
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
    const samples = { ...project.samples };
    const missing = [];
    let dir = null;
    for (const ref of Object.values(project.samples || {})) {
      if (ref.path) continue;
      const key = ref.local || ref.id;
      const rec = await this.sampleRecord(key);
      if (rec?.path) {
        samples[ref.id] = { ...ref, path: rec.path };
        continue;
      }
      if (!rec?.data) {
        missing.push(ref.name);
        continue;
      }
      dir ??= await this.puter.appSubdir('Samples');
      const path = this.puter.joinPath(dir, `${ref.id}.${audioExtension(rec.name, rec.data)}`);
      const item = await this.puter.writeFile(path, new Blob([rec.data], { type: rec.type || 'application/octet-stream' }));
      const saved = item?.path || path;
      await this.putSample(key, { ...rec, path: saved });
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
    await db.put('drafts', key, { ...draft, at: this.now() });
  }

  async loadDraft(key = 'session') {
    const db = await this.db();
    return db.get('drafts', key);
  }

  async clearDraft(key = 'session') {
    const db = await this.db();
    await db.delete('drafts', key);
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
    const embedded = {};
    const missing = [];
    let total = 0;
    let skipped = false;
    for (const ref of Object.values(project.samples || {})) {
      const bytes = await this.sampleBytes(ref);
      if (!bytes) {
        missing.push(ref.name);
        continue;
      }
      if (total + bytes.byteLength > MAX_EMBED_BYTES) {
        skipped = true;
        continue;
      }
      total += bytes.byteLength;
      const rec = await this.sampleRecord(ref.local || ref.id);
      embedded[ref.id] = { name: ref.name, type: rec?.type || '', data: toBase64(bytes) };
    }
    let text = serializeProject(project, view);
    if (Object.keys(embedded).length) text = `${text.slice(0, -1)},"embedded":${JSON.stringify(embedded)}}`;
    return { blob: new Blob([text], { type: 'application/json' }), missing, skipped };
  }

  /** Parses project JSON, storing any embedded samples on this device. */
  async readProjectText(text) {
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
        const e = embedded[ref.id];
        if (!e || typeof e.data !== 'string') continue;
        try {
          const bytes = fromBase64(e.data);
          await this.putSample(ref.id, { data: bytes, name: ref.name, type: typeof e.type === 'string' ? e.type : '' });
          samples[ref.id] = { ...ref, local: ref.id };
        } catch {
          // A damaged embedded sample counts as missing when the project loads.
        }
      }
      project.samples = samples;
    }
    return project;
  }
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
