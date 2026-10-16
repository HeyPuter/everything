// Linking, reloading, making local and library overrides as pure functions of documents, so they
// can be unit tested without the UI. A linked data-block keeps a stable id derived from its
// library and its id inside the library file (`<ref>~<library>`), so local data that uses it keeps
// working across reloads and the library file can change freely.
import type { CollectionData, DocumentData, ID, ObjectData, ObjectType, Vec3 } from '../data/types';
import { dataTables } from '../io/appenddata';
import { cloneShared } from '../data/cow';
import { newObject, uid } from '../data/defaults';
import type { LibraryData, LinkableID, OverrideLibrary } from './types';
import { lockRecord, WRITABLE_KEYS } from './readonly';

export type Rec = LinkableID & Record<string, unknown>;
type Tables = Record<string, Record<ID, Rec>>;
export const tablesOf = (doc: DocumentData) => doc as unknown as Tables;

export interface Pick {
  table: string;
  id: ID;
}

const SEP = '~';
/** Id of a data-block linked from library `libId` whose id inside the library file is `ref`. */
export const linkedId = (libId: ID, ref: ID) => `${ref}${SEP}${libId}`;
/** The id inside the library file of a linked data-block. */
export function refOf(id: ID, libId: ID): ID {
  const s = `${SEP}${libId}`;
  return id.endsWith(s) ? id.slice(0, -s.length) : id;
}

/** Fields that describe linking itself (not copied between files, not compared for overrides). */
const LINK_KEYS = new Set(['library', 'override_library', 'library_weak_reference']);
/** Fields an override keeps from itself when it is rebuilt from its reference. */
const KEEP_KEYS = new Set(['id', 'name', 'override_library', 'select', 'hide', 'users']);

/** Data-block tables that can be linked (every id table except the libraries themselves). */
export function idTables(doc: DocumentData): string[] {
  return dataTables(doc).filter((t) => t !== 'libraries' && t !== 'packed_files');
}

export function libraries(doc: DocumentData): Record<ID, LibraryData> {
  return ((doc as unknown as { libraries?: Record<ID, LibraryData> }).libraries ??= {});
}

export const isLinked = (rec: unknown): boolean => !!(rec as LinkableID | undefined)?.library;
export const libOf = (rec: unknown): ID | null => (rec as LinkableID | undefined)?.library ?? null;
export const isOverride = (rec: unknown): boolean => !!(rec as LinkableID | undefined)?.override_library;

/** The table holding a data-block id. */
export function tableOfId(doc: DocumentData, id: ID): string | undefined {
  const t = tablesOf(doc);
  for (const table of idTables(doc)) if (t[table]?.[id]) return table;
  return undefined;
}

export function recordOf(doc: DocumentData, id: ID): Rec | undefined {
  const table = tableOfId(doc, id);
  return table ? tablesOf(doc)[table][id] : undefined;
}

/** Every linked data-block of a document (optionally only those of one library). */
export function linkedRecords(doc: DocumentData, libId?: ID): { table: string; rec: Rec }[] {
  const out: { table: string; rec: Rec }[] = [];
  const t = tablesOf(doc);
  for (const table of idTables(doc)) for (const rec of Object.values(t[table] ?? {})) if (rec.library && (!libId || rec.library === libId)) out.push({ table, rec });
  return out;
}

/** Make every linked data-block of a document read-only. */
export function lockLinked(doc: DocumentData) {
  for (const { table, rec } of linkedRecords(doc)) lockRecord(rec, WRITABLE_KEYS[table]);
}

// ---------------------------------------------------------------------------
// id references

/** Every string inside a value (not descending into typed arrays), skipping link bookkeeping keys. */
function forEachString(v: unknown, fn: (s: string) => void, depth = 0) {
  if (typeof v === 'string') return fn(v);
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 40) return;
  if (Array.isArray(v)) for (const x of v) forEachString(x, fn, depth + 1);
  else for (const [k, x] of Object.entries(v)) if (k !== 'id' && !LINK_KEYS.has(k)) forEachString(x, fn, depth + 1);
}

/** Deep copy replacing strings found in `map`; typed arrays are shared (they are immutable). */
export function cloneRemap<T>(v: T, map: ReadonlyMap<string, string>, depth = 0): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as T;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 60) return v;
  if (Array.isArray(v)) return v.map((x) => cloneRemap(x, map, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === 'id' || LINK_KEYS.has(k) ? cloneShared(x) : cloneRemap(x, map, depth + 1);
  return out as T;
}

/** Replace id strings in place (in `v` and everything inside it). */
export function remapInPlace(v: unknown, map: ReadonlyMap<string, string>, depth = 0) {
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 60) return;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (typeof x === 'string') {
        const m = map.get(x);
        if (m !== undefined) v[i] = m;
      } else remapInPlace(x, map, depth + 1);
    }
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === 'id' || LINK_KEYS.has(k)) continue;
    if (typeof x === 'string') {
      const m = map.get(x);
      if (m !== undefined) (v as Record<string, unknown>)[k] = m;
    } else remapInPlace(x, map, depth + 1);
  }
}

/**
 * Remap id references in the local part of a document: local data-blocks, the scene and the
 * object order (linked data-blocks are read-only and keep their references).
 */
export function remapLocalUsers(doc: DocumentData, map: ReadonlyMap<string, string>) {
  if (!map.size) return;
  const t = tablesOf(doc);
  for (const table of idTables(doc)) for (const rec of Object.values(t[table] ?? {})) if (!rec.library) remapInPlace(rec, map);
  remapInPlace(doc.scene, map);
  doc.object_order = doc.object_order.map((id) => map.get(id) ?? id).filter((id, i, a) => a.indexOf(id) === i);
}

/** The picked data-blocks plus everything they reference (the source's scene collection excluded). */
export function closureOf(src: DocumentData, picks: Pick[]): Pick[] {
  const where = new Map<ID, string>();
  const t = tablesOf(src);
  for (const table of idTables(src)) for (const id of Object.keys(t[table] ?? {})) where.set(id, table);
  const master = src.scene?.collection;
  const out = new Map<ID, string>();
  const queue = picks.filter((p) => t[p.table]?.[p.id]).map((p) => p.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id) || id === master) continue;
    const table = where.get(id);
    if (!table) continue;
    out.set(id, table);
    forEachString(t[table][id], (s) => {
      if (s !== id && where.has(s) && !out.has(s)) queue.push(s);
    });
  }
  return [...out].map(([id, table]) => ({ table, id }));
}

// ---------------------------------------------------------------------------
// linking

/** Object type for object-data tables (used to instance linked object data). */
export const DATA_OBJECT_TYPE: Record<string, ObjectType> = {
  meshes: 'MESH',
  curves: 'CURVE',
  lights: 'LIGHT',
  cameras: 'CAMERA',
  armatures: 'ARMATURE',
  lattices: 'LATTICE',
  metaballs: 'META' as ObjectType,
  grease_pencils: 'GREASEPENCIL' as ObjectType,
};

export interface LinkOptions {
  /** collection that receives linked objects and created instances (default: scene collection) */
  into?: ID;
  /** picked collections are added through an Empty that instances them (else linked to the scene) */
  instance_collections?: boolean;
  /** picked object data (meshes, curves, …) get a new object that uses them */
  instance_object_data?: boolean;
  /** location of new instance objects */
  location?: Vec3;
}

export interface LinkResult {
  /** ids of the data-blocks that were added (newly linked), by table */
  added: Record<string, ID[]>;
  /** the local ids of the picked data-blocks */
  picked: Pick[];
  /** objects placed into the scene (linked objects and new instance objects) */
  placed: ID[];
  /** collections linked directly under the scene collection */
  collections: ID[];
  /** libraries created for data the source file links itself */
  indirect: ID[];
}

function uniqueObjectName(doc: DocumentData, base: string) {
  const taken = new Set(Object.values(doc.objects).map((o) => o.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** The local library for one the source file links itself (matched by its stored file). */
function indirectLibrary(target: DocumentData, srcLib: LibraryData, parent: ID, created: ID[]): LibraryData {
  const libs = libraries(target);
  const hit = Object.values(libs).find((l) => l.source.key === srcLib.source.key);
  if (hit) return hit;
  const lib: LibraryData = { ...cloneShared(srcLib), id: uid('li'), parent, is_missing: false };
  libs[lib.id] = lib;
  created.push(lib.id);
  return lib;
}

/** Local ids of source data-blocks when they are linked from `lib`. */
function linkMap(target: DocumentData, src: DocumentData, lib: LibraryData, picks: Pick[], indirect: ID[]): Map<ID, { table: string; local: ID; libId: ID }> {
  const st = tablesOf(src);
  const srcLibs = (src as unknown as { libraries?: Record<ID, LibraryData> }).libraries ?? {};
  const map = new Map<ID, { table: string; local: ID; libId: ID }>();
  for (const { table, id } of closureOf(src, picks)) {
    const rec = st[table][id];
    const via = rec.library && srcLibs[rec.library] ? indirectLibrary(target, srcLibs[rec.library], lib.id, indirect) : null;
    map.set(id, via ? { table, local: linkedId(via.id, refOf(id, rec.library!)), libId: via.id } : { table, local: linkedId(lib.id, id), libId: lib.id });
  }
  return map;
}

function linkedCopy(rec: Rec, idMap: ReadonlyMap<string, string>, local: ID, libId: ID): Rec {
  const copy = cloneRemap(rec, idMap);
  copy.id = local;
  copy.library = libId;
  delete copy.override_library;
  delete copy.library_weak_reference;
  delete copy.use_fake_user;
  return copy;
}

/**
 * Link the picked data-blocks of `src` (the decoded library file) into `target`. Everything they
 * use is linked too. Already linked data-blocks are reused.
 */
export function linkFromDoc(target: DocumentData, src: DocumentData, lib: LibraryData, picks: Pick[], opts: LinkOptions = {}): LinkResult {
  const libs = libraries(target);
  libs[lib.id] ??= lib;
  const indirect: ID[] = [];
  const map = linkMap(target, src, lib, picks, indirect);
  const idMap = new Map([...map].map(([k, v]) => [k, v.local]));
  const st = tablesOf(src),
    tt = tablesOf(target);
  const added: Record<string, ID[]> = {};
  for (const [id, { table, local, libId }] of map) {
    const dst = (tt[table] ??= {});
    if (dst[local]) continue;
    dst[local] = linkedCopy(st[table][id], idMap, local, libId);
    (added[table] ??= []).push(local);
  }
  for (const id of added.objects ?? []) if (!target.object_order.includes(id)) target.object_order.push(id);
  // place the picked data-blocks
  const master = target.collections[target.scene.collection];
  const into = (opts.into && target.collections[opts.into] && !isLinked(target.collections[opts.into]) ? target.collections[opts.into] : master) as CollectionData;
  const placed: ID[] = [];
  const collections: ID[] = [];
  const picked = picks.filter((p) => map.has(p.id)).map((p) => ({ table: p.table, id: map.get(p.id)!.local }));
  const instance = (name: string, type: ObjectType, data: ID | null, extra: Partial<ObjectData> = {}) => {
    const ob = newObject(uniqueObjectName(target, name), type, data);
    Object.assign(ob, extra);
    if (opts.location) ob.location = [...opts.location] as Vec3;
    target.objects[ob.id] = ob;
    target.object_order.push(ob.id);
    into.objects.push(ob.id);
    placed.push(ob.id);
    return ob;
  };
  for (const p of picked) {
    const rec = tt[p.table][p.id];
    if (p.table === 'objects') {
      const inScene = Object.values(target.collections).some((c) => !isLinked(c) && c.objects.includes(p.id));
      if (!inScene) into.objects.push(p.id);
      placed.push(p.id);
    } else if (p.table === 'collections') {
      if (opts.instance_collections) instance(rec.name, 'EMPTY', null, { instance_type: 'COLLECTION', instance_collection: p.id, empty_display_size: 1 });
      else if (!master.children.includes(p.id)) {
        master.children.push(p.id);
        collections.push(p.id);
      }
    } else if (DATA_OBJECT_TYPE[p.table] && opts.instance_object_data) {
      const type = p.table === 'curves' && typeof rec.body === 'string' ? ('FONT' as ObjectType) : DATA_OBJECT_TYPE[p.table];
      instance(rec.name, type, p.id);
    }
  }
  return { added, picked, placed, collections, indirect };
}

// ---------------------------------------------------------------------------
// reloading

export interface ReloadResult {
  updated: number;
  added: number;
  /** linked data-blocks the library file no longer has (their last data is kept) */
  missing: string[];
}

/**
 * Refresh the data-blocks linked from `libId` with the current content of the library file.
 * Local data keeps using them (ids are stable); overrides keep their own changes.
 */
export function reloadFromDoc(target: DocumentData, libId: ID, src: DocumentData): ReloadResult {
  const lib = libraries(target)[libId];
  const tt = tablesOf(target);
  const mine = linkedRecords(target, libId);
  const st = tablesOf(src);
  const missing: string[] = [];
  const picks: Pick[] = [];
  for (const { table, rec } of mine) {
    const ref = refOf(rec.id, libId);
    if (st[table]?.[ref]) picks.push({ table, id: ref });
    else missing.push(rec.name);
  }
  // remember what overrides changed against the old references
  const overrides = overrideGroups(target).filter((g) => g.members.some((m) => tt[m.table][m.reference]?.library === libId));
  const changes = overrides.map((g) => ({ g, changed: g.members.map((m) => overriddenKeys(target, m.table, m.id, g.map)) }));
  const indirect: ID[] = [];
  const map = linkMap(target, src, lib, picks, indirect);
  const idMap = new Map([...map].map(([k, v]) => [k, v.local]));
  let updated = 0,
    added = 0;
  for (const [id, { table, local, libId: owner }] of map) {
    const dst = (tt[table] ??= {});
    const old = dst[local];
    const fresh = linkedCopy(st[table][id], idMap, local, owner);
    if (old) {
      // view-layer state stays as the user left it
      for (const k of WRITABLE_KEYS[table] ?? []) if (k in old) fresh[k] = old[k];
      updated++;
    } else {
      added++;
      if (table === 'objects' && !target.object_order.includes(local)) target.object_order.push(local);
    }
    dst[local] = fresh;
  }
  for (const { g, changed } of changes) g.members.forEach((m, i) => rebuildOverride(target, m.table, m.id, g.map, changed[i]));
  lib.is_missing = false;
  return { updated, added, missing };
}

// ---------------------------------------------------------------------------
// making local

/**
 * Make linked data-blocks local: each gets a local copy that local users switch to. The linked
 * original is removed when no other linked data-block still uses it. Overrides simply stop being
 * overrides. Returns the map from linked to local ids.
 */
export function makeLocal(doc: DocumentData, ids: ID[]): Map<ID, ID> {
  const tt = tablesOf(doc);
  const map = new Map<ID, ID>();
  const copies: { table: string; rec: Rec }[] = [];
  for (const id of ids) {
    const table = tableOfId(doc, id);
    if (!table) continue;
    const rec = tt[table][id];
    if (rec.override_library) {
      delete rec.override_library;
      continue;
    }
    if (!rec.library || map.has(id)) continue;
    const lib = libraries(doc)[rec.library];
    const nid = uid(table.slice(0, 2));
    map.set(id, nid);
    const copy = cloneShared(rec) as Rec;
    copy.id = nid;
    delete copy.library;
    copy.library_weak_reference = lib ? { key: lib.source.key, ref: refOf(id, rec.library) } : null;
    const taken = new Set(Object.values(tt[table]).filter((x) => !x.library).map((x) => x.name));
    copy.name = uniqueLocalName(rec.name, taken);
    copies.push({ table, rec: copy });
  }
  for (const { table, rec } of copies) tt[table][rec.id] = rec;
  // local users (and the new copies) switch to the local data-blocks
  remapLocalUsers(doc, map);
  // a local copy of an object that sat only in a linked collection joins the scene
  const master = doc.collections[doc.scene.collection];
  for (const { table, rec } of copies) {
    if (table !== 'objects') continue;
    if (!Object.values(doc.collections).some((c) => !isLinked(c) && c.objects.includes(rec.id))) master.objects.push(rec.id);
    if (!doc.object_order.includes(rec.id)) doc.object_order.push(rec.id);
  }
  // linked originals nothing linked uses any more are dropped
  const doomed = new Set(map.keys());
  for (let changed = true; changed; ) {
    changed = false;
    const stillUsed = new Set<string>();
    for (const { rec } of linkedRecords(doc)) if (!doomed.has(rec.id)) forEachString(rec, (s) => stillUsed.add(s));
    for (const id of doomed)
      if (stillUsed.has(id)) {
        doomed.delete(id);
        changed = true;
      }
  }
  for (const old of doomed) delete tt[tableOfId(doc, old)!][old];
  // linked objects that stay (still used by linked data) keep their place in the object order
  doc.object_order = doc.object_order.filter((x) => doc.objects[x]);
  for (const id of Object.keys(doc.objects)) if (!doc.object_order.includes(id)) doc.object_order.push(id);
  dropUnusedLibraries(doc);
  return map;
}

function uniqueLocalName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const stem = name.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** Remove libraries that no data-block is linked from any more. */
export function dropUnusedLibraries(doc: DocumentData): number {
  const libs = libraries(doc);
  const used = new Set(linkedRecords(doc).map((x) => x.rec.library!));
  let n = 0;
  for (let pass = 0; pass < 4; pass++)
    for (const l of Object.values(libs)) {
      const child = Object.values(libs).some((c) => c.parent === l.id);
      if (!used.has(l.id) && !child) {
        delete libs[l.id];
        n++;
      }
    }
  return n;
}

/**
 * Ids made local by object.make_local for the given objects: the linked objects, plus their data
 * (`data`) and materials (`materials`).
 */
export function makeLocalTargets(doc: DocumentData, obIds: ID[], data: boolean, materials: boolean): ID[] {
  const out: ID[] = [];
  const add = (id: ID | null | undefined) => {
    if (id && !out.includes(id) && isLinked(recordOf(doc, id))) out.push(id);
  };
  for (const id of obIds) {
    const ob = doc.objects[id];
    if (!ob) continue;
    add(ob.id);
    if (data) add(ob.data);
    if (materials) {
      const d = ob.data ? (recordOf(doc, ob.data) as { materials?: (ID | null)[] } | undefined) : undefined;
      for (const m of d?.materials ?? []) add(m);
      for (const m of ob.object_materials ?? []) add(m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// deleting a library

/** Remove a library, everything linked from it (and from libraries used only through it). */
export function deleteLibrary(doc: DocumentData, libId: ID): number {
  const libs = libraries(doc);
  const doomed = new Set([libId, ...Object.values(libs).filter((l) => l.parent === libId).map((l) => l.id)]);
  const tt = tablesOf(doc);
  const gone = new Set<string>();
  for (const { table, rec } of linkedRecords(doc)) {
    if (!doomed.has(rec.library!)) continue;
    gone.add(rec.id);
    delete tt[table][rec.id];
  }
  // local objects using deleted object data go too
  for (const ob of Object.values(doc.objects))
    if (!isLinked(ob) && ob.data && gone.has(ob.data)) {
      gone.add(ob.id);
      delete doc.objects[ob.id];
    }
  scrubLocal(doc, gone);
  for (const id of doomed) delete libs[id];
  return gone.size;
}

/** Remove references to deleted ids from local data (arrays drop them, fields become null). */
export function scrubLocal(doc: DocumentData, gone: ReadonlySet<string>) {
  const scrub = (v: unknown, depth: number) => {
    if (depth > 40 || !v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--)
        if (typeof v[i] === 'string' && gone.has(v[i])) v.splice(i, 1);
        else scrub(v[i], depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id' || LINK_KEYS.has(k)) continue;
      if (typeof x === 'string' && gone.has(x)) (v as Record<string, unknown>)[k] = null;
      else scrub(x, depth + 1);
    }
  };
  const tt = tablesOf(doc);
  for (const table of idTables(doc)) for (const rec of Object.values(tt[table] ?? {})) if (!rec.library) scrub(rec, 0);
  scrub(doc.scene, 0);
  doc.object_order = doc.object_order.filter((id) => doc.objects[id]);
}

// ---------------------------------------------------------------------------
// library overrides

export interface OverrideMember {
  table: string;
  id: ID;
  reference: ID;
}
export interface OverrideGroup {
  root: ID;
  members: OverrideMember[];
  /** linked reference id → override id, for the whole hierarchy */
  map: Map<ID, ID>;
}

/** Overrides grouped by the hierarchy they were made with. */
export function overrideGroups(doc: DocumentData): OverrideGroup[] {
  const groups = new Map<ID, OverrideGroup>();
  const tt = tablesOf(doc);
  for (const table of idTables(doc))
    for (const rec of Object.values(tt[table] ?? {})) {
      const ov = rec.override_library;
      if (!ov) continue;
      const root = ov.hierarchy_root ?? rec.id;
      let g = groups.get(root);
      if (!g) groups.set(root, (g = { root, members: [], map: new Map() }));
      g.members.push({ table, id: rec.id, reference: ov.reference });
      g.map.set(ov.reference, rec.id);
    }
  return [...groups.values()];
}

function groupOf(doc: DocumentData, id: ID): OverrideGroup | undefined {
  return overrideGroups(doc).find((g) => g.members.some((m) => m.id === id));
}

const stable = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x));

/** Keys of an override that differ from its (remapped) linked reference. */
export function overriddenKeys(doc: DocumentData, table: string, id: ID, map?: ReadonlyMap<ID, ID>): string[] {
  const tt = tablesOf(doc);
  const rec = tt[table]?.[id];
  const ref = rec?.override_library ? tt[table][rec.override_library.reference] : undefined;
  if (!rec || !ref) return [];
  const m = map ?? groupOf(doc, id)?.map ?? new Map();
  const want = cloneRemap(ref, m);
  const keys = new Set([...Object.keys(rec), ...Object.keys(want)]);
  return [...keys].filter((k) => !KEEP_KEYS.has(k) && !LINK_KEYS.has(k) && !k.startsWith('_') && stable(rec[k]) !== stable(want[k]));
}

/** Rebuild an override from its reference, keeping the values of `keep` (its own changes). */
function rebuildOverride(doc: DocumentData, table: string, id: ID, map: ReadonlyMap<ID, ID>, keep: string[]) {
  const tt = tablesOf(doc);
  const rec = tt[table]?.[id];
  const ov = rec?.override_library as OverrideLibrary | undefined;
  const ref = ov ? tt[table][ov.reference] : undefined;
  if (!rec || !ref) return;
  const fresh = cloneRemap(ref, map) as Rec;
  for (const k of KEEP_KEYS) if (k in rec) fresh[k] = rec[k];
  for (const k of keep) {
    if (k in rec) fresh[k] = rec[k];
    else delete fresh[k];
  }
  delete fresh.library;
  tt[table][id] = fresh;
}

/** Objects and collections an override of `root` covers. */
function overrideScope(doc: DocumentData, table: string, root: ID): Pick[] {
  const out: Pick[] = [];
  const seen = new Set<string>();
  const addOb = (id: ID) => {
    if (seen.has(id) || !isLinked(doc.objects[id])) return;
    seen.add(id);
    out.push({ table: 'objects', id });
    // objects it depends on (parents, constraint / modifier targets) come along
    forEachString(doc.objects[id], (s) => {
      if (isLinked(doc.objects[s]) && libOf(doc.objects[s]) === libOf(doc.objects[id])) addOb(s);
    });
  };
  const addCol = (id: ID, depth: number) => {
    const c = doc.collections[id];
    if (!c || seen.has(id) || depth > 64 || !isLinked(c)) return;
    seen.add(id);
    out.push({ table: 'collections', id });
    for (const ch of c.children) addCol(ch, depth + 1);
    for (const o of c.objects) addOb(o);
  };
  if (table === 'collections') addCol(root, 0);
  else addOb(root);
  return out;
}

/**
 * Make a library override hierarchy for a linked collection or object: editable local copies of
 * the collections and objects (their object data stays linked). Local users switch to the
 * overrides; an Empty that instanced the collection is replaced by the override collection.
 * Returns the override id of the root (null when nothing could be overridden).
 */
export function makeOverride(doc: DocumentData, table: string, root: ID, opts: { instancer?: ID } = {}): ID | null {
  const tt = tablesOf(doc);
  if (!tt[table]?.[root]?.library) return null;
  const scope = overrideScope(doc, table, root);
  const map = new Map<ID, ID>();
  for (const p of scope) map.set(p.id, uid(p.table.slice(0, 2)));
  const rootOv = map.get(root)!;
  for (const p of scope) {
    const ref = tt[p.table][p.id];
    const ov = cloneRemap(ref, map) as Rec;
    ov.id = map.get(p.id)!;
    delete ov.library;
    ov.override_library = { reference: p.id, hierarchy_root: rootOv, is_system_override: p.table === 'collections' && p.id !== root };
    tt[p.table][ov.id] = ov;
    if (p.table === 'objects') doc.object_order.push(ov.id);
  }
  const inst = opts.instancer ? doc.objects[opts.instancer] : undefined;
  if (inst && table === 'collections') {
    // the override collection takes the place of the instancing Empty
    const holders = Object.values(doc.collections).filter((c) => !isLinked(c) && c.objects.includes(inst.id));
    for (const c of holders.length ? holders : [doc.collections[doc.scene.collection]]) if (!c.children.includes(rootOv)) c.children.push(rootOv);
    delete doc.objects[inst.id];
    scrubLocal(doc, new Set([inst.id]));
    remapLocalUsers(doc, new Map([...map].filter(([k]) => k !== root)));
  } else remapLocalUsers(doc, map);
  // overrides start out matching their references (and selected, like the data they replace)
  for (const p of scope) if (p.table === 'objects') tt.objects[map.get(p.id)!].select = !!tt.objects[p.id].select;
  return rootOv;
}

/** Restore overrides to their linked references (their own changes are dropped). */
export function resetOverrides(doc: DocumentData, ids: ID[]): number {
  let n = 0;
  for (const id of ids) {
    const table = tableOfId(doc, id);
    const g = groupOf(doc, id);
    if (!table || !g) continue;
    rebuildOverride(doc, table, id, g.map, []);
    n++;
  }
  return n;
}

/** Reset one overridden property of an override to its reference value. */
export function resetOverrideProperty(doc: DocumentData, id: ID, key: string): boolean {
  const table = tableOfId(doc, id);
  const g = groupOf(doc, id);
  if (!table || !g) return false;
  const keep = overriddenKeys(doc, table, id, g.map).filter((k) => k !== key);
  rebuildOverride(doc, table, id, g.map, keep);
  return true;
}

/**
 * Remove overrides: their users switch back to the linked references. Clearing the root of a
 * hierarchy clears the whole hierarchy.
 */
export function clearOverrides(doc: DocumentData, ids: ID[]): number {
  const tt = tablesOf(doc);
  const doomed = new Map<ID, ID>();
  for (const id of ids) {
    const g = groupOf(doc, id);
    if (!g) continue;
    const members = id === g.root ? g.members : g.members.filter((m) => m.id === id);
    for (const m of members) doomed.set(m.id, m.reference);
  }
  for (const [id] of doomed) {
    const table = tableOfId(doc, id);
    if (table) delete tt[table][id];
  }
  remapLocalUsers(doc, doomed);
  doc.object_order = doc.object_order.filter((id) => doc.objects[id]);
  return doomed.size;
}

/** Overrides of a hierarchy (the root's members) or the single ids given. */
export function hierarchyOf(doc: DocumentData, id: ID): ID[] {
  const g = groupOf(doc, id);
  return g ? g.members.map((m) => m.id) : [];
}

// ---------------------------------------------------------------------------
// stable ids for files whose reader makes up new ids on every read

/**
 * Give every data-block an id derived from its table and name (and nested elements such as
 * modifiers and nodes ids derived from their owner), so reading the same file twice gives the
 * same ids. Used for library files in foreign formats.
 */
export function stabilizeIds(doc: DocumentData): DocumentData {
  const tt = tablesOf(doc);
  const map = new Map<ID, ID>();
  const taken = new Set<string>();
  for (const table of idTables(doc))
    for (const rec of Object.values(tt[table] ?? {}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const base = `${table.slice(0, 2)}_${String(rec.name).replace(/[^\w.-]+/g, '_')}`;
      let id = base;
      for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
      taken.add(id);
      map.set(rec.id, id);
    }
  for (const table of idTables(doc)) {
    const out: Record<ID, Rec> = {};
    for (const rec of Object.values(tt[table] ?? {})) {
      const copy = cloneRemap(rec, map);
      copy.id = map.get(rec.id)!;
      // nested element ids (modifiers, constraints, nodes, links…) in traversal order
      const nested = new Map<string, string>();
      let n = 0;
      const collect = (v: unknown, depth: number) => {
        if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 40) return;
        if (Array.isArray(v)) return v.forEach((x) => collect(x, depth + 1));
        for (const [k, x] of Object.entries(v)) {
          if (k === 'id' && depth > 0 && typeof x === 'string' && !nested.has(x) && !map.has(x)) nested.set(x, `${copy.id}#${n++}`);
          else collect(x, depth + 1);
        }
      };
      collect(copy, 0);
      const rename = (v: unknown, depth: number) => {
        if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || depth > 40) return;
        const o = v as Record<string | number, unknown>;
        for (const k of Object.keys(o)) {
          const x = o[k];
          if (typeof x === 'string' && nested.has(x) && !(depth === 0 && k === 'id')) o[k] = nested.get(x);
          else rename(x, depth + 1);
        }
      };
      if (nested.size) rename(copy, 0);
      out[copy.id] = copy;
    }
    tt[table] = out;
  }
  remapInPlace(doc.scene, map);
  doc.object_order = doc.object_order.map((id) => map.get(id) ?? id);
  return doc;
}

// ---------------------------------------------------------------------------
// appending

export interface AppendOptions extends LinkOptions {
  /** library store key of the source file (remembered on appended data for reuse) */
  key?: string;
  /** make data the source file links from other files local too (else it stays linked) */
  use_recursive?: boolean;
  /** reuse data-blocks appended from the same file before instead of copying them again */
  do_reuse_local_id?: boolean;
  /** give the appended data-blocks a fake user */
  set_fake?: boolean;
  /** drop asset metadata from the appended data-blocks */
  clear_asset_data?: boolean;
}

/** Copy the picked data-blocks of `src` (and what they use) into `target` as local data. */
export function appendFromDoc(target: DocumentData, src: DocumentData, picks: Pick[], opts: AppendOptions = {}): LinkResult {
  const st = tablesOf(src),
    tt = tablesOf(target);
  const srcLibs = (src as unknown as { libraries?: Record<ID, LibraryData> }).libraries ?? {};
  const indirect: ID[] = [];
  const map = new Map<ID, { table: string; local: ID; copy: boolean; libId?: ID }>();
  const reusable = new Map<string, ID>();
  if (opts.do_reuse_local_id && opts.key)
    for (const table of idTables(target))
      for (const rec of Object.values(tt[table] ?? {})) if (!rec.library && rec.library_weak_reference?.key === opts.key) reusable.set(`${table}:${rec.library_weak_reference.ref}`, rec.id);
  for (const { table, id } of closureOf(src, picks)) {
    const rec = st[table][id];
    const reuse = reusable.get(`${table}:${id}`);
    if (reuse) map.set(id, { table, local: reuse, copy: false });
    else if (rec.library && srcLibs[rec.library] && !opts.use_recursive) {
      const via = indirectLibrary(target, srcLibs[rec.library], '', indirect);
      if (indirect.includes(via.id)) via.parent = null;
      map.set(id, { table, local: linkedId(via.id, refOf(id, rec.library)), copy: !tt[table]?.[linkedId(via.id, refOf(id, rec.library))], libId: via.id });
    } else map.set(id, { table, local: uid(id.split('_')[0] || table.slice(0, 2)), copy: true });
  }
  const idMap = new Map([...map].map(([k, v]) => [k, v.local]));
  const added: Record<string, ID[]> = {};
  const pickedIds = new Set(picks.map((p) => p.id));
  for (const [id, { table, local, copy, libId }] of map) {
    if (!copy) continue;
    const dst = (tt[table] ??= {});
    if (libId) {
      dst[local] = linkedCopy(st[table][id], idMap, local, libId);
    } else {
      const c = cloneRemap(st[table][id], idMap);
      c.id = local;
      delete c.library;
      delete c.override_library;
      c.library_weak_reference = opts.key ? { key: opts.key, ref: id } : null;
      const taken = new Set(Object.values(dst).map((x) => x.name));
      c.name = uniqueLocalName(c.name, taken);
      if (opts.set_fake && pickedIds.has(id)) c.use_fake_user = true;
      if (opts.clear_asset_data) delete c.asset_data;
      dst[local] = c;
    }
    (added[table] ??= []).push(local);
  }
  for (const id of added.objects ?? []) if (!target.object_order.includes(id)) target.object_order.push(id);
  // place the picked data-blocks
  const master = target.collections[target.scene.collection];
  const into = (opts.into && target.collections[opts.into] && !isLinked(target.collections[opts.into]) ? target.collections[opts.into] : master) as CollectionData;
  const appendedCols = new Set(added.collections ?? []);
  const inAppended = new Set([...appendedCols].flatMap((c) => tt.collections[c].objects as unknown as ID[]));
  const childOf = new Set([...appendedCols].flatMap((c) => tt.collections[c].children as unknown as ID[]));
  const placed: ID[] = [];
  const collections: ID[] = [];
  const picked = picks.filter((p) => map.has(p.id)).map((p) => ({ table: p.table, id: map.get(p.id)!.local }));
  for (const p of picked) {
    const rec = tt[p.table][p.id];
    if (p.table === 'objects') {
      if (!inAppended.has(p.id) && !Object.values(target.collections).some((c) => c.objects.includes(p.id))) into.objects.push(p.id);
      placed.push(p.id);
    } else if (p.table === 'collections') {
      if (opts.instance_collections) {
        const ob = newObject(uniqueObjectName(target, rec.name), 'EMPTY', null);
        Object.assign(ob, { instance_type: 'COLLECTION', instance_collection: p.id });
        if (opts.location) ob.location = [...opts.location] as Vec3;
        target.objects[ob.id] = ob;
        target.object_order.push(ob.id);
        into.objects.push(ob.id);
        placed.push(ob.id);
      } else if (!childOf.has(p.id) && !master.children.includes(p.id)) {
        master.children.push(p.id);
        collections.push(p.id);
        placed.push(...(tt.collections[p.id].objects as unknown as ID[]));
      }
    } else if (DATA_OBJECT_TYPE[p.table] && opts.instance_object_data) {
      const type = p.table === 'curves' && typeof rec.body === 'string' ? ('FONT' as ObjectType) : DATA_OBJECT_TYPE[p.table];
      const ob = newObject(uniqueObjectName(target, rec.name), type, p.id);
      if (opts.location) ob.location = [...opts.location] as Vec3;
      target.objects[ob.id] = ob;
      target.object_order.push(ob.id);
      into.objects.push(ob.id);
      placed.push(ob.id);
    }
  }
  return { added, picked, placed, collections, indirect };
}

/**
 * Rebuild override hierarchies from their linked references. The overrides' own changes are kept;
 * `enforce` also rebuilds the structure (which objects and collections a collection holds).
 */
export function resyncOverrides(doc: DocumentData, ids: ID[], enforce = false): number {
  let n = 0;
  const done = new Set<ID>();
  for (const id of ids) {
    const g = groupOf(doc, id);
    if (!g || done.has(g.root)) continue;
    done.add(g.root);
    for (const m of g.members) {
      const keep = overriddenKeys(doc, m.table, m.id, g.map).filter((k) => !enforce || (k !== 'objects' && k !== 'children'));
      rebuildOverride(doc, m.table, m.id, g.map, keep);
      n++;
    }
  }
  return n;
}
