// Scripting API for libraries: bpy.data.libraries (with load() for linking and appending from
// scripts), ID.library / ID.override_library / ID.is_missing / ID.make_local() and friends.
//
//   with bpy.data.libraries.load("props.p3d", link=True) as (data_from, data_to):
//       data_to.objects = [n for n in data_from.objects if n.startswith("Tree")]
//   for ob in data_to.objects: ...
import { app } from '../app/app';
import { fileEvents } from '../io/files';
import type { DocumentData, ID } from '../data/types';
import { IDStruct, bpyData, wrapId } from '../scripting/api';
import { PropCollection, kwMethod, pyError, touched, isIdWrapper } from '../scripting/rna';
import { decodeDocument, isNativeFile } from '../io/native';
import { appendFromDoc, deleteLibrary, idTables, libraries, linkFromDoc, lockLinked, makeLocal, makeOverride, recordOf, tableOfId, tablesOf, type Pick } from './core';
import { cacheSource, cachedInfo, cachedSource, cachedKeyByName, libraryFor, reloadLibraries, reportReload } from './runtime';
import { fingerprint, putStored, listStored } from './store';
import type { LibraryData } from './types';

// ---------------------------------------------------------------------------
// files scripts can name synchronously

/** Project files seen this session (opened, saved, or stored as libraries), by name. */
const seen = new Map<string, Uint8Array>();
const MAX_SEEN = 64 * 1024 * 1024;
function remember(name: string, bytes: Uint8Array) {
  seen.delete(name);
  seen.set(name, bytes);
  let total = 0;
  for (const [n, b] of [...seen].reverse()) {
    total += b.length;
    if (total > MAX_SEEN) seen.delete(n);
  }
}
fileEvents.opened.push((name, bytes) => remember(name, bytes));
fileEvents.saved.push((name, bytes) => remember(name, bytes));
void listStored()
  .then((all) => {
    for (const e of all) if (e.bytes.length < 16 * 1024 * 1024 && !seen.has(e.name)) seen.set(e.name, e.bytes);
  })
  .catch(() => {});

interface Source {
  key: string;
  doc: DocumentData;
  entry: { key: string; name: string; path: string; recentName?: string };
}

const baseName = (p: string) => p.replace(/^\/\//, '').split(/[\\/]/).pop() ?? p;

/** A library file a script refers to: a library of this file, a stored key or a project name. */
function resolveSource(path: string): Source {
  const libs = Object.values(libraries(app.doc));
  const lib = libs.find((l) => l.source.key === path || l.filepath === path || l.name === path || l.name === baseName(path));
  const key = lib?.source.key ?? (cachedSource(path) ? path : (cachedKeyByName(baseName(path)) ?? path));
  const cached = cachedSource(key);
  const info = cachedInfo(key);
  if (cached && info?.entry) return { key, doc: cached, entry: { key, name: info.entry.name, path: info.entry.path, recentName: info.entry.recentName } };
  if (lib?.packed_file?.length && isNativeFile(lib.packed_file)) {
    const doc = decodeDocument(lib.packed_file).doc;
    const entry = { key, name: lib.name, path: lib.filepath };
    cacheSource(key, doc, entry, fingerprint(lib.packed_file));
    return { key, doc, entry };
  }
  const name = lib?.name ?? baseName(path);
  const bytes = seen.get(name);
  if (bytes && isNativeFile(bytes)) {
    const k = lib?.source.key ?? `recent:${name}`;
    const doc = decodeDocument(bytes).doc;
    const entry = { key: k, name, path: lib?.filepath ?? `Recent/${name}`, recentName: k.startsWith('recent:') ? name : undefined };
    cacheSource(k, doc, entry, fingerprint(bytes));
    void putStored({ ...entry, bytes, time: Date.now() });
    return { key: k, doc, entry };
  }
  throw pyError('ValueError', `library file "${path}" is not available: open or save it in this browser first, or link from it once with File ▸ Link`);
}

// ---------------------------------------------------------------------------
// Library wrapper

class LibraryStruct {
  readonly __kind = 'struct';
  constructor(readonly __libId: ID) {}
  private get lib(): LibraryData {
    const l = libraries(app.doc)[this.__libId];
    if (!l) throw pyError('ReferenceError', 'the library was removed');
    return l;
  }
  get name() {
    return this.lib.name;
  }
  get filepath() {
    return this.lib.filepath;
  }
  get is_missing() {
    return !!this.lib.is_missing;
  }
  get packed_file() {
    return this.lib.packed_file?.length ? { size: this.lib.packed_file.length } : null;
  }
  get parent() {
    const p = this.lib.parent;
    return p && libraries(app.doc)[p] ? libraryWrapper(p) : null;
  }
  get users_id() {
    const out: unknown[] = [];
    const t = tablesOf(app.doc);
    for (const table of idTables(app.doc)) for (const r of Object.values(t[table] ?? {})) if (r.library === this.__libId) out.push(wrapId(table, r.id));
    return out;
  }
  get id_type() {
    return 'LIBRARY';
  }
  /** Read the library file again (asynchronously). */
  reload() {
    void reloadLibraries([this.__libId], { force: true }).then((s) => {
      if (s.reloaded.length) app.pushUndo('Reload Library');
      app.changed('doc');
      reportReload(s);
    });
  }
  get __key() {
    return `libraries:${this.__libId}`;
  }
  repr() {
    return `bpy.data.libraries[${JSON.stringify(this.lib.name)}]`;
  }
  toString() {
    return `<bpy_struct, Library("${this.lib.name}")>`;
  }
}

const libCache = new Map<ID, LibraryStruct>();
function libraryWrapper(id: ID) {
  let w = libCache.get(id);
  if (!w) libCache.set(id, (w = new LibraryStruct(id)));
  return w;
}

// ---------------------------------------------------------------------------
// bpy.data.libraries

/** Names of the local data-blocks of a library document, by bpy.data collection. */
function namesOf(doc: DocumentData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const t = tablesOf(doc);
  for (const table of idTables(doc)) out[table] = Object.values(t[table] ?? {}).filter((x) => !x.library && x.id !== doc.scene.collection).map((x) => x.name).sort();
  return out;
}

class LoadContext {
  readonly __kind = 'struct';
  private from: Record<string, string[]> = {};
  private to: Record<string, unknown[]> = {};
  constructor(
    private path: string,
    private link: boolean,
    private overrides: boolean,
  ) {}
  __enter__() {
    const src = resolveSource(this.path);
    this.from = namesOf(src.doc);
    this.to = Object.fromEntries(Object.keys(this.from).map((k) => [k, []]));
    const fromObj = { __kind: 'struct', ...this.from, toString: () => `<bpy_lib_from "${src.entry.name}">` };
    const toObj = { __kind: 'struct', ...this.to, toString: () => '<bpy_lib_to>' };
    this.toObj = toObj;
    return [fromObj, toObj];
  }
  private toObj: Record<string, unknown> | null = null;
  __exit__(failed?: boolean) {
    if (failed || !this.toObj) return false;
    const src = resolveSource(this.path);
    const t = tablesOf(src.doc);
    const picks: Pick[] = [];
    const order: { table: string; name: string }[] = [];
    for (const table of Object.keys(this.from)) {
      const want = this.toObj[table];
      if (!Array.isArray(want)) continue;
      for (const n of want) {
        const name = typeof n === 'string' ? n : isIdWrapper(n) ? String((recordOf(app.doc, n.__id) ?? { name: '' }).name) : String(n);
        const rec = Object.values(t[table] ?? {}).find((x) => x.name === name && !x.library);
        if (!rec) throw pyError('KeyError', `"${name}" is not in ${table} of "${src.entry.name}"`);
        picks.push({ table, id: rec.id });
        order.push({ table, name });
      }
    }
    const doc = app.doc;
    let res;
    if (this.link) {
      const lib = libraryFor(doc, src.entry);
      // scripts place nothing in the scene: they decide what to do with the data
      res = linkFromDoc(doc, src.doc, lib, picks, { place: false });
      libraries(doc)[lib.id].revision = cachedInfo(src.key)?.fp;
      if (this.overrides) for (const p of res.picked) if (p.table === 'collections' || p.table === 'objects') makeOverride(doc, p.table, p.id);
    } else {
      res = appendFromDoc(doc, src.doc, picks, { key: src.key, use_recursive: true, place: false });
    }
    lockLinked(doc);
    // data_to now holds the data-blocks
    const byTable: Record<string, unknown[]> = {};
    res.picked.forEach((p, i) => (byTable[order[i]?.table ?? p.table] ??= []).push(wrapId(p.table, p.id)));
    for (const table of Object.keys(this.from)) this.toObj[table] = byTable[table] ?? [];
    touched();
    return false;
  }
}

class LibrariesCollection extends PropCollection<LibraryStruct> {
  constructor() {
    super('bpy.data.libraries');
  }
  list() {
    return Object.values(libraries(app.doc))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => libraryWrapper(l.id));
  }
  nameOf(l: LibraryStruct) {
    return l.name;
  }
  /** Context manager linking or appending data-blocks picked by name. */
  load(filepath: string, link = false, relative = false, assets_only = false, create_liboverride = false) {
    void relative;
    void assets_only;
    if (typeof filepath !== 'string' || !filepath) throw pyError('TypeError', 'load() expects a file path');
    return new LoadContext(filepath, !!link, !!create_liboverride);
  }
  remove(lib: unknown) {
    if (!(lib instanceof LibraryStruct)) throw pyError('TypeError', 'expected a Library');
    deleteLibrary(app.doc, lib.__libId);
    lockLinked(app.doc);
    touched();
  }
}
kwMethod(LibrariesCollection.prototype, 'load', ['filepath', 'link', 'relative', 'assets_only', 'create_liboverride']);
bpyData.libraries = new LibrariesCollection();

// ---------------------------------------------------------------------------
// ID members

const raw = (w: IDStruct) => w.__raw as unknown as { library?: string | null; override_library?: { reference: string; hierarchy_root?: string; is_system_override?: boolean } | null; library_weak_reference?: { key: string; ref: string } | null };

Object.defineProperties(IDStruct.prototype, {
  library: {
    get(this: IDStruct) {
      const l = raw(this).library;
      return l && libraries(app.doc)[l] ? libraryWrapper(l) : null;
    },
    configurable: true,
  },
  is_missing: {
    get(this: IDStruct) {
      const l = raw(this).library;
      return !!(l && libraries(app.doc)[l]?.is_missing);
    },
    configurable: true,
  },
  is_editable: {
    get(this: IDStruct) {
      return !raw(this).library;
    },
    configurable: true,
  },
  is_library_indirect: {
    get(this: IDStruct) {
      const l = raw(this).library;
      return !!(l && libraries(app.doc)[l]?.parent);
    },
    configurable: true,
  },
  override_library: {
    get(this: IDStruct) {
      const o = raw(this).override_library;
      if (!o) return null;
      const table = tableOfId(app.doc, o.reference);
      return {
        __kind: 'struct',
        reference: table ? wrapId(table, o.reference) : null,
        hierarchy_root: o.hierarchy_root ? wrapId(tableOfId(app.doc, o.hierarchy_root) ?? this.__table, o.hierarchy_root) : null,
        is_system_override: !!o.is_system_override,
        toString: () => '<bpy_struct, IDOverrideLibrary>',
      };
    },
    configurable: true,
  },
  library_weak_reference: {
    get(this: IDStruct) {
      const w = raw(this).library_weak_reference;
      return w ? { __kind: 'struct', filepath: w.key, id_name: w.ref, toString: () => '<bpy_struct, LibraryWeakReference>' } : null;
    },
    configurable: true,
  },
});

/** Make a linked data-block (or an override) local; returns the local data-block. */
function make_local(this: IDStruct) {
  const r = raw(this);
  if (!r.library && !r.override_library) return this;
  const map = makeLocal(app.doc, [this.__id]);
  lockLinked(app.doc);
  touched();
  const nid = map.get(this.__id) ?? this.__id;
  return wrapId(this.__table, nid);
}

/** Make a library override of a linked object or collection (with its hierarchy); returns it. */
function override_hierarchy_create(this: IDStruct) {
  if (!raw(this).library) throw pyError('RuntimeError', `"${String(this.__raw.name)}" is not linked`);
  if (this.__table !== 'objects' && this.__table !== 'collections') throw pyError('TypeError', 'only objects and collections can be overridden');
  const root = makeOverride(app.doc, this.__table, this.__id);
  lockLinked(app.doc);
  touched();
  return root ? wrapId(this.__table, root) : null;
}

Object.defineProperty(IDStruct.prototype, 'make_local', { value: make_local, writable: true, configurable: true });
Object.defineProperty(IDStruct.prototype, 'override_hierarchy_create', { value: override_hierarchy_create, writable: true, configurable: true });
Object.defineProperty(IDStruct.prototype, 'override_create', { value: override_hierarchy_create, writable: true, configurable: true });

export { LibraryStruct, resolveSource };
