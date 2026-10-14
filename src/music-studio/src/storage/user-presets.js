// User presets for effects and instruments ("My presets"), grouped by kind:
// 'effect:<type>' or 'instrument:<type>'. A preset is
// { id, kind, name, params, updated } (updated: ms since epoch).
//
// They always live in localStorage. When the user is signed in to Puter they
// are also kept in one small JSON file in the app's own folder
// (Presets/presets.json): merged on startup and on sign-in, and written a
// moment after each change (one write for a burst of edits). Merging keeps
// the newest version of each preset id; deletions are kept as tombstones for
// a while so they reach other devices instead of coming back. Nothing touches
// Puter while signed out.
//
//   const presets = userPresets(app)      // one store per app
//   presets.list('effect:eq'); presets.save('effect:eq', 'Bright', params)
//   presets.on('change', () => ...)

import { Emitter } from '../lib/emitter.js';
import { uid } from '../lib/util.js';
import * as puter from './puter.js';

const KEY = 'music-studio:presets';
export const PRESETS_DIR = 'Presets';
export const PRESETS_FILE = 'presets.json';
const FORMAT = 'music-studio-presets';
const TOMBSTONE_MS = 180 * 24 * 3600 * 1000;
export const MAX_NAME = 60;

export class UserPresets extends Emitter {
  /**
   * `storage`: a localStorage-like object. `delay`: ms to wait after a change
   * before writing the cloud file. `api`: the Puter wrapper (tests swap it).
   */
  constructor({ storage = globalThis.localStorage, delay = 1500, now = () => Date.now(), api = puter } = {}) {
    super();
    this.storage = storage;
    this.delay = delay;
    this.now = now;
    this.api = api;
    this.items = new Map(); // id -> preset (tombstones have deleted: true)
    this.timer = null;
    this.syncing = null;
    this.again = false;
    this.lastError = null;
    this.#load();
  }

  // ---------------------------------------------------------------- reading

  /** Live presets of a kind, sorted by name. */
  list(kind) {
    const out = [];
    for (const p of this.items.values()) if (p.kind === kind && !p.deleted) out.push(p);
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id));
  }

  get(id) {
    const p = this.items.get(id);
    return p && !p.deleted ? p : null;
  }

  /** The live preset of `kind` called `name` (case-insensitive), or null. */
  findByName(kind, name) {
    const n = cleanName(name).toLowerCase();
    return this.list(kind).find((p) => p.name.toLowerCase() === n) || null;
  }

  // ---------------------------------------------------------------- editing

  /** Saves `params` as a preset. A preset of the same kind and name is replaced (same id). */
  save(kind, name, params) {
    const n = cleanName(name);
    if (!n || !kind) return null;
    const old = this.findByName(kind, n);
    const p = { id: old?.id || `pr-${uid(10)}`, kind, name: n, params: cleanParams(params), updated: this.#stamp(old) };
    this.items.set(p.id, p);
    this.#changed();
    return p;
  }

  rename(id, name) {
    const p = this.get(id);
    const n = cleanName(name);
    if (!p || !n || n === p.name) return p;
    const next = { ...p, name: n, updated: this.#stamp(p) };
    this.items.set(id, next);
    this.#changed();
    return next;
  }

  remove(id) {
    const p = this.get(id);
    if (!p) return false;
    this.items.set(id, { id, kind: p.kind, name: p.name, deleted: true, updated: this.#stamp(p) });
    this.#changed();
    return true;
  }

  /**
   * Merges presets from elsewhere (the cloud file): the newest version of
   * each id wins (ties keep ours). Returns { changed, stale }: whether ours
   * changed, and whether the other side lacks something we have.
   */
  merge(list) {
    let changed = false;
    const theirs = new Map(); // id -> updated
    for (const raw of Array.isArray(list) ? list : []) {
      const p = normalize(raw);
      if (!p || (p.deleted && p.updated < this.now() - TOMBSTONE_MS)) continue;
      theirs.set(p.id, p.updated);
      const ours = this.items.get(p.id);
      if (!ours || p.updated > ours.updated) {
        this.items.set(p.id, p);
        changed = true;
      }
    }
    let stale = false;
    for (const [id, ours] of this.items) {
      if (!theirs.has(id) || ours.updated > theirs.get(id)) {
        stale = true;
        break;
      }
    }
    if (changed) {
      this.#prune();
      this.#persist();
      this.emit('change');
    }
    return { changed, stale };
  }

  /** The file content for the cloud copy. */
  toJSON() {
    return { format: FORMAT, version: 1, presets: [...this.items.values()] };
  }

  // ---------------------------------------------------------------- cloud

  /** Writes the cloud file `delay` ms after the last change (signed in only). */
  schedule() {
    if (!this.api.isSignedIn()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sync().catch(() => {});
    }, this.delay);
  }

  /** Runs a pending write now. */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.sync().catch(() => {});
    } else if (this.syncing) {
      await this.syncing.catch(() => {});
    }
  }

  /**
   * Reads the cloud file, merges it and writes it back when it lacks
   * anything we have. Does nothing while signed out. When the file cannot be
   * read (other than "not found") nothing is written, so a network error
   * never replaces presets saved on another device.
   */
  async sync() {
    if (!this.api.isSignedIn()) return false;
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.again = false;
          await this.#syncOnce();
        } while (this.again && this.api.isSignedIn());
        this.lastError = null;
        return true;
      } catch (err) {
        this.lastError = err;
        throw err;
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async #syncOnce() {
    const path = this.api.joinPath(await this.api.appSubdir(PRESETS_DIR), PRESETS_FILE);
    let remote = [];
    let exists = true;
    try {
      const blob = await this.api.readFile(path);
      const data = JSON.parse(await blob.text());
      remote = data?.format === FORMAT && Array.isArray(data.presets) ? data.presets : [];
    } catch (err) {
      if (err instanceof SyntaxError) remote = []; // a damaged file is replaced
      else if (err?.code === 'subject_does_not_exist' || err?.status === 404) exists = false;
      else throw err;
    }
    const { stale } = this.merge(remote);
    if (stale || (!exists && this.items.size)) await this.api.writeFile(path, JSON.stringify(this.toJSON()));
  }

  // ---------------------------------------------------------------- internals

  #stamp(old) {
    // Strictly newer than the version it replaces, even with a coarse clock.
    return Math.max(this.now(), (old?.updated || 0) + 1);
  }

  #changed() {
    this.#prune();
    this.#persist();
    this.emit('change');
    this.schedule();
  }

  #prune() {
    const cutoff = this.now() - TOMBSTONE_MS;
    for (const [id, p] of this.items) if (p.deleted && p.updated < cutoff) this.items.delete(id);
  }

  #load() {
    try {
      const data = JSON.parse(this.storage?.getItem(KEY) || 'null');
      for (const raw of data?.presets || []) {
        const p = normalize(raw);
        if (p) this.items.set(p.id, p);
      }
    } catch {
      // Damaged or blocked storage: start empty.
    }
  }

  #persist() {
    try {
      this.storage?.setItem(KEY, JSON.stringify({ version: 1, presets: [...this.items.values()] }));
    } catch {
      // Storage full or blocked: keep them for this session.
    }
  }
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) if (Number.isFinite(v)) out[k] = v;
  return out;
}

/** A preset from storage or the cloud file, checked and cleaned; null when unusable. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.kind !== 'string') return null;
  const updated = Number(raw.updated) || 0;
  if (raw.deleted) return { id: raw.id, kind: raw.kind, name: cleanName(raw.name), deleted: true, updated };
  const name = cleanName(raw.name);
  if (!name) return null;
  return { id: raw.id, kind: raw.kind, name, params: cleanParams(raw.params), updated };
}

/**
 * The app's preset store, created on first use. Syncs with the cloud on
 * startup and whenever the account changes (sign-in), and flushes a pending
 * write when the page is hidden.
 */
export function userPresets(app) {
  if (app.userPresets) return app.userPresets;
  const store = new UserPresets({ storage: app.prefs?.storage });
  app.userPresets = store;
  const pull = () => {
    if (puter.isSignedIn()) store.sync().catch((err) => console.warn('Music Studio: presets could not sync with Puter.', err));
  };
  app.on?.('account', pull);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') store.flush();
    });
  }
  pull();
  return store;
}
