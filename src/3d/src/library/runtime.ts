// Library runtime: reading library files (from the library store or packed in the project),
// decoding them (cached, so operators can run synchronously and be adjusted afterwards),
// reloading linked data when a file is opened or on request, and keeping linked data read-only
// in every document the app shows (also after undo).
import { app, onAppReady } from '../app/app';
import type { DocumentData, ID } from '../data/types';
import { decodeDocument, isNativeFile } from '../io/native';
import { lockLinked, libraries, reloadFromDoc, stabilizeIds, linkedRecords } from './core';
import type { LibraryData } from './types';
import { withLinkedWrites } from './readonly';
import { fingerprint, getStored, latestBytes, type StoredLibrary } from './store';
import { uid } from '../data/defaults';

export const formatOf = (name: string): 'p3d' | 'blend' => (/\.blend\d*$/i.test(name) ? 'blend' : 'p3d');

/** Can this file be linked from? */
export const isLibraryFile = (name: string) => /\.(p3d|blend\d*)$/i.test(name);

const decoded = new Map<string, { fp: string; doc: DocumentData; entry?: Pick<StoredLibrary, 'key' | 'name' | 'path' | 'recentName' | 'handle'> }>();

/** Decode the bytes of a library file into a document (project files and .blend files). */
export async function decodeLibraryBytes(bytes: Uint8Array, format: 'p3d' | 'blend'): Promise<DocumentData> {
  if (isNativeFile(bytes)) return decodeDocument(bytes).doc;
  if (format === 'blend') {
    const { readBlend } = await import('../io/blend/convert');
    return stabilizeIds((await readBlend(bytes)).doc);
  }
  throw new Error('not a project file');
}

/** Decode (once per file content) and remember the document of a stored library file. */
export async function sourceDoc(key: string, bytes: Uint8Array, format: 'p3d' | 'blend', entry?: StoredLibrary): Promise<DocumentData> {
  const fp = fingerprint(bytes);
  const hit = decoded.get(key);
  if (hit && hit.fp === fp) {
    if (entry) hit.entry = entry;
    return hit.doc;
  }
  const doc = await decodeLibraryBytes(bytes, format);
  decoded.set(key, { fp, doc, entry: entry ?? hit?.entry });
  return doc;
}

/** The stored-file details and content fingerprint behind a cached source document. */
export function cachedInfo(key: string) {
  const hit = decoded.get(key);
  return hit ? { fp: hit.fp, entry: hit.entry } : undefined;
}

/** The last decoded document of a stored library file (operators run synchronously on it). */
export function cachedSource(key: string): DocumentData | undefined {
  return decoded.get(key)?.doc;
}

/** Key of a cached source document by file name (newest first). */
export function cachedKeyByName(name: string): string | undefined {
  let hit: string | undefined;
  for (const [k, v] of decoded) if (v.entry?.name === name) hit = k;
  return hit;
}

/** Remember a decoded document for a key (used by scripts and tests that bring their own files). */
export function cacheSource(key: string, doc: DocumentData, entry?: Pick<StoredLibrary, 'key' | 'name' | 'path' | 'recentName' | 'handle'>, fp = 'given') {
  decoded.set(key, { fp, doc, entry });
}

/** The library of a document that uses a stored file, or a new (not yet added) one. */
export function libraryFor(doc: DocumentData, entry: Pick<StoredLibrary, 'key' | 'name' | 'path' | 'recentName' | 'handle'>): LibraryData {
  const hit = Object.values(libraries(doc)).find((l) => l.source.key === entry.key);
  if (hit) return hit;
  return {
    id: uid('li'),
    name: entry.name,
    filepath: entry.path,
    source: { kind: entry.recentName ? 'recent' : entry.handle ? 'handle' : 'copy', key: entry.key },
    format: formatOf(entry.name),
  };
}

/** The current bytes of a library: packed in the project, else the newest the store can find. */
export async function libraryBytes(lib: LibraryData, prompt = false): Promise<Uint8Array | null> {
  if (lib.packed_file?.length) return lib.packed_file;
  return (await latestBytes(lib.source.key, prompt))?.bytes ?? null;
}

/** Library sources that are not files (e.g. asset libraries): their document and a revision. */
export const sourceResolvers: Partial<Record<LibraryData['source']['kind'], (lib: LibraryData) => Promise<{ doc: DocumentData; fp: string } | null>>> = {};

export interface ReloadSummary {
  reloaded: string[];
  unchanged: string[];
  missingFiles: string[];
  missingData: string[];
}

let reloading = false;

/**
 * Reload libraries of the current document (all when `ids` is omitted). Unchanged files are
 * skipped unless `force`. Returns what happened; the caller decides about undo.
 */
export async function reloadLibraries(ids?: ID[], opts: { force?: boolean; prompt?: boolean } = {}): Promise<ReloadSummary> {
  const sum: ReloadSummary = { reloaded: [], unchanged: [], missingFiles: [], missingData: [] };
  const doc = app.doc;
  const libs = Object.values(libraries(doc)).filter((l) => !ids || ids.includes(l.id));
  // parents first: data linked through a library comes with it
  libs.sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
  for (const lib of libs) {
    const resolver = sourceResolvers[lib.source.kind];
    if (resolver) {
      const got = await resolver(lib).catch(() => null);
      const cur = libraries(app.doc)[lib.id];
      if (!cur) continue;
      if (!got) {
        cur.is_missing = true;
        sum.missingFiles.push(lib.name);
      } else if (!opts.force && cur.revision === got.fp && !cur.is_missing) sum.unchanged.push(lib.name);
      else {
        const r = reloadFromDoc(app.doc, lib.id, got.doc);
        cur.revision = got.fp;
        sum.reloaded.push(lib.name);
        sum.missingData.push(...r.missing);
      }
      continue;
    }
    const bytes = await libraryBytes(lib, opts.prompt);
    const cur = libraries(app.doc)[lib.id];
    if (!cur) continue;
    if (!bytes) {
      cur.is_missing = true;
      sum.missingFiles.push(lib.name);
      continue;
    }
    const fp = fingerprint(bytes);
    if (!opts.force && cur.revision === fp && !cur.is_missing) {
      sum.unchanged.push(lib.name);
      continue;
    }
    let src: DocumentData;
    try {
      src = await sourceDoc(lib.source.key, bytes, lib.format);
    } catch {
      cur.is_missing = true;
      sum.missingFiles.push(lib.name);
      continue;
    }
    const r = reloadFromDoc(app.doc, lib.id, src);
    libraries(app.doc)[lib.id].revision = fp;
    sum.reloaded.push(lib.name);
    sum.missingData.push(...r.missing);
  }
  lockLinked(app.doc);
  return sum;
}

/** Report the outcome of a reload in the status bar / Info log. */
export function reportReload(sum: ReloadSummary, quiet = false) {
  for (const f of sum.missingFiles) app.report('WARNING', `Library "${f}" could not be read; its linked data is shown as last saved`);
  if (sum.missingData.length) app.report('WARNING', `Missing in their libraries (kept as last loaded): ${sum.missingData.slice(0, 8).join(', ')}${sum.missingData.length > 8 ? '…' : ''}`);
  if (sum.reloaded.length) app.report('INFO', `Reloaded ${sum.reloaded.map((n) => `"${n}"`).join(', ')}`);
  else if (!quiet && !sum.missingFiles.length) app.report('INFO', 'Linked libraries are up to date');
}

/** Libraries of a document whose stored file is unknown to this browser. */
export async function unknownLibraries(doc: DocumentData): Promise<LibraryData[]> {
  const out: LibraryData[] = [];
  for (const l of Object.values(libraries(doc))) if (!l.packed_file?.length && !(await getStored(l.source.key))) out.push(l);
  return out;
}

/** Reload the libraries of a document that was just opened (no undo step, unchanged modified state). */
async function reloadOnOpen() {
  if (reloading) return;
  reloading = true;
  try {
    const before = app.doc;
    const dirty = app.dirty;
    const sum = await reloadLibraries();
    if (app.doc !== before) return;
    if (sum.reloaded.length) {
      if (app.undo.canUndo) app.pushUndo('Reload Libraries');
      else app.undo.reset(app.doc);
      app.changed('doc');
      app.dirty = dirty;
    }
    reportReload(sum, true);
  } finally {
    reloading = false;
  }
}

onAppReady((a) => {
  lockLinked(a.doc);
  // animation, drivers and simulations write evaluated values into linked data as well
  const evaluate = a.graph.evaluate.bind(a.graph);
  a.graph.evaluate = ((...args: Parameters<typeof evaluate>) => withLinkedWrites(() => evaluate(...args))) as typeof a.graph.evaluate;
  // every document the app switches to (open, new, undo, redo) gets its linked data locked;
  // opening a file with libraries reloads them
  const set = a.setDocument.bind(a);
  a.setDocument = (doc: DocumentData, resetUndo = true) => {
    lockLinked(doc);
    set(doc, resetUndo);
    if (resetUndo && linkedRecords(doc).length) void reloadOnOpen();
  };
  if (linkedRecords(a.doc).length) void reloadOnOpen();
});
