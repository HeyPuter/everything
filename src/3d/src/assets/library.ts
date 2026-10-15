// Asset libraries: "Current File" (the open document), "Essentials" (built-in, read-only) and
// user libraries kept in the browser's storage. A user library is stored as a project document
// that holds its assets, everything they depend on and its catalog list; it is loaded on first
// use and written back (debounced) after every change.
import type { DocumentData, ID } from '../data/types';
import { emptyDocument } from '../data/defaults';
import { cloneShared } from '../data/cow';
import { app } from '../app/app';
import { encodeDocument, decodeDocument } from '../io/native';
import { kvGet, kvSet } from '../io/session';
import { dependencyClosure, dataTables, type Pick } from '../io/appenddata';
import { copyDatablocks } from './importer';
import { essentialsDocument } from './essentials';
import { mergeCatalogs, newUUID } from './catalogs';
import { ASSET_TABLES, assetsOf, blockOf, tableOf, type AssetBlock, type AssetCatalog, type AssetTable } from './types';

export const LOCAL = 'LOCAL';
export const ESSENTIALS = 'ESSENTIALS';

export type ImportMethod = 'APPEND' | 'APPEND_REUSE';

export interface LibraryInfo {
  id: string;
  name: string;
  kind: 'LOCAL' | 'ESSENTIALS' | 'USER';
  /** assets and catalogs can be edited */
  editable: boolean;
  /** default import method of the library */
  import_method: ImportMethod;
}

interface StoredEntry {
  id: string;
  name: string;
  import_method?: ImportMethod;
}

interface Loaded {
  doc: DocumentData | null;
  loading?: Promise<void>;
  error?: string;
  /** catalog edit history (Undo / Redo Catalog Edits) */
  undo: string[];
  redo: string[];
}

let entries: StoredEntry[] = [];
const loaded = new Map<string, Loaded>();
const listeners = new Set<() => void>();
let indexLoaded: Promise<void> | null = null;
let indexReady = false;
/** bumps on every library change (cache keys) */
export let libraryRevision = 0;

export function onLibrariesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyLibraries() {
  libraryRevision++;
  for (const fn of listeners) fn();
}

const libKey = (id: string) => `asset-lib:${id}`;

/** Load the list of user libraries (once). */
export function loadLibraryIndex(): Promise<void> {
  indexLoaded ??= (async () => {
    try {
      entries = ((await kvGet<StoredEntry[]>('asset-libs')) ?? []).filter((e) => e && typeof e.id === 'string');
    } catch {
      entries = [];
    }
    indexReady = true;
    notifyLibraries();
  })();
  return indexLoaded;
}

const saveIndex = () => void kvSet('asset-libs', entries).catch(() => {});

export function libraries(): LibraryInfo[] {
  return [
    { id: LOCAL, name: 'Current File', kind: 'LOCAL', editable: true, import_method: 'APPEND' },
    { id: ESSENTIALS, name: 'Essentials', kind: 'ESSENTIALS', editable: false, import_method: 'APPEND_REUSE' },
    ...entries.map((e) => ({ id: e.id, name: e.name, kind: 'USER' as const, editable: true, import_method: e.import_method ?? 'APPEND_REUSE' })),
  ];
}

export function userLibraries(): LibraryInfo[] {
  return libraries().filter((l) => l.kind === 'USER');
}

export function libraryInfo(id: string): LibraryInfo | undefined {
  return libraries().find((l) => l.id === id);
}

function emptyLibraryDoc(): DocumentData {
  const doc = emptyDocument();
  doc.brushes = {};
  doc.asset_catalogs = [];
  return doc;
}

/** A library's document; null while a user library is still loading (it is loaded in the background). */
export function libraryDoc(id: string): DocumentData | null {
  if (id === LOCAL) return app.doc;
  if (id === ESSENTIALS) return essentialsDocument();
  const st = state(id);
  if (!st.doc && !st.loading && !st.error && entries.some((e) => e.id === id)) st.loading = loadLibrary(id);
  return st.doc;
}

/** Wait until a library's document is available. */
export async function ensureLibrary(id: string): Promise<DocumentData | null> {
  if (id === LOCAL || id === ESSENTIALS) return libraryDoc(id);
  await loadLibraryIndex();
  libraryDoc(id);
  await state(id).loading;
  return state(id).doc;
}

function state(id: string): Loaded {
  let st = loaded.get(id);
  if (!st) loaded.set(id, (st = { doc: null, undo: [], redo: [] }));
  return st;
}

async function loadLibrary(id: string) {
  const st = state(id);
  try {
    const bytes = await kvGet<Uint8Array>(libKey(id));
    st.doc = bytes ? decodeDocument(bytes).doc : emptyLibraryDoc();
    st.doc.asset_catalogs ??= [];
  } catch (e) {
    st.error = e instanceof Error ? e.message : String(e);
    st.doc = null;
  }
  st.loading = undefined;
  notifyLibraries();
}

export function libraryError(id: string) {
  return loaded.get(id)?.error;
}

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

/** Write a user library back to storage (debounced). */
export function saveLibrary(id: string, immediate = false): Promise<void> {
  if (id === LOCAL || id === ESSENTIALS) return Promise.resolve();
  const st = loaded.get(id);
  if (!st?.doc) return Promise.resolve();
  clearTimeout(pendingSaves.get(id));
  const write = () => {
    pendingSaves.delete(id);
    return kvSet(libKey(id), encodeDocument(st.doc!)).then(() => undefined, () => undefined);
  };
  if (immediate) return write();
  return new Promise((res) => pendingSaves.set(id, setTimeout(() => void write().then(res), 250)));
}

/** Changes to a library's document: redraw, and persist user libraries. */
export function libraryChanged(id: string) {
  if (id === LOCAL) {
    app.changed('doc');
  } else void saveLibrary(id);
  notifyLibraries();
}

export async function createLibrary(name: string): Promise<string> {
  await loadLibraryIndex();
  const id = `lib_${newUUID().slice(0, 8)}`;
  const taken = new Set(entries.map((e) => e.name.toLowerCase()));
  let n = name.trim() || 'User Library';
  for (let i = 1; taken.has(n.toLowerCase()); i++) n = `${name.trim() || 'User Library'} ${i + 1}`;
  entries.push({ id, name: n });
  const st = state(id);
  st.doc = emptyLibraryDoc();
  saveIndex();
  await saveLibrary(id, true);
  notifyLibraries();
  return id;
}

export function renameLibrary(id: string, name: string) {
  const e = entries.find((x) => x.id === id);
  if (!e || !name.trim()) return false;
  e.name = name.trim();
  saveIndex();
  notifyLibraries();
  return true;
}

export function setLibraryImportMethod(id: string, method: ImportMethod) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.import_method = method;
  saveIndex();
  notifyLibraries();
}

export async function deleteLibrary(id: string) {
  const i = entries.findIndex((x) => x.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  loaded.delete(id);
  saveIndex();
  await kvSet(libKey(id), null);
  notifyLibraries();
  return true;
}

/** Reload user libraries from storage and rebuild previews (Refresh). */
export async function refreshLibrary(id: string) {
  if (id === LOCAL || id === ESSENTIALS) return notifyLibraries();
  indexLoaded = null;
  await loadLibraryIndex();
  const st = state(id);
  st.doc = null;
  st.error = undefined;
  st.loading = loadLibrary(id);
  await st.loading;
}

/** The catalogs of a library (read only: edits go through `doc.asset_catalogs`). */
export function libraryCatalogs(id: string): AssetCatalog[] {
  return libraryDoc(id)?.asset_catalogs ?? [];
}

/** Whether the list of user libraries has been read from storage. */
export const libraryIndexReady = () => indexReady;

// ---------------------------------------------------------------------------
// asset listing

export interface AssetEntry {
  library: string;
  table: AssetTable;
  id: ID;
  block: AssetBlock;
}

export function listAssets(library: string): AssetEntry[] {
  const doc = libraryDoc(library);
  if (!doc) return [];
  return assetsOf(doc).map(({ table, block }) => ({ library, table, id: block.id, block }));
}

/** "library|table:id": a reference to an asset of any library. */
export const assetRef = (a: { library: string; table: string; id: ID }) => `${a.library}|${a.table}:${a.id}`;
export function parseAssetRef(ref: string): { library: string; table: AssetTable; id: ID } | null {
  const m = /^([^|]+)\|([a-z_]+):(.+)$/.exec(ref);
  if (!m || !(ASSET_TABLES as readonly string[]).includes(m[2])) return null;
  return { library: m[1], table: m[2] as AssetTable, id: m[3] };
}

export function findAsset(ref: string): AssetEntry | null {
  const r = parseAssetRef(ref);
  if (!r) return null;
  const doc = libraryDoc(r.library);
  const block = doc ? blockOf(doc, r.table, r.id) : undefined;
  return block?.asset_data ? { ...r, block } : null;
}

// ---------------------------------------------------------------------------
// catalog edit history (user libraries)

function catalogState(doc: DocumentData): string {
  const assign: Record<string, string> = {};
  for (const { table, block } of assetsOf(doc)) assign[`${table}:${block.id}`] = block.asset_data!.catalog_id;
  return JSON.stringify({ cats: doc.asset_catalogs ?? [], assign });
}

function restoreCatalogState(doc: DocumentData, s: string) {
  const { cats, assign } = JSON.parse(s) as { cats: AssetCatalog[]; assign: Record<string, string> };
  doc.asset_catalogs = cats;
  for (const { table, block } of assetsOf(doc)) {
    const c = assign[`${table}:${block.id}`];
    if (c !== undefined) block.asset_data!.catalog_id = c;
  }
}

/** Remember the catalog state of a user library before an edit (for Undo Catalog Edits). */
export function catalogUndoPush(id: string) {
  const st = loaded.get(id);
  if (!st?.doc) return;
  st.undo.push(catalogState(st.doc));
  if (st.undo.length > 64) st.undo.shift();
  st.redo = [];
}

export const canCatalogUndo = (id: string) => !!loaded.get(id)?.undo.length;
export const canCatalogRedo = (id: string) => !!loaded.get(id)?.redo.length;

export function catalogUndo(id: string, redo = false): boolean {
  const st = loaded.get(id);
  if (!st?.doc) return false;
  const from = redo ? st.redo : st.undo;
  const to = redo ? st.undo : st.redo;
  const s = from.pop();
  if (!s) return false;
  to.push(catalogState(st.doc));
  restoreCatalogState(st.doc, s);
  libraryChanged(id);
  return true;
}

// ---------------------------------------------------------------------------
// copying assets into a user library

/** Remove data-blocks that no asset (and no scene setting) uses any more. */
export function purgeLibrary(doc: DocumentData) {
  const picks: Pick[] = assetsOf(doc).map(({ table, block }) => ({ table, id: block.id }));
  const keep = new Set(dependencyClosure(doc, picks).map((p) => p.id));
  keep.add(doc.scene.collection);
  if (doc.scene.world) keep.add(doc.scene.world);
  for (const t of dataTables(doc)) {
    const tab = tableOf(doc, t)!;
    for (const id of Object.keys(tab)) if (!keep.has(id)) delete tab[id];
  }
  for (const c of Object.values(doc.collections)) {
    c.objects = c.objects.filter((o) => doc.objects[o]);
    c.children = c.children.filter((o) => doc.collections[o]);
  }
  doc.object_order = doc.object_order.filter((o) => doc.objects[o]);
}

/**
 * Copy assets of `src` into the library document `lib` (with everything they use). Assets of the
 * same type and name already in the library are replaced. Returns the number of assets copied.
 */
export function copyAssetsInto(lib: DocumentData, src: DocumentData, targets: { table: AssetTable; id: ID }[]): number {
  const picks = targets.filter((t) => blockOf(src, t.table, t.id)?.asset_data);
  if (!picks.length) return 0;
  // replace assets with the same name
  for (const p of picks) {
    const name = blockOf(src, p.table, p.id)!.name;
    const tab = tableOf(lib, p.table);
    if (!tab) continue;
    for (const b of Object.values(tab)) if (b.asset_data && b.name === name) delete b.asset_data;
  }
  purgeLibrary(lib);
  // catalogs used by the copied assets
  const srcCats = src.asset_catalogs ?? [];
  const usedCats = new Set(picks.map((p) => blockOf(src, p.table, p.id)!.asset_data!.catalog_id).filter(Boolean));
  const needed = srcCats.filter((c) => [...usedCats].some((u) => { const uc = srcCats.find((x) => x.id === u); return uc && (uc.path === c.path || uc.path.startsWith(`${c.path}/`)); }));
  const catMap = mergeCatalogs((lib.asset_catalogs ??= []), needed);
  const res = copyDatablocks(lib, src, picks);
  for (const p of picks) {
    const b = blockOf(lib, p.table, res.map.get(p.id)!);
    if (!b?.asset_data) continue;
    b.asset_data = cloneShared(b.asset_data);
    b.asset_data.catalog_id = catMap.get(b.asset_data.catalog_id) ?? '';
  }
  // objects are kept in the library's scene collection
  const master = lib.collections[lib.scene.collection];
  const inCollections = new Set(res.added.filter((a) => a.table === 'collections').flatMap((a) => lib.collections[a.id].objects));
  for (const a of res.added) {
    if (a.table === 'objects' && !inCollections.has(a.id) && !master.objects.includes(a.id)) master.objects.push(a.id);
    if (a.table === 'collections' && picks.some((p) => res.map.get(p.id) === a.id) && !master.children.includes(a.id)) master.children.push(a.id);
  }
  return picks.length;
}

/** Copy assets of a library (default: the current file) into a user library and save it. */
export async function copyToLibrary(libraryId: string, targets: { table: AssetTable; id: ID }[], src: DocumentData = app.doc): Promise<number> {
  const lib = await ensureLibrary(libraryId);
  if (!lib || lib === src) return 0;
  catalogUndoPush(libraryId);
  const n = copyAssetsInto(lib, src, targets);
  if (n) {
    libraryChanged(libraryId);
    await saveLibrary(libraryId, true);
  }
  return n;
}

/** Remove assets from a user library (their data goes too when nothing else uses it). */
export function removeFromLibrary(libraryId: string, targets: { table: AssetTable; id: ID }[]): number {
  const lib = libraryDoc(libraryId);
  if (!lib || libraryId === LOCAL || libraryId === ESSENTIALS) return 0;
  let n = 0;
  for (const t of targets) {
    const b = blockOf(lib, t.table, t.id);
    if (b?.asset_data) {
      delete b.asset_data;
      n++;
    }
  }
  if (n) {
    purgeLibrary(lib);
    libraryChanged(libraryId);
  }
  return n;
}

/** Add every asset of a document as a new user library (Import Library). */
export async function importLibraryDoc(name: string, doc: DocumentData): Promise<{ id: string; count: number }> {
  const id = await createLibrary(name);
  const lib = state(id).doc!;
  const count = copyAssetsInto(lib, doc, assetsOf(doc).map(({ table, block }) => ({ table, id: block.id })));
  // keep empty catalogs of the file too
  mergeCatalogs((lib.asset_catalogs ??= []), doc.asset_catalogs ?? []);
  await saveLibrary(id, true);
  notifyLibraries();
  return { id, count };
}

/** Add every asset of a project file as a new user library. */
export async function importLibraryFile(name: string, bytes: Uint8Array): Promise<{ id: string; count: number }> {
  return importLibraryDoc(name, decodeDocument(bytes).doc);
}

/** Replace a user library with a saved project (the library opened as a file and saved). */
export async function writeLibraryBytes(id: string, bytes: Uint8Array) {
  const { doc } = decodeDocument(bytes);
  doc.asset_catalogs ??= [];
  const st = state(id);
  st.doc = doc;
  st.error = undefined;
  st.undo = [];
  st.redo = [];
  await kvSet(libKey(id), encodeDocument(doc));
  notifyLibraries();
}

/** The bytes of a library as a project file (Export Library). */
export function exportLibraryBytes(id: string): Uint8Array | null {
  const doc = libraryDoc(id);
  return doc ? encodeDocument(doc) : null;
}

/** Test hook: forget loaded user libraries. */
export function resetLibrariesForTests() {
  entries = [];
  loaded.clear();
  indexLoaded = Promise.resolve();
  indexReady = true;
}
