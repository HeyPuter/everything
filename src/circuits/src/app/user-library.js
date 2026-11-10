// "My library": components the user created, available in every project.
// Kept as one library file in the user's Puter storage, or in this browser's
// private storage when signed out.

import { Emitter } from '../core/emitter.js';
import { puter, cloudAvailable, isMissing } from './puter.js';
import { LIBRARY_FORMAT } from '../model/schema.js';

const CLOUD_PATH = 'Libraries/My components.circuitslib';
const LOCAL_FILE = 'my-components.circuitslib';

async function localDir() {
  if (!navigator.storage?.getDirectory) return null;
  try { return await navigator.storage.getDirectory(); } catch { return null; }
}

export class UserLibrary extends Emitter {
  constructor() {
    super();
    this.defs = new Map();
    this.loaded = false;
  }

  all() { return [...this.defs.values()]; }

  /** Text of the stored library; throws when there is none or it cannot be read. */
  async _read() {
    if (cloudAvailable()) return (await puter().fs.read(CLOUD_PATH)).text();
    const dir = await localDir();
    return dir ? (await (await dir.getFileHandle(LOCAL_FILE)).getFile()).text() : null;
  }

  _parse(text) {
    const out = [];
    if (!text) return out;
    try {
      const data = JSON.parse(text);
      if (data.format === LIBRARY_FORMAT) for (const d of data.components || []) if (d?.id && d.symbol) out.push(d);
    } catch { /* ignore a damaged file */ }
    return out;
  }

  load() {
    // Changes made while this runs wait for it (see put), or the load would
    // drop them after they had already replaced the stored file.
    const loading = this._load().finally(() => { if (this._loading === loading) this._loading = null; });
    this._loading = loading;
    return loading;
  }

  async _load() {
    let text = null;
    // A library that exists but could not be read must not be replaced by
    // the next save (see _save).
    this._unread = false;
    try {
      text = await this._read();
    } catch (err) {
      if (!isMissing(err) && err?.name !== 'NotFoundError') {
        this._unread = true;
        console.warn('Could not load My library', err);
      }
    }
    this.defs.clear();
    for (const d of this._parse(text)) this.defs.set(d.id, d);
    this.loaded = true;
    this.emit('change');
  }

  async put(def) {
    while (this._loading) await this._loading;
    this.defs.set(def.id, structuredClone(def));
    this.emit('change');
    await this._save();
  }

  async remove(id) {
    while (this._loading) await this._loading;
    if (!this.defs.delete(id)) return;
    this.emit('change');
    await this._save();
  }

  /** Saves one after another, so an older slow write cannot land on top of a newer one. */
  _save() {
    this._saving = (this._saving || Promise.resolve()).then(() => this._write());
    return this._saving;
  }

  async _write() {
    try {
      if (this._unread) {
        // Loading failed earlier (offline, a server error): read the stored
        // library now and keep its components. If it still cannot be read,
        // nothing is written, or the file would lose everything but the
        // components changed in this session.
        let stored = null;
        try { stored = await this._read(); } catch (err) { if (!isMissing(err)) throw err; }
        let added = false;
        for (const d of this._parse(stored)) if (!this.defs.has(d.id)) { this.defs.set(d.id, d); added = true; }
        this._unread = false;
        if (added) this.emit('change');
      }
      const text = JSON.stringify({ format: LIBRARY_FORMAT, version: 1, name: 'My components', components: this.all() });
      if (cloudAvailable()) await puter().fs.write(CLOUD_PATH, text, { overwrite: true, createMissingParents: true });
      else {
        const dir = await localDir();
        if (!dir) return;
        const w = await (await dir.getFileHandle(LOCAL_FILE, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
    } catch (err) { console.warn('Could not save My library', err); }
  }
}
