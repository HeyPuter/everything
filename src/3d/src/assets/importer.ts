// Bringing assets into a document: copy a data-block and everything it uses from a library
// document ("Append"), optionally reusing data appended earlier from the same library
// ("Append (Reuse Data)"), then place it (objects at a point, collections as a whole or as an
// instance). Pure document functions; the operators in ops.ts call them on the open file.
import type { CollectionData, DocumentData, ID, ObjectData } from '../data/types';
import { uid, newObject } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { dependencyClosure, type Pick } from '../io/appenddata';
import { blockOf, tableOf, type AssetBlock, type AssetTable } from './types';
import type { ImportMethod } from './library';

/** Data appended from a library remembers where it came from ("library/id"), for reuse. */
export interface SourceStamp {
  asset_source?: string;
}

function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const base = name.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

/** Deep copy replacing strings found in `map` (typed arrays are shared). */
function cloneRemap<T>(v: T, map: Map<string, string>): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as T;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return v.map((x) => cloneRemap(x, map)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneRemap(x, map);
  return out as T;
}

const PREFIX: Record<string, string> = { objects: 'ob', collections: 'co', meshes: 'me', curves: 'cu', lights: 'la', cameras: 'ca', armatures: 'ar', lattices: 'lt', materials: 'ma', worlds: 'wo', images: 'im', actions: 'ac', node_groups: 'ng', particles: 'pa', texts: 'tx', brushes: 'br', fonts: 'vf', grease_pencils: 'gp', metaballs: 'mb' };

export interface CopyOptions {
  /** id of existing data to use instead of copying a dependency */
  reuse?: (table: string, srcId: ID) => ID | undefined;
  /** stamp copies with `${stamp}/${srcId}` */
  stamp?: string;
  /** keep the asset mark on a copied block (default: only on the picked ones) */
  keepAsset?: (table: string, srcId: ID) => boolean;
}

export interface CopyResult {
  /** source id → id in the target (copied or reused) */
  map: Map<ID, ID>;
  /** newly created blocks */
  added: { table: string; id: ID }[];
}

/** Copy picked data-blocks and their dependencies from `src` into `target` (nothing is linked to the scene). */
export function copyDatablocks(target: DocumentData, src: DocumentData, picks: Pick[], opts: CopyOptions = {}): CopyResult {
  const all = dependencyClosure(src, picks);
  const picked = new Set(picks.map((p) => p.id));
  const map = new Map<ID, ID>();
  const reused = new Set<ID>();
  for (const { table, id } of all) {
    const r = opts.reuse?.(table, id);
    if (r) {
      map.set(id, r);
      reused.add(id);
    } else map.set(id, uid(PREFIX[table] ?? table.slice(0, 2)));
  }
  const st = src as unknown as Record<string, Record<ID, AssetBlock & SourceStamp>>;
  const tt = target as unknown as Record<string, Record<ID, AssetBlock & SourceStamp>>;
  const added: { table: string; id: ID }[] = [];
  for (const { table, id } of all) {
    if (reused.has(id)) continue;
    const dst = (tt[table] ??= {});
    const taken = new Set(Object.values(dst).map((x) => x.name));
    const copy = cloneRemap(st[table][id], map);
    copy.id = map.get(id)!;
    copy.name = uniqueName(copy.name, taken);
    if (opts.stamp) copy.asset_source = `${opts.stamp}/${id}`;
    const keep = opts.keepAsset ? opts.keepAsset(table, id) : picked.has(id);
    if (!keep) delete copy.asset_data;
    if ('use_fake_user' in copy && !keep) copy.use_fake_user = false;
    dst[copy.id] = copy;
    added.push({ table, id: copy.id });
    if (table === 'objects' && !target.object_order.includes(copy.id)) target.object_order.push(copy.id);
  }
  return { map, added };
}

/** Find data appended earlier from the same library item. */
export function findStamped(doc: DocumentData, table: string, stamp: string): ID | undefined {
  const t = tableOf(doc, table) as Record<ID, AssetBlock & SourceStamp> | undefined;
  if (!t) return undefined;
  for (const b of Object.values(t)) if (b.asset_source === stamp) return b.id;
  return undefined;
}

export interface ImportedAsset {
  table: AssetTable;
  /** id of the asset's data-block in the target */
  id: ID;
  /** new objects that must be linked into the scene (besides the asset itself) */
  objects: ID[];
  /** whether a new block was created for the asset itself */
  created: boolean;
}

/**
 * Bring one asset from a library document into `target`. Objects and collections always get new
 * copies (their data may be reused); other types are reused as a whole with APPEND_REUSE.
 */
export function importAsset(target: DocumentData, src: DocumentData, libraryId: string, table: AssetTable, id: ID, method: ImportMethod): ImportedAsset | null {
  if (!blockOf(src, table, id)) return null;
  const reuseAll = method === 'APPEND_REUSE';
  const alwaysNew = table === 'objects' || table === 'collections';
  if (reuseAll && !alwaysNew) {
    const prev = findStamped(target, table, `${libraryId}/${id}`);
    if (prev) return { table, id: prev, objects: [], created: false };
  }
  // objects inside an appended collection are always new as well (they are its contents)
  const inside = new Set<ID>();
  if (table === 'collections') for (const o of collectionObjects(src, id)) inside.add(o);
  const res = copyDatablocks(target, src, [{ table, id }], {
    stamp: libraryId,
    // appended data is ordinary data of the file, not an asset of it
    keepAsset: () => false,
    reuse: reuseAll ? (t, sid) => (sid === id || inside.has(sid) || (t === 'collections' && table === 'collections') ? undefined : findStamped(target, t, `${libraryId}/${sid}`)) : undefined,
  });
  const nid = res.map.get(id)!;
  const pickedObject = table === 'objects' ? nid : null;
  const inCollections = new Set<ID>();
  for (const a of res.added) if (a.table === 'collections') for (const o of target.collections[a.id]?.objects ?? []) inCollections.add(o);
  const objects = res.added.filter((a) => a.table === 'objects' && a.id !== pickedObject && !inCollections.has(a.id)).map((a) => a.id);
  return { table, id: nid, objects, created: true };
}

/** Every object inside a collection and its child collections. */
export function collectionObjects(doc: DocumentData, id: ID, seen = new Set<ID>()): ID[] {
  const c = doc.collections[id];
  if (!c || seen.has(id)) return [];
  seen.add(id);
  return [...c.objects, ...c.children.flatMap((ch) => collectionObjects(doc, ch, seen))];
}

/** A copy of an object of the same document (with its own object data, sharing materials). */
export function duplicateObjectData(doc: DocumentData, obId: ID): ID | null {
  const ob = doc.objects[obId];
  if (!ob) return null;
  const copy = cloneShared(ob) as ObjectData & { asset_data?: unknown };
  delete copy.asset_data;
  copy.id = uid('ob');
  copy.name = uniqueName(ob.name, new Set(Object.values(doc.objects).map((o) => o.name)));
  const tables: Record<string, string> = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', LIGHT: 'lights', CAMERA: 'cameras', ARMATURE: 'armatures', LATTICE: 'lattices', META: 'metaballs', GREASEPENCIL: 'grease_pencils' };
  const t = tables[ob.type];
  const src = t && ob.data ? tableOf(doc, t)?.[ob.data] : undefined;
  if (src) {
    const d = cloneShared(src);
    d.id = uid(t.slice(0, 2));
    d.name = uniqueName(src.name, new Set(Object.values(tableOf(doc, t)!).map((x) => x.name)));
    tableOf(doc, t)![d.id] = d;
    copy.data = d.id;
  }
  copy.modifiers = copy.modifiers.map((m) => ({ ...m, id: uid('md') }));
  copy.constraints = copy.constraints.map((c) => ({ ...c, id: uid('cn') }));
  copy.parent = null;
  doc.objects[copy.id] = copy;
  doc.object_order.push(copy.id);
  return copy.id;
}

/** Link objects into a collection and make the first one active and selected. */
export function placeObjects(doc: DocumentData, ids: ID[], collection: ID, location?: number[]) {
  const col = doc.collections[collection] ?? doc.collections[doc.scene.collection];
  for (const o of Object.values(doc.objects)) o.select = false;
  for (const id of ids) {
    const ob = doc.objects[id];
    if (!ob) continue;
    if (!col.objects.includes(id)) col.objects.push(id);
    ob.select = true;
  }
  const first = doc.objects[ids[0]];
  if (first && location) first.location = [location[0], location[1], location[2]];
  if (first) doc.scene.active_object = first.id;
}

/** Link a collection under `parent` and move its top-level objects so its origin lands at `location`. */
export function placeCollection(doc: DocumentData, id: ID, parent: ID, location: number[]) {
  const col: CollectionData | undefined = doc.collections[id];
  const into = doc.collections[parent] ?? doc.collections[doc.scene.collection];
  if (!col) return;
  if (!into.children.includes(id)) into.children.push(id);
  const objs = collectionObjects(doc, id);
  const inSet = new Set(objs);
  const off = col.instance_offset ?? [0, 0, 0];
  const d = [location[0] - off[0], location[1] - off[1], location[2] - off[2]];
  for (const o of Object.values(doc.objects)) o.select = false;
  for (const oid of objs) {
    const ob = doc.objects[oid];
    if (!ob) continue;
    ob.select = true;
    if (ob.parent && inSet.has(ob.parent)) continue;
    ob.location = [ob.location[0] + d[0], ob.location[1] + d[1], ob.location[2] + d[2]];
  }
  if (objs[0]) doc.scene.active_object = objs[0];
}

/** An empty that instances a collection, at `location`. */
export function addCollectionInstance(doc: DocumentData, id: ID, parent: ID, location: number[]): ID | null {
  const col = doc.collections[id];
  if (!col) return null;
  const ob = newObject(uniqueName(col.name, new Set(Object.values(doc.objects).map((o) => o.name))), 'EMPTY', null);
  ob.instance_type = 'COLLECTION';
  ob.instance_collection = id;
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  placeObjects(doc, [ob.id], parent, location);
  return ob.id;
}
