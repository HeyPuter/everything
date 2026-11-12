/**
 * Libraries: personal collections of reusable assets (colors, gradients,
 * graphics, character and paragraph styles, graphic styles) that are
 * available in every document. Each library is one JSON file:
 *
 *   { format: 'vector-studio-library', version: 1, id, name, modified,
 *     items: [{ id, kind, name, data, thumb? }] }
 *
 * kinds and their data:
 *   color           { paint }                         a solid paint
 *   gradient        { paint }                         a linear/radial paint
 *   graphic         { items: [subtree], bounds, assets }  artwork (as the clipboard stores it)
 *   characterStyle  { char }                          character attributes
 *   paragraphStyle  { para }                          paragraph attributes
 *   graphicStyle    { style }                         fill, stroke, effects, ...
 *   text            { text }                          plain text
 *
 * Libraries live in the user's Puter cloud (app data folder "libraries")
 * when signed in, else in this browser's private storage, so they follow
 * the user across devices whenever possible.
 */
import { puterBackend, opfsBackend, opfsAvailable, memoryBackend } from '../files/backends.js';
import { uid } from '../../lib/ids.js';
import { repairNode } from '../files/format.js';

export const ITEM_KINDS = ['color', 'gradient', 'graphic', 'characterStyle', 'paragraphStyle', 'graphicStyle', 'text'];

export const KIND_LABELS = {
  color: 'Colors',
  gradient: 'Gradients',
  graphic: 'Graphics',
  characterStyle: 'Character Styles',
  paragraphStyle: 'Paragraph Styles',
  graphicStyle: 'Graphic Styles',
  text: 'Text',
};

export function newLibrary(name) {
  return { format: 'vector-studio-library', version: 1, id: uid('lib'), name, modified: Date.now(), items: [] };
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A subtree ({ root, nodes }, first node the root) repaired as opening a
 * file repairs nodes: nodes without an id or type are dropped, child lists
 * keep only nodes of the subtree (each node in one place), nodes nothing
 * reaches are left out. Returns { sub, repaired } or null when the root is
 * unusable.
 */
function repairSubtree(sub) {
  if (!isObject(sub) || !Array.isArray(sub.nodes)) return null;
  const byId = new Map();
  let repaired = false;
  for (const n of sub.nodes) {
    const usable = isObject(n) && typeof n.id === 'string' && typeof n.type === 'string';
    if (!usable || n.type === 'root' || byId.has(n.id)) {
      repaired = true;
      continue;
    }
    const fixed = repairNode(n);
    if (fixed !== n) repaired = true;
    byId.set(n.id, fixed);
  }
  const first = sub.nodes[0];
  const root = isObject(first) ? byId.get(first.id) : null;
  if (!root) return null;
  const nodes = [];
  const seen = new Set([root.id]);
  const visit = (n, parent) => {
    let out = parent && n.parent !== parent ? { ...n, parent } : n;
    if (Array.isArray(n.children)) {
      const kids = [];
      for (const c of n.children) {
        if (typeof c !== 'string' || !byId.has(c) || seen.has(c)) continue;
        seen.add(c);
        kids.push(c);
      }
      if (kids.length !== n.children.length) {
        repaired = true;
        out = { ...out, children: kids };
      }
      nodes.push(out);
      for (const c of kids) visit(byId.get(c), n.id);
    } else nodes.push(out);
  };
  visit(root, null);
  if (nodes.length !== sub.nodes.length) repaired = true;
  return { sub: { ...sub, root: root.id, nodes }, repaired };
}

/**
 * A library graphic's data repaired so placing it only adds sound objects
 * (repairable damage is repaired, unusable artwork left out), or null when
 * nothing usable is left. `stats.repaired` counts repaired graphics.
 */
export function repairGraphic(data, stats = {}) {
  if (!Array.isArray(data.items)) return null;
  let repaired = false;
  const items = [];
  for (const it of data.items) {
    const r = repairSubtree(it);
    if (!r || r.repaired) repaired = true;
    if (r) items.push(r.sub);
  }
  if (!items.length) return null;
  const out = { ...data, items };
  if (data.symbols !== undefined) {
    // Symbol definitions the instances use: one that cannot be used would break them all.
    if (!Array.isArray(data.symbols)) return null;
    const symbols = [];
    for (const sym of data.symbols) {
      const r = repairSubtree(sym);
      if (!r || r.sub.nodes[0].type !== 'group' || !isObject(r.sub.nodes[0].symbolDef)) return null;
      if (r.repaired) repaired = true;
      symbols.push(r.sub);
    }
    out.symbols = symbols;
  }
  if (data.assets !== undefined) {
    const assets = {};
    for (const [id, a] of Object.entries(isObject(data.assets) ? data.assets : {})) {
      if (isObject(a) && typeof a.data === 'string') assets[id] = a;
    }
    if (Object.keys(assets).length !== Object.keys(data.assets || {}).length) repaired = true;
    out.assets = assets;
  }
  if (repaired) stats.repaired = (stats.repaired || 0) + 1;
  return out;
}

/**
 * A clean library object from parsed JSON, or null when it is not one.
 * Damaged graphics are repaired or left out; `stats` counts them
 * ({ repaired, skipped }).
 */
export function normalizeLibrary(data, stats = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  const items = [];
  for (const it of data.items) {
    if (!it || !ITEM_KINDS.includes(it.kind) || !isObject(it.data)) continue;
    const itemData = it.kind === 'graphic' ? repairGraphic(it.data, stats) : it.data;
    if (!itemData) {
      stats.skipped = (stats.skipped || 0) + 1;
      continue;
    }
    items.push({
      id: String(it.id || uid('li')),
      kind: it.kind,
      name: String(it.name || '').slice(0, 200),
      data: itemData,
      ...(typeof it.thumb === 'string' ? { thumb: it.thumb } : {}),
    });
  }
  return {
    format: 'vector-studio-library',
    version: 1,
    id: typeof data.id === 'string' && data.id ? data.id : uid('lib'),
    name: String(data.name || 'Library').slice(0, 120),
    modified: Number(data.modified) || Date.now(),
    items,
  };
}

/** Where libraries with edits not yet written are kept when the page goes away (localStorage). */
const JOURNAL = 'vs-libraries-unwritten';

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export class LibraryStore {
  /**
   * `backend` overrides the storage choice (tests), and `journal` the
   * localStorage key for edits not yet written (none for a fixed backend).
   */
  constructor(app, backend = null, { journal = backend ? null : JOURNAL } = {}) {
    this.app = app;
    this.fixed = backend;
    this.journalKey = journal;
    this.unwritten = new Map(); // library id -> { lib, rev }: edits not yet confirmed written
    this.revs = new Map(); // library id -> edit count
    this.libraries = [];
    this.loaded = false;
    this.loading = null;
    this.loadingFrom = null;
    this.loadToken = null;
    this.listeners = new Set();
    this.pending = new Map(); // library id -> { timer, lib, backend }: a write waiting to merge quick edits
    this.queues = new Map(); // library id -> the last queued write or removal
  }

  get backend() {
    if (this.fixed) return this.fixed;
    const puter = this.app.puter;
    const cloud = Boolean(puter?.fs && (this.app.env === 'app' || this.app.user));
    const key = cloud ? 'cloud' : opfsAvailable() ? 'local' : 'memory';
    if (key !== this.backendKey) {
      this.backendKey = key;
      this.cachedBackend = key === 'cloud' ? puterBackend(puter, 'libraries') : key === 'local' ? opfsBackend('vector-studio-libraries') : memoryBackend();
      this.loaded = false;
    }
    return this.cachedBackend;
  }

  /** Where libraries are kept, for the panel's footnote. */
  get location() {
    void this.backend;
    return this.fixed ? 'memory' : this.backendKey;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn();
  }

  async load(force = false) {
    const backend = this.backend;
    if (this.loaded && !force) return this.libraries;
    // A load from the same storage serves this call; one from storage left behind (signing in or out) does not.
    if (this.loading && this.loadingFrom === backend) return this.loading;
    const token = {};
    this.loadToken = token;
    this.loadingFrom = backend;
    this.loading = (async () => {
      let libs = [];
      try {
        const files = (await backend.list('')).filter((f) => !f.isDir && f.name.endsWith('.json'));
        for (const f of files) {
          try {
            const lib = normalizeLibrary(await backend.readJSON(f.name));
            if (lib) libs.push(lib);
          } catch {
            // A damaged library file is skipped; the others still load.
          }
        }
        libs.sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        libs = [];
      }
      // Superseded by a load from other storage: that one's libraries are the ones to show.
      if (this.loadToken !== token) return this.loading || this.libraries;
      this.libraries = libs;
      this.#recoverJournal(backend);
      this.loaded = true;
      this.loading = null;
      this.#emit();
      return this.libraries;
    })();
    return this.loading;
  }

  get(id) {
    return this.libraries.find((l) => l.id === id) || null;
  }

  /** Run a storage operation on one library after the ones already queued for it, so they land in order. */
  #queue(id, fn) {
    const next = (this.queues.get(id) || Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => {});
    this.queues.set(id, tail);
    tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  #write(lib, backend) {
    return this.#queue(lib.id, async () => {
      const rev = this.revs.get(lib.id);
      await backend.writeJSON(`${lib.id}.json`, lib);
      // Written, unless it was edited again meanwhile (that write is queued).
      if (this.unwritten.get(lib.id)?.rev === rev) this.unwritten.delete(lib.id);
    });
  }

  /**
   * Keep the libraries whose edits are not written yet in localStorage,
   * which is written at once: storage writes started while the page is
   * closing may never finish. The next load writes them back.
   */
  #writeJournal() {
    const ls = this.journalKey && storage();
    if (!ls) return;
    try {
      if (!this.unwritten.size) ls.removeItem(this.journalKey);
      else ls.setItem(this.journalKey, JSON.stringify({ location: this.location, libraries: [...this.unwritten.values()].map((u) => u.lib) }));
    } catch {
      // Over the storage quota (large graphics): the regular write is all there is.
    }
  }

  /** Bring back edits a closed page could not write (see #writeJournal). */
  #recoverJournal(backend) {
    const ls = this.journalKey && storage();
    let data = null;
    try {
      data = JSON.parse(ls?.getItem(this.journalKey) || 'null');
    } catch {
      data = null;
    }
    if (!data || data.location !== this.location || !Array.isArray(data.libraries)) return;
    const writes = [];
    for (const raw of data.libraries) {
      const lib = normalizeLibrary(raw);
      if (!lib || typeof raw.id !== 'string') continue;
      const i = this.libraries.findIndex((l) => l.id === lib.id);
      if (i >= 0 && this.libraries[i].modified >= lib.modified) continue;
      if (i >= 0) this.libraries[i] = lib;
      else this.libraries.push(lib);
      this.#mark(lib);
      writes.push(this.#write(lib, backend));
    }
    this.libraries.sort((a, b) => a.name.localeCompare(b.name));
    // Once written (or found to be older than what was written), the journal is done with.
    Promise.allSettled(writes).then(() => this.#writeJournal());
  }

  #mark(lib) {
    const rev = (this.revs.get(lib.id) || 0) + 1;
    this.revs.set(lib.id, rev);
    this.unwritten.set(lib.id, { lib, rev });
  }

  async save(lib, { immediate = false } = {}) {
    lib.modified = Date.now();
    this.#mark(lib);
    this.#emit();
    clearTimeout(this.pending.get(lib.id)?.timer);
    this.pending.delete(lib.id);
    // Written where libraries were kept when the edit was made, even if signing in or out switches it meanwhile.
    const backend = this.backend;
    if (immediate) return this.#write(lib, backend);
    // Quick successive edits (adding several items) are written once.
    const timer = setTimeout(() => this.flush(lib.id), 400);
    this.pending.set(lib.id, { timer, lib, backend });
    return undefined;
  }

  /**
   * Write edits still waiting to be merged now (all libraries, or one), and
   * resolve once everything queued has been written. When the page is
   * hidden or closed (`hiding`), edits not written yet are also kept in
   * localStorage, so a change made just before is not lost.
   */
  flush(id = null, { hiding = false } = {}) {
    for (const [key, p] of [...this.pending]) {
      if (id && key !== id) continue;
      clearTimeout(p.timer);
      this.pending.delete(key);
      this.#write(p.lib, p.backend).catch((err) => this.app.notify?.(`Could not save the library: ${err?.message || err}`, { error: true }));
    }
    if (hiding) this.#writeJournal();
    return Promise.all([...this.queues.values()]);
  }

  async create(name) {
    const lib = newLibrary(name);
    this.libraries.push(lib);
    this.libraries.sort((a, b) => a.name.localeCompare(b.name));
    await this.save(lib, { immediate: true });
    return lib;
  }

  async remove(id) {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
    if (this.unwritten.delete(id)) this.#writeJournal();
    this.libraries = this.libraries.filter((l) => l.id !== id);
    const backend = this.backend;
    // After any write still in flight, which would otherwise bring the file back.
    await this.#queue(id, () => backend.remove(`${id}.json`));
    this.#emit();
  }

  async rename(id, name) {
    const lib = this.get(id);
    if (!lib) return;
    lib.name = name;
    this.libraries.sort((a, b) => a.name.localeCompare(b.name));
    await this.save(lib, { immediate: true });
  }

  async duplicate(id) {
    const src = this.get(id);
    if (!src) return null;
    const copy = { ...JSON.parse(JSON.stringify(src)), id: uid('lib'), name: `${src.name} copy` };
    copy.items = copy.items.map((it) => ({ ...it, id: uid('li') }));
    this.libraries.push(copy);
    this.libraries.sort((a, b) => a.name.localeCompare(b.name));
    await this.save(copy, { immediate: true });
    return copy;
  }

  /** Add items ({ kind, name, data, thumb }) to a library. Returns the stored items. */
  addItems(id, items) {
    const lib = this.get(id);
    if (!lib) return [];
    const added = items.map((it) => ({ id: uid('li'), kind: it.kind, name: it.name || '', data: it.data, ...(it.thumb ? { thumb: it.thumb } : {}) }));
    lib.items.push(...added);
    this.save(lib);
    return added;
  }

  removeItems(id, itemIds) {
    const lib = this.get(id);
    if (!lib) return;
    const drop = new Set(itemIds);
    lib.items = lib.items.filter((it) => !drop.has(it.id));
    this.save(lib);
  }

  renameItem(id, itemId, name) {
    const it = this.get(id)?.items.find((x) => x.id === itemId);
    if (!it) return;
    it.name = name;
    this.save(this.get(id));
  }

  /**
   * Import a library from parsed JSON (a new id, so it never replaces one).
   * `stats` receives the number of damaged graphics repaired and skipped.
   */
  async importLibrary(data, stats = {}) {
    const lib = normalizeLibrary(data, stats);
    if (!lib) throw new Error('This file is not a Vector Studio library.');
    lib.id = uid('lib');
    if (this.libraries.some((l) => l.name === lib.name)) lib.name = `${lib.name} (imported)`;
    this.libraries.push(lib);
    this.libraries.sort((a, b) => a.name.localeCompare(b.name));
    await this.save(lib, { immediate: true });
    return lib;
  }
}
