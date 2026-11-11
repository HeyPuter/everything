// Native project format (.p3d): a small binary container.
//   magic "P3D\0" | u32 version | u32 jsonLength | json (utf-8) | padding to 8 | binary buffers
// Typed arrays inside the document are stored as {"$buf": index, "$type": "Float32Array"} and
// their bytes are appended to the binary section (8-byte aligned).
import type { DocumentData } from '../data/types';
import { defaultRender, emptyDocument, newObject } from '../data/defaults';

const MAGIC = 0x00443350; // 'P3D\0' little endian
export const FORMAT_VERSION = 1;
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

const TYPES: Record<string, { new (b: ArrayBuffer, o: number, n: number): ArrayBufferView }> = {
  Float32Array,
  Float64Array,
  Uint32Array,
  Int32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
  Int8Array,
} as never;

export function encodeDocument(doc: DocumentData, extra: Record<string, unknown> = {}): Uint8Array {
  const buffers: ArrayBufferView[] = [];
  const seen = new Map<ArrayBufferView, number>();
  const json = JSON.stringify({ doc, ...extra }, (_k, v) => {
    if (ArrayBuffer.isView(v)) {
      let i = seen.get(v);
      if (i === undefined) {
        i = buffers.length;
        buffers.push(v);
        seen.set(v, i);
      }
      return { $buf: i, $type: v.constructor.name };
    }
    return v;
  });
  const enc = new TextEncoder().encode(json);
  const headerLen = 12;
  let offset = headerLen + enc.length;
  offset = (offset + 7) & ~7;
  const table: { offset: number; length: number }[] = [];
  let total = offset + 8 + buffers.length * 16;
  total = (total + 7) & ~7;
  for (const b of buffers) {
    table.push({ offset: total, length: b.byteLength });
    total += b.byteLength;
    total = (total + 7) & ~7;
  }
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, FORMAT_VERSION, true);
  dv.setUint32(8, enc.length, true);
  out.set(enc, headerLen);
  dv.setUint32(offset, buffers.length, true);
  table.forEach((t, i) => {
    dv.setFloat64(offset + 8 + i * 16, t.offset, true);
    dv.setFloat64(offset + 8 + i * 16 + 8, t.length, true);
  });
  buffers.forEach((b, i) => out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), table[i].offset));
  return out;
}

export function isNativeFile(bytes: Uint8Array) {
  return bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === MAGIC;
}

export function decodeDocument(bytes: Uint8Array): { doc: DocumentData; extra: Record<string, unknown> } {
  try {
    return decode(bytes);
  } catch (e) {
    // a damaged file trips JSON / DataView / property errors whose wording means nothing to users
    if (e instanceof SyntaxError || e instanceof RangeError || e instanceof TypeError) {
      console.warn('Cannot decode the project file:', e);
      throw new Error('The file is damaged.');
    }
    throw e;
  }
}

function decode(bytes: Uint8Array): { doc: DocumentData; extra: Record<string, unknown> } {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('File is too large.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a project file.');
  const version = dv.getUint32(4, true);
  // versions grow one at a time: a huge number is a damaged header, not a newer file
  if (version > FORMAT_VERSION) throw new Error(version < 1000 ? `This file was saved by a newer version (format ${version}).` : 'The file is damaged.');
  const jsonLen = dv.getUint32(8, true);
  if (12 + jsonLen > bytes.length) throw new Error('The file is truncated.');
  const json = new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen));
  let offset = (12 + jsonLen + 7) & ~7;
  const count = dv.getUint32(offset, true);
  const table: { offset: number; length: number }[] = [];
  for (let i = 0; i < count; i++) table.push({ offset: dv.getFloat64(offset + 8 + i * 16, true), length: dv.getFloat64(offset + 8 + i * 16 + 8, true) });
  const cache = new Map<number, ArrayBufferView>();
  const parsed = JSON.parse(json, (_k, v) => {
    if (v && typeof v === 'object' && '$buf' in v && '$type' in v) {
      const i = v.$buf as number;
      let arr = cache.get(i);
      if (!arr) {
        const t = table[i];
        const T = TYPES[v.$type as string];
        if (!t || !T) throw new Error('Corrupt buffer table.');
        if (t.offset + t.length > bytes.length) throw new Error('The file is truncated.');
        const copy = bytes.slice(t.offset, t.offset + t.length).buffer;
        const per = (T as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
        arr = new T(copy, 0, t.length / per);
        cache.set(i, arr);
      }
      return arr;
    }
    return v;
  });
  void offset;
  offset = 0;
  const isRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isRecord(parsed?.doc?.scene) || !isRecord(parsed.doc.objects)) throw new Error('The file does not contain a scene.');
  const { doc, ...extra } = parsed;
  return { doc: migrate(doc), extra };
}

/** Fill in fields added after a file was written. */
export function migrate(doc: DocumentData): DocumentData {
  // data-block tables and scene settings missing from the file get their defaults
  const base = emptyDocument() as unknown as Record<string, unknown>;
  const d = doc as unknown as Record<string, unknown>;
  for (const k of Object.keys(base)) if (k !== 'brushes' && k !== 'object_order' && (d[k] === undefined || d[k] === null)) d[k] = base[k];
  for (const sc of [doc.scene, ...Object.values(doc.scenes ?? {})]) {
    if (!sc || typeof sc !== 'object') continue;
    for (const [k, v] of Object.entries(base.scene as object)) if (k !== 'id' && k !== 'world') (sc as unknown as Record<string, unknown>)[k] ??= structuredClone(v);
    if (sc.world === undefined) sc.world = doc.worlds[(base.scene as DocumentData['scene']).world!] ? (base.scene as DocumentData['scene']).world : null;
    // the scene's master collection must exist
    if (!doc.collections[sc.collection]) {
      const master = (base.collections as DocumentData['collections'])[(base.scene as DocumentData['scene']).collection];
      sc.collection = master.id;
      doc.collections[master.id] = master;
    }
  }
  doc.brushes ??= {};
  doc.texts ??= {};
  doc.particles ??= {};
  doc.node_groups ??= {};
  doc.lattices ??= {};
  doc.metaballs ??= {};
  doc.hair_curves ??= {};
  doc.volumes ??= {};
  doc.pointclouds ??= {};
  doc.object_order ??= Object.keys(doc.objects);
  // render settings added later get their defaults
  for (const sc of [doc.scene, ...Object.values(doc.scenes ?? {})]) if (sc?.render) for (const [k, v] of Object.entries(defaultRender())) (sc.render as unknown as Record<string, unknown>)[k] ??= v;
  // scenes are data-blocks with ids (files from before multiple scenes have one scene without)
  if (doc.scene) doc.scene.id ??= `sc_${Math.random().toString(36).slice(2, 10)}`;
  for (const [id, sc] of Object.entries(doc.scenes ?? {})) sc.id = id;
  for (const [id, ob] of Object.entries(doc.objects)) {
    ob.id ??= id;
    const filled = newObject(typeof ob.name === 'string' ? ob.name : 'Object', ob.type ?? 'EMPTY', ob.data ?? null) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(filled)) (ob as unknown as Record<string, unknown>)[k] ??= v;
    ob.particle_systems ??= [];
    ob.custom ??= {};
    ob.constraints ??= [];
    ob.modifiers ??= [];
  }
  return doc;
}

// ---------------------------------------------------------------------------
// IndexedDB recovery (autosave)

const DB = 'p3d-recovery';
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

/** Run one transaction; a full disk (QuotaExceededError) aborts it without an error event. */
function write(db: IDBDatabase, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new DOMException('The auto save was aborted', 'AbortError'));
  });
}

// Every tab keeps its own recovery slot ("autosave:<id>"), held with a Web Lock while the tab is
// open. A slot whose lock is free belongs to a tab that was closed or crashed: the next tab that
// starts takes over the newest one (as a single tab always did), other tabs' live slots are never
// read or overwritten, and the remaining stale slots are offered in File ▸ Recover ▸ Auto Save.
// Without Web Locks there is one shared slot ("autosave"), as before.

export interface RecoveryEntry {
  key: string;
  bytes: Uint8Array;
  name: string;
  time: number;
}

interface LockManagerLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

const SHARED_KEY = 'autosave';
/** stale slots kept for Recover ▸ Auto Save besides the one a tab takes over */
const MAX_STALE = 4;
const TAB_KEY = 'p3d-recovery-slot';
let recoveryKey = SHARED_KEY;
let claimed: Promise<unknown> | null = null;
const lockName = (key: string) => `p3d-recovery:${key}`;
const lockManager = (): LockManagerLike | null => (typeof navigator !== 'undefined' && (navigator as unknown as { locks?: LockManagerLike }).locks) || null;

/** Hold the lock of a slot for the lifetime of the tab; null when another tab holds it, else a release function. */
function holdSlot(locks: LockManagerLike, key: string): Promise<(() => void) | null> {
  return new Promise((res) => {
    locks
      .request(lockName(key), { ifAvailable: true }, (lock) => {
        if (!lock) return void res(null);
        return new Promise<void>((release) => res(release));
      })
      .catch(() => res(null));
  });
}

async function readEntries(): Promise<RecoveryEntry[]> {
  const db = await openDb();
  try {
    return await new Promise<RecoveryEntry[]>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const keys = tx.objectStore(STORE).getAllKeys();
      const values = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => res((values.result as Omit<RecoveryEntry, 'key'>[]).map((v, i) => ({ ...v, key: String(keys.result[i]) })).filter((e) => e.key === SHARED_KEY || e.key.startsWith(`${SHARED_KEY}:`)));
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Slots of closed or crashed tabs (not this tab's), newest first. */
async function staleEntries(locks: LockManagerLike): Promise<RecoveryEntry[]> {
  const entries = await readEntries();
  const held = new Set(((await locks.query().catch(() => ({}) as { held?: { name?: string }[] })).held ?? []).map((l) => l.name));
  return entries.filter((e) => e.key !== recoveryKey && !held.has(lockName(e.key))).sort((a, b) => b.time - a.time);
}

/**
 * Pick this tab's recovery slot at startup. With `adopt`, the newest slot left by a closed tab is
 * taken over and returned for recovery (a reloaded tab gets its own back first); `stillWanted`
 * is asked right before, so a session that will not be loaded is kept for Recover ▸ Auto Save.
 */
export function claimRecovery(adopt = true, stillWanted: () => boolean = () => true): Promise<Omit<RecoveryEntry, 'key'> | null> {
  const locks = lockManager();
  if (!locks || typeof indexedDB === 'undefined') return adopt ? loadRecovery() : Promise.resolve(null);
  const run = (async () => {
    let previous: string | null = null;
    try {
      previous = sessionStorage.getItem(TAB_KEY);
    } catch {
      // storage blocked
    }
    const stale = adopt ? await staleEntries(locks).catch(() => [] as RecoveryEntry[]) : [];
    stale.sort((a, b) => Number(b.key === previous) - Number(a.key === previous));
    let adopted: RecoveryEntry | null = null;
    if (stillWanted())
      for (const e of stale) {
        const release = await holdSlot(locks, e.key);
        if (!release) continue;
        // the tab changed something meanwhile: its work wins and the session stays on offer
        if (!stillWanted()) release();
        else adopted = e;
        break;
      }
    if (adopted) recoveryKey = adopted.key;
    else {
      recoveryKey = `${SHARED_KEY}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await holdSlot(locks, recoveryKey);
    }
    try {
      sessionStorage.setItem(TAB_KEY, recoveryKey);
    } catch {
      // storage blocked
    }
    // keep a few stale slots to offer; older ones go
    const rest = stale.filter((e) => e !== adopted).slice(MAX_STALE);
    if (rest.length) {
      const db = await openDb();
      await write(db, (s) => rest.forEach((e) => s.delete(e.key)))
        .catch(() => {})
        .finally(() => db.close());
    }
    return adopted ? { bytes: adopted.bytes, name: adopted.name, time: adopted.time } : null;
  })();
  claimed = run.catch(() => null);
  return run.catch(() => null);
}

/** Recovery slots of other tabs that were closed or crashed (for File ▸ Recover ▸ Auto Save). */
export async function otherRecoveries(): Promise<RecoveryEntry[]> {
  const locks = lockManager();
  if (!locks || typeof indexedDB === 'undefined') return [];
  await claimed;
  return staleEntries(locks).catch(() => []);
}

export async function readRecovery(key: string): Promise<Omit<RecoveryEntry, 'key'> | null> {
  try {
    const db = await openDb();
    const v = await new Promise<Omit<RecoveryEntry, 'key'> | undefined>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).finally(() => db.close());
    return v ?? null;
  } catch {
    return null;
  }
}

export async function saveRecovery(bytes: Uint8Array, name: string) {
  // the slot is known once startup picked it
  await claimed;
  const db = await openDb();
  try {
    await write(db, (s) => s.put({ bytes, name, time: Date.now() }, recoveryKey));
  } finally {
    db.close();
  }
}

/** This tab's auto saved session (Recover Last Session). */
export async function loadRecovery(): Promise<{ bytes: Uint8Array; name: string; time: number } | null> {
  await claimed;
  return readRecovery(recoveryKey);
}

export async function clearRecovery() {
  await claimed;
  try {
    const db = await openDb();
    await write(db, (s) => s.delete(recoveryKey)).finally(() => db.close());
  } catch {
    // ignore
  }
}

/** Trigger a browser download. */
export function download(bytes: Uint8Array | string, name: string, mime = 'application/octet-stream') {
  const blob = typeof bytes === 'string' ? new Blob([bytes], { type: mime }) : new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => res(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => res(null));
    input.click();
  });
}
