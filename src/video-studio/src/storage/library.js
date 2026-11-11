/**
 * Project library: the list of projects, opening and saving them, and the
 * media files they use.
 *
 * Layout inside the backend root:
 *   index.json                 [{ id, name, modified, duration, ratio, deletedAt?, ... }]
 *   projects/<id>.json         project documents
 *   covers/<id>.jpg            home screen thumbnails
 *   media/<hash>.<ext>         imported media, shared by all projects
 *   luts/index.json            [{ id, name, kind, size, added }] imported color LUTs
 *   luts/<hash>.cube           LUT files, shared by all projects (clips refer to them by id)
 *
 * Deleting from the home screen moves a project to the Trash (deletedAt set
 * in its file and index entry); it is removed for good after TRASH_DAYS.
 *
 * Media read from the cloud is cached in OPFS so reopening a project does not
 * download every file again.
 */
import { Emitter } from '../lib/emitter.js';
import { fingerprint, uid } from '../lib/ids.js';
import { createProject, normalizeProject, normalizeAsset, projectSummary } from '../model/project.js';
import { projectDuration } from '../model/timeline.js';
import { parseCube, lutName } from '../model/cube.js';
import { opfsBackend, opfsAvailable } from './backends.js';

const DAY = 24 * 60 * 60 * 1000;
/** A failed media upload is tried again after 5 s, then less and less often, up to every 2 minutes. */
const UPLOAD_RETRY = [5_000, 15_000, 30_000, 60_000, 120_000];
/** A listing of the media folder is reused this long (a batch of imports lists it once). */
const MEDIA_LIST_AGE = 30_000;
/** Projects in the Trash are deleted for good after this many days. */
export const TRASH_DAYS = 30;

export class Library extends Emitter {
  constructor(backend, { cache } = {}) {
    super();
    this.backend = backend;
    this.cache = cache !== undefined ? cache : backend.kind === 'puter' && opfsAvailable() ? opfsBackend('video-studio-cache') : null;
    this.urls = new Map(); // hash -> object URL
    this.blobs = new Map(); // hash -> Blob (recent imports and reads)
    this.reads = new Map(); // hash -> Promise<Blob>: files being read, shared by everyone asking
    this.stored = null; // { at, files: Promise<Map(name -> size)> }: recent listing of the media folder
    this.uploads = new Map(); // hash -> Promise
    this.failed = new Map(); // hash -> { asset, blob, tries, timer }: uploads that failed, tried again later
    this.index = null;
    this.luts = null; // LUT list, read on first use
  }

  /** Projects not in the Trash, most recently modified first. */
  async listProjects() {
    const index = await this._readIndex();
    return index.filter((p) => !p.deletedAt).sort((a, b) => b.modified - a.modified);
  }

  /** Projects in the Trash, most recently deleted first. */
  async listTrash() {
    const index = await this._readIndex();
    return index.filter((p) => p.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async _readIndex() {
    // Missing or damaged: rebuilt from the project files. A read that failed (offline) is an
    // error: rebuilding then could skip project files that can't be read either and drop them.
    let index = await this.backend.readJSON('index.json').catch((err) => {
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    if (!Array.isArray(index)) index = await this._rebuildIndex();
    this.index = index;
    return index;
  }

  async _rebuildIndex() {
    const files = await this.backend.list('projects');
    const out = [];
    for (const f of files) {
      if (f.isDir || !f.name.endsWith('.json')) continue;
      try {
        const p = await this.openProject(f.name.slice(0, -'.json'.length));
        out.push(projectSummary(p, projectDuration(p)));
      } catch (err) {
        // Damaged files are left out; any other failure stops the rebuild before it drops projects.
        if (!err?.unreadable) throw err;
      }
    }
    await this.backend.writeJSON('index.json', out).catch(() => {});
    return out;
  }

  /**
   * Change the project list. Changes run one after another (two at once would
   * read the same list and the second write would drop the first one's
   * change); changes asked for while one is being written share the next
   * read and write.
   */
  _updateIndex(fn) {
    return new Promise((resolve, reject) => {
      const first = !this._indexPending;
      (this._indexPending ||= []).push({ fn, resolve, reject });
      if (first) this._indexQueue = (this._indexQueue || Promise.resolve()).then(() => this._writeIndex());
    });
  }

  async _writeIndex() {
    const batch = this._indexPending;
    this._indexPending = null;
    try {
      // Read it again: another tab or device may have changed it since. If it
      // can't be read, keep working from the list this tab knows.
      let index = await this.backend.readJSON('index.json').catch(() => undefined);
      if (!Array.isArray(index)) index = this.index || (await this._readIndex());
      let next = [...index];
      for (const { fn } of batch) next = fn([...next]);
      this.index = next;
      await this.backend.writeJSON('index.json', next);
      this.emit('index', next);
      for (const { resolve } of batch) resolve();
    } catch (err) {
      for (const { reject } of batch) reject(err);
    }
  }

  /** "Project N" with the lowest N no project (Trash included) is called. */
  async nextProjectName() {
    const used = new Set((await this._readIndex()).map((p) => String(p.name).trim().toLowerCase()));
    let n = 1;
    while (used.has(`project ${n}`)) n++;
    return `Project ${n}`;
  }

  async createProject(opts) {
    const project = createProject(opts);
    await this.saveProject(project);
    return project;
  }

  /** Open a project document. Errors for a missing or damaged file have unreadable set. */
  async openProject(id) {
    const unreadable = (message) => Object.assign(new Error(message), { unreadable: true });
    let raw;
    try {
      raw = await this.backend.readJSON(`projects/${id}.json`);
    } catch (err) {
      if (err instanceof SyntaxError) throw unreadable('This project file is damaged.');
      throw err;
    }
    if (!raw) throw unreadable('This project could not be found. It may have been deleted.');
    let project;
    try {
      project = normalizeProject(raw);
    } catch (err) {
      throw unreadable(err?.message || 'This project file is damaged.');
    }
    // The file name is the id: a document without one (or with another) must still save back to this file.
    project.id = id;
    return project;
  }

  async saveProject(project) {
    await this.backend.writeJSON(`projects/${project.id}.json`, project);
    const summary = projectSummary(project, projectDuration(project));
    await this._updateIndex((list) => [summary, ...list.filter((p) => p.id !== project.id)]);
  }

  async renameProject(id, name) {
    const p = await this.openProject(id);
    p.name = name;
    p.modified = Date.now();
    await this.saveProject(p);
    return p;
  }

  async duplicateProject(id) {
    const p = await this.openProject(id);
    const copy = structuredClone(p);
    copy.id = uid('p');
    // "Trip copy", then "Trip copy 2"...: a name no project (Trash included) has.
    const used = new Set((await this._readIndex()).map((x) => String(x.name).trim().toLowerCase()));
    const base = `${p.name} copy`.slice(0, 200);
    copy.name = base;
    for (let n = 2; used.has(copy.name.toLowerCase()); n++) copy.name = `${base} ${n}`;
    delete copy.deletedAt;
    copy.created = copy.modified = Date.now();
    await this.saveProject(copy);
    const cover = await this.backend.readBlob(`covers/${id}.jpg`).catch(() => null);
    if (cover) await this.backend.writeBlob(`covers/${copy.id}.jpg`, cover).catch(() => {});
    return copy;
  }

  /** Move a project to the Trash. It keeps its files until it is deleted for good or purged. */
  async trashProject(id, now = Date.now()) {
    const p = await this._openOrEntry(id);
    if (!p) return this._editEntry(id, (e) => ({ ...e, deletedAt: now }));
    p.deletedAt = now;
    await this.saveProject(p);
    return p;
  }

  /** Bring a project back from the Trash. */
  async restoreProject(id) {
    const p = await this._openOrEntry(id);
    if (!p) return this._editEntry(id, ({ deletedAt, ...e }) => e);
    delete p.deletedAt;
    await this.saveProject(p);
    return p;
  }

  /**
   * The project, or null when its file is missing or damaged but the list has
   * an entry for it: that entry can still go to the Trash and be deleted.
   */
  async _openOrEntry(id) {
    try {
      return await this.openProject(id);
    } catch (err) {
      if (err?.unreadable && (this.index || (await this._readIndex())).some((e) => e.id === id)) return null;
      throw err;
    }
  }

  async _editEntry(id, fn) {
    let entry = null;
    await this._updateIndex((list) => list.map((e) => (e.id === id ? (entry = fn(e)) : e)));
    return entry;
  }

  /** Delete every project in the Trash for good. Returns the ids removed. */
  async emptyTrash() {
    const ids = (await this.listTrash()).map((p) => p.id);
    await this._deleteProjects(ids);
    return ids;
  }

  /** Delete projects that have been in the Trash longer than maxAge (default 30 days). */
  async purgeTrash({ now = Date.now(), maxAge = TRASH_DAYS * DAY } = {}) {
    const old = (await this.listTrash()).filter((p) => now - p.deletedAt >= maxAge).map((p) => p.id);
    await this._deleteProjects(old);
    return old;
  }

  /** Project count and, when the backend reports file sizes, the bytes used by media. */
  async storageUsage() {
    const index = await this._readIndex();
    const media = await this.backend.list('media').catch(() => []);
    const files = media.filter((f) => !f.isDir);
    const known = files.length > 0 && files.every((f) => f.size > 0);
    return {
      projects: index.filter((p) => !p.deletedAt).length,
      trashed: index.filter((p) => p.deletedAt).length,
      mediaFiles: files.length,
      mediaBytes: known ? files.reduce((n, f) => n + f.size, 0) : null,
    };
  }

  /** Delete a project for good (its media stays: other projects may use it). */
  async deleteProject(id) {
    await this._deleteProjects([id]);
  }

  async _deleteProjects(ids) {
    const gone = [];
    for (const id of ids) {
      // What it used, to let go of cached copies afterwards.
      if (this.cache) gone.push(await this.openProject(id).catch(() => null));
      await this.backend.remove(`projects/${id}.json`);
      await this.backend.remove(`covers/${id}.jpg`).catch(() => {});
      await this._updateIndex((list) => list.filter((p) => p.id !== id));
    }
    if (gone.some(Boolean)) this.cacheCleanup = this._dropCached(gone.filter(Boolean)).catch(() => {});
  }

  /**
   * Remove the cached copies (this browser's copies of cloud media) of media
   * that projects deleted for good used and no other project uses. When any
   * other project can't be read, nothing is removed.
   */
  async _dropCached(projects) {
    const paths = new Set();
    for (const p of projects) for (const a of Object.values(p.assets || {})) if (a.hash) paths.add(this.mediaPath(a));
    if (!paths.size) return;
    for (const e of await this._readIndex()) {
      const p = await this.openProject(e.id);
      for (const a of Object.values(p.assets)) paths.delete(this.mediaPath(a));
    }
    for (const path of paths) await this.cache.remove(path).catch(() => {});
  }

  /** Media files cached in this browser: { files, bytes } (zero without a cache). */
  async cacheUsage() {
    if (!this.cache) return { files: 0, bytes: 0 };
    const files = (await this.cache.list('media')).filter((f) => !f.isDir);
    return { files: files.length, bytes: files.reduce((n, f) => n + (f.size || 0), 0) };
  }

  /**
   * Delete this browser's copies of cloud media (they are read from the
   * cloud again when needed). Files the open project holds right now stay.
   * Returns how many were deleted.
   */
  async clearCache() {
    if (!this.cache) return 0;
    let n = 0;
    for (const f of await this.cache.list('media')) {
      if (f.isDir) continue;
      const hash = f.name.replace(/\.[^.]*$/, '');
      if (this.blobs.has(hash) || this.reads.has(hash) || this.uploads.has(hash)) continue;
      await this.cache.remove(`media/${f.name}`).catch(() => {});
      n++;
    }
    return n;
  }

  async saveCover(id, blob) {
    await this.backend.writeBlob(`covers/${id}.jpg`, blob);
    this.emit('cover', { id });
  }

  async coverBlob(id) {
    return this.backend.readBlob(`covers/${id}.jpg`).catch(() => null);
  }

  /**
   * Claim a project while the editor has it open, so another tab of this
   * browser opening it too can warn first. Resolves { held, release() }:
   * held is false when another tab has it open (this one then takes over
   * the claim once that tab lets go). Without navigator.locks, always held.
   */
  async claimProject(id) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks?.request) return { held: true, release() {} };
    const name = `video-studio:project:${id}`;
    let letGo;
    const done = new Promise((r) => (letGo = r));
    const stop = new AbortController();
    const held = await new Promise((resolve) => {
      locks
        .request(name, { ifAvailable: true }, (lock) => {
          resolve(Boolean(lock));
          return lock ? done : null;
        })
        .catch(() => resolve(true));
    });
    // Opened anyway: take the claim over when the other tab lets go, so a third tab is warned too.
    if (!held) locks.request(name, { signal: stop.signal }, () => done).catch(() => {});
    return {
      held,
      release() {
        stop.abort();
        letGo();
      },
    };
  }

  /** True when a tab or window of this browser has the project open in the editor (see claimProject). */
  async isProjectOpen(id) {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks?.query) return false;
    try {
      const { held = [] } = await locks.query();
      return held.some((l) => l.name === `video-studio:project:${id}`);
    } catch {
      return false;
    }
  }

  mediaPath(asset) {
    return `media/${asset.hash}.${asset.ext}`;
  }

  /**
   * Import a local File: probe it, start storing it, and return the asset at
   * once so it can be used while the upload continues.
   */
  async importFile(file, { origin = 'import', onNote } = {}) {
    // Mediabunny is loaded on first import so the home screen starts faster.
    const { probe, extOf, storableFile, mediaMime } = await import('../media/probe.js');
    // SVG pictures are stored drawn as PNG (the name stays the one the user knows).
    const source = file;
    file = await storableFile(file);
    const info = await probe(file);
    const hash = await fingerprint(file);
    const asset = normalizeAsset({
      id: uid('a'),
      kind: info.kind,
      name: source.name || `${info.kind} ${new Date().toLocaleString()}`,
      hash,
      ext: extOf(file.name, file.type),
      mime: mediaMime(file),
      size: file.size,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
      added: Date.now(),
      origin,
    });
    if (info.soundUnsupported) onNote?.(`${source.name || 'This video'}: its sound can't be played in this browser, so it was added without sound.`);
    this.blobs.set(hash, file);
    this._store(asset, file);
    return asset;
  }

  /**
   * Add media made in the app or read from a project file: fingerprint the
   * blob, store it, and return the asset (fields describe it). Resolves once
   * the file is stored.
   */
  async addMediaBlob(fields, blob) {
    const hash = await fingerprint(blob);
    const asset = normalizeAsset({ id: uid('a'), added: Date.now(), ...fields, hash, size: blob.size });
    if (!asset) throw new Error(`Unsupported media: ${fields?.name || 'file'}`);
    const typed = asset.mime && blob.type !== asset.mime ? new Blob([blob], { type: asset.mime }) : blob;
    this.blobs.set(hash, typed);
    await this._store(asset, typed);
    return asset;
  }

  _store(asset, blob) {
    const key = asset.hash;
    if (this.uploads.has(key)) return this.uploads.get(key);
    const retry = this.failed.get(key);
    if (retry) {
      clearTimeout(retry.timer);
      this.failed.delete(key);
    }
    const path = this.mediaPath(asset);
    const job = (async () => {
      // Same content imported before: nothing to upload.
      const name = `${asset.hash}.${asset.ext}`;
      const stored = await this._storedMedia();
      const size = stored.get(name);
      if (size === undefined || (size && size !== blob.size)) {
        await this.backend.writeBlob(path, blob);
        stored.set(name, blob.size);
      }
      if (this.cache) await this.cache.writeBlob(path, blob).catch(() => {});
    })();
    this.uploads.set(key, job);
    this._emitUploads();
    job.then(
      () => {
        this.uploads.delete(key);
        this._emitUploads();
      },
      (err) => {
        this.uploads.delete(key);
        // The blob stays in memory (see releaseMedia) until a later try stores it.
        const tries = (retry?.tries || 0) + 1;
        const timer = setTimeout(() => this._store(asset, blob), UPLOAD_RETRY[Math.min(tries, UPLOAD_RETRY.length) - 1]);
        this.failed.set(key, { asset, blob, tries, timer });
        this._emitUploads(err);
      },
    );
    return job;
  }

  /** Names and sizes of the files in the media folder, listed at most every MEDIA_LIST_AGE. */
  _storedMedia(fresh = false) {
    const now = Date.now();
    if (fresh || !this.stored || now - this.stored.at > MEDIA_LIST_AGE) {
      const files = this.backend.list('media').then((list) => new Map(list.filter((f) => !f.isDir).map((f) => [f.name, f.size || 0])));
      this.stored = { at: now, files };
      // A failed listing is not kept: the next upload lists again (and this one uploads).
      files.catch(() => this.stored?.files === files && (this.stored = null));
    }
    return this.stored.files.catch(() => new Map());
  }

  _emitUploads(error) {
    this.emit('uploads', { pending: this.pendingUploads, failed: this.failed.size, ...(error ? { error } : {}) });
  }

  /** Media files uploading right now. */
  get pendingUploads() {
    return this.uploads.size;
  }

  /** Media files not stored yet: uploading, or waiting to be tried again after a failure. */
  get unsavedMedia() {
    return this.uploads.size + this.failed.size;
  }

  /**
   * Wait for every media upload to finish, trying failed ones again now
   * (before the page or window closes). Resolves true when all are stored.
   */
  async flushUploads() {
    for (const { asset, blob } of [...this.failed.values()]) this._store(asset, blob);
    await Promise.allSettled([...this.uploads.values()]);
    return this.failed.size === 0;
  }

  /**
   * The assets whose media file is not in storage, from one listing of the
   * media folder. Files still being uploaded (or retried) are not missing.
   */
  async missingMedia(assets) {
    this._storedMedia(true);
    const stored = await this.stored.files;
    return assets.filter((a) => !stored.has(`${a.hash}.${a.ext}`) && !this.uploads.has(a.hash) && !this.failed.has(a.hash));
  }

  /**
   * The media file for an asset as a Blob (memory, then local cache, then
   * storage). keep: false reads it without holding it in memory afterwards.
   */
  async mediaBlob(asset, { keep = true } = {}) {
    const hit = this.blobs.get(asset.hash);
    if (hit) return hit;
    // Posters, waveforms, thumbnails and the player ask at once when a project opens: read it once.
    let read = this.reads.get(asset.hash);
    if (!read) {
      read = this._readMedia(asset).finally(() => this.reads.delete(asset.hash));
      this.reads.set(asset.hash, read);
    }
    const blob = await read;
    if (keep) this.blobs.set(asset.hash, blob);
    return blob;
  }

  async _readMedia(asset) {
    const path = this.mediaPath(asset);
    let blob = this.cache ? await this.cache.readBlob(path).catch(() => null) : null;
    if (!blob) {
      blob = await this.backend.readBlob(path);
      if (!blob) throw new Error(`Media file missing: ${asset.name}`);
      if (asset.mime && blob.type !== asset.mime) blob = new Blob([blob], { type: asset.mime });
      if (this.cache) this.cache.writeBlob(path, blob).catch(() => {});
    }
    return blob;
  }

  /** Object URL for an asset, created once and reused. */
  async mediaURL(asset) {
    const have = this.urls.get(asset.hash);
    if (have) return have;
    const blob = await this.mediaBlob(asset);
    const url = URL.createObjectURL(blob);
    this.urls.set(asset.hash, url);
    return url;
  }

  /* Color LUTs ------------------------------------------------------------------ */

  /** Imported LUTs, newest first. */
  async listLuts() {
    if (this.luts) return this.luts;
    // Shown as empty while it can't be read; read again next time.
    return this._readLuts().catch(() => []);
  }

  /** The stored LUT list. Rejects when it can't be read, so a change never replaces it with a shorter one. */
  async _readLuts() {
    if (this.luts) return this.luts;
    const list = await this.backend.readJSON('luts/index.json').catch((err) => {
      if (err instanceof SyntaxError) return null;
      throw err;
    });
    this.luts = (Array.isArray(list) ? list : [])
      .filter((x) => x && typeof x.id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(x.id))
      .map((x) => ({ id: x.id, name: String(x.name || 'LUT').slice(0, 120), kind: x.kind === '1d' ? '1d' : '3d', size: Number(x.size) || 0, added: Number(x.added) || 0 }));
    return this.luts;
  }

  /**
   * Import a .cube file: validate it, store it under its content hash and
   * add it to the LUT list. Returns { entry, lut } (lut is the parsed table).
   * Throws a readable error for files that are not valid LUTs.
   */
  async importLut(file) {
    const text = await file.text();
    const lut = parseCube(text);
    const id = await fingerprint(file);
    const entry = { id, name: lutName(lut, file.name), kind: lut.kind, size: lut.size, added: Date.now() };
    const list = await this._readLuts();
    await this.backend.writeBlob(`luts/${id}.cube`, new Blob([text], { type: 'text/plain' }));
    this.luts = [entry, ...list.filter((x) => x.id !== id)];
    await this.backend.writeJSON('luts/index.json', this.luts);
    this.emit('luts', this.luts);
    return { entry, lut };
  }

  /** The text of a stored LUT and its display name. */
  async readLut(id) {
    const blob = await this.backend.readBlob(`luts/${id}.cube`);
    if (!blob) throw new Error('LUT file missing');
    const entry = (await this.listLuts()).find((x) => x.id === id);
    return { text: await blob.text(), name: entry?.name || 'LUT' };
  }

  /** Forget a LUT (clips that use it render without it). */
  async removeLut(id) {
    const list = await this._readLuts();
    const next = list.filter((x) => x.id !== id);
    // The list changes only once the index is saved, so a failed write keeps them in step.
    await this.backend.writeJSON('luts/index.json', next);
    this.luts = next;
    await this.backend.remove(`luts/${id}.cube`).catch(() => {});
    this.emit('luts', this.luts);
  }

  /** Release cached blobs and URLs (when leaving the editor). */
  releaseMedia() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    // Keep blobs for files not stored yet: they are the only copy.
    for (const key of [...this.blobs.keys()]) if (!this.uploads.has(key) && !this.failed.has(key)) this.blobs.delete(key);
  }
}

/** Autosave: debounced writes after edits, with retry and status events. */
/**
 * A project write that hasn't answered after this long counts as failed for
 * the status and for leaving; it is still waited for before the next write
 * starts, so it can't land after a newer one.
 */
export const STALL_MS = 45_000;

export class AutoSaver extends Emitter {
  constructor(library, store, { delay = 1200 } = {}) {
    super();
    this.library = library;
    this.store = store;
    this.delay = delay;
    this.timer = null;
    this.saving = null;
    this.status = 'saved';
    this.lastSaved = Date.now();
    this.off = store.on('change', () => this.schedule());
  }

  schedule() {
    // A write that doesn't answer still blocks the next one: keep saying so.
    if (this.stalled) this._set('error', this.error);
    else this._set('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), this.delay);
  }

  _set(status, error) {
    this.status = status;
    this.emit('status', { status, error, at: this.lastSaved });
  }

  async save() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.saving) {
      // Several callers may be waiting (the timer, Save now, leaving): one goes next, the
      // others wait for it too. Two writes in flight could land out of order.
      while (this.saving) {
        await this._waitForSave();
        // Stalled: no new write beside it. It saves again when that write answers.
        if (this.stalled) {
          this._set('error', this.error);
          return;
        }
      }
      if (!this.store.dirty) return;
    }
    const revision = this.store.revision;
    const snapshot = this.store.projectForSave ? this.store.projectForSave() : structuredClone(this.store.project);
    this._set('saving');
    let wake;
    this._stallWake = new Promise((r) => (wake = r));
    const stall = setTimeout(() => {
      if (!this.saving) return;
      this.stalled = true;
      this.error = new Error('Saving is taking too long. Check your connection.');
      this._set('error', this.error);
      wake();
    }, STALL_MS);
    this.saving = this.library
      .saveProject(snapshot)
      .then(() => {
        this.store.savedRevision = Math.max(this.store.savedRevision, revision);
        this.lastSaved = Date.now();
        this._set(this.store.dirty ? 'pending' : 'saved');
        if (this.store.dirty) this.schedule();
      })
      .catch((err) => {
        console.error(err);
        this.error = err;
        this._set('error', err);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.save(), 8000);
      })
      .finally(() => {
        clearTimeout(stall);
        this.saving = null;
        this.stalled = false;
        wake();
      });
    return this._waitForSave();
  }

  /** The write in flight settling, or it being declared stalled, whichever comes first. */
  _waitForSave() {
    if (!this.saving || this.stalled) return Promise.resolve();
    return Promise.race([this.saving, this._stallWake]);
  }

  /**
   * Save pending edits now. Rejects when they could not be saved, so callers
   * leaving the editor can warn first (the retry keeps going meanwhile).
   */
  async flush() {
    if (this.timer || this.store.dirty) await this.save();
    else if (this.saving) await this._waitForSave();
    if ((this.status === 'error' || this.stalled) && this.store.dirty) throw this.error || new Error("Couldn't save your changes.");
  }

  dispose() {
    clearTimeout(this.timer);
    this.off();
  }
}
