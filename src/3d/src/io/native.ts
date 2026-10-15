// Native project format (.p3d): a small binary container.
//   magic "P3D\0" | u32 version | u32 jsonLength | json (utf-8) | padding to 8 | binary buffers
// Typed arrays inside the document are stored as {"$buf": index, "$type": "Float32Array"} and
// their bytes are appended to the binary section (8-byte aligned).
import type { DocumentData } from '../data/types';

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
  if (bytes.length > MAX_FILE_BYTES) throw new Error('File is too large.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Not a project file.');
  const version = dv.getUint32(4, true);
  if (version > FORMAT_VERSION) throw new Error(`This file was saved by a newer version (format ${version}).`);
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
  if (!parsed?.doc?.scene || !parsed.doc.objects) throw new Error('The file does not contain a scene.');
  const { doc, ...extra } = parsed;
  return { doc: migrate(doc), extra };
}

/** Fill in fields added after a file was written. */
export function migrate(doc: DocumentData): DocumentData {
  doc.brushes ??= {};
  doc.texts ??= {};
  doc.particles ??= {};
  doc.node_groups ??= {};
  doc.lattices ??= {};
  doc.metaballs ??= {};
  doc.object_order ??= Object.keys(doc.objects);
  for (const ob of Object.values(doc.objects)) {
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

export async function saveRecovery(bytes: Uint8Array, name: string) {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ bytes, name, time: Date.now() }, 'autosave');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function loadRecovery(): Promise<{ bytes: Uint8Array; name: string; time: number } | null> {
  try {
    const db = await openDb();
    const v = await new Promise<{ bytes: Uint8Array; name: string; time: number } | undefined>((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get('autosave');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return v ?? null;
  } catch {
    return null;
  }
}

export async function clearRecovery() {
  try {
    const db = await openDb();
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete('autosave');
      tx.oncomplete = () => res();
    });
    db.close();
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
