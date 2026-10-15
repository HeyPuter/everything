// Append data-blocks from another project into the current one (File ▸ Append…): the picked
// data-blocks and everything they reference are copied with new ids and unique names.
import type { DocumentData, ID } from '../data/types';
import { uid } from '../data/defaults';

const NOT_TABLES = new Set(['scene', 'version', 'mode', 'object_order']);

/** Names of the data-block tables of a document (objects, meshes, materials, …). */
export function dataTables(doc: DocumentData): string[] {
  return Object.entries(doc)
    .filter(([k, v]) => !NOT_TABLES.has(k) && v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && Object.values(v as object).every((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string'))
    .map(([k]) => k);
}

type Tables = Record<string, Record<ID, { id: ID; name: string }>>;
const tablesOf = (doc: DocumentData) => doc as unknown as Tables;

/** Every string inside a value (not descending into typed arrays). */
function forEachString(v: unknown, fn: (s: string) => void, seen = new Set<object>()) {
  if (typeof v === 'string') return fn(v);
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) for (const x of v) forEachString(x, fn, seen);
  else for (const x of Object.values(v)) forEachString(x, fn, seen);
}

/** Deep copy replacing strings found in `map`; typed arrays are shared (they are immutable). */
function cloneRemap<T>(v: T, map: Map<string, string>): T {
  if (typeof v === 'string') return (map.get(v) ?? v) as T;
  if (!v || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return v.map((x) => cloneRemap(x, map)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneRemap(x, map);
  return out as T;
}

export interface Pick {
  table: string;
  id: ID;
}

/** The picked data-blocks plus everything they reference, as table/id pairs. */
export function dependencyClosure(src: DocumentData, picks: Pick[]): Pick[] {
  const where = new Map<ID, string>();
  const t = tablesOf(src);
  for (const table of dataTables(src)) for (const id of Object.keys(t[table])) where.set(id, table);
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

function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name;
  const base = name.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!taken.has(n)) return n;
  }
}

export interface AppendResult {
  /** new ids of all appended data-blocks, by table */
  added: Record<string, ID[]>;
  /** new ids of the appended objects that were linked into the scene */
  linkedObjects: ID[];
  /** new ids of appended collections linked under the scene collection */
  linkedCollections: ID[];
}

/**
 * Copy the picked data-blocks (and their dependencies) from `src` into `target`. Picked
 * collections are linked under the scene collection; objects that are not inside an appended
 * collection go to `intoCollection` (default: the scene collection).
 */
export function appendDatablocks(target: DocumentData, src: DocumentData, picks: Pick[], intoCollection?: ID): AppendResult {
  const all = dependencyClosure(src, picks);
  const st = tablesOf(src),
    tt = tablesOf(target);
  const map = new Map<string, string>();
  for (const { id } of all) map.set(id, uid(id.split('_')[0] || 'id'));
  const added: Record<string, ID[]> = {};
  for (const { table, id } of all) {
    const dst = (tt[table] ??= {});
    const taken = new Set(Object.values(dst).map((x) => x.name));
    const copy = cloneRemap(st[table][id], map);
    copy.id = map.get(id)!;
    copy.name = uniqueName(copy.name, taken);
    dst[copy.id] = copy;
    (added[table] ??= []).push(copy.id);
  }
  // scene linking
  const master = target.collections[target.scene.collection];
  const into = target.collections[intoCollection ?? ''] ?? master;
  const pickedCollections = new Set(picks.filter((p) => p.table === 'collections').map((p) => map.get(p.id)).filter(Boolean) as ID[]);
  // objects inside any appended collection stay there (e.g. a collection used for instancing)
  const inCollections = new Set<ID>((added.collections ?? []).flatMap((c) => target.collections[c].objects));
  // collections that are children of other appended collections are not linked at the top
  const childOfAppended = new Set((added.collections ?? []).flatMap((c) => target.collections[c].children));
  const linkedCollections = [...pickedCollections].filter((c) => !childOfAppended.has(c));
  for (const c of linkedCollections) if (!master.children.includes(c)) master.children.push(c);
  const linkedObjects: ID[] = [];
  for (const oid of added.objects ?? []) {
    if (!target.object_order.includes(oid)) target.object_order.push(oid);
    if (inCollections.has(oid)) continue;
    into.objects.push(oid);
    linkedObjects.push(oid);
  }
  return { added, linkedObjects, linkedCollections };
}
