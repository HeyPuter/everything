// ZIP I/O backing the OPC package layer.
//
// Wraps `fflate` because it is the only ZIP library that is small (~30KB),
// synchronous, and works in both Node and browsers without a polyfill. The
// wrapper is deliberately thin: it just translates between fflate's
// object-keyed API and an ordered array of entries, plus picks a sensible
// compression level per entry.
//
// What we preserve on round-trip:
//
//   - Entry order. fflate's `unzipSync` returns a plain object whose key
//     iteration order matches the central directory, so we use `Object.keys`
//     to recover the ordering. JS objects preserve insertion order for string
//     keys, so this is well-defined.
//   - Approximate per-entry compression method. Real PPTX files store media
//     (PNG, JPEG, ...) with no compression (STORE) and deflate everything
//     else. We mirror that heuristic on write, using extension to decide.
//     We do NOT round-trip the *exact* DEFLATE level — every PPTX consumer
//     accepts any valid level.
//
// What we do NOT preserve:
//
//   - File timestamps (`mtime`). Native saves set these to the current time
//     anyway; preserving the original would be misleading.
//   - ZIP64 extensions. fflate auto-promotes when needed.
//   - Extra fields, file attributes, UTF-8 flags. These are not load-bearing
//     for PPTX as consumed by .pptx readers.

import { deflateSync, unzipSync } from "fflate";

export interface ZipEntry {
  /** Path inside the archive, forward-slash separated (`ppt/slides/slide1.xml`). */
  name: string;
  /** Decompressed bytes. */
  data: Uint8Array;
}

export interface ZipReadResult {
  /** Entries in the order the central directory listed them. */
  entries: ZipEntry[];
}

const STORE_BY_EXTENSION = new Set([
  // images — already compressed
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "webp",
  // media — already compressed
  "mp3",
  "mp4",
  "m4a",
  "m4v",
  "wav",
  "wmv",
  "mov",
  "avi",
  // archives — already compressed
  "pdf",
  "zip",
  "gz",
  "7z",
  "rar",
]);

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/**
 * Returns true if the entry should be stored uncompressed. PPTX writers
 * conventionally STORE already-compressed payloads to avoid wasting CPU on
 * negligible savings.
 */
export const shouldStore = (name: string): boolean =>
  STORE_BY_EXTENSION.has(extensionOf(name));

/**
 * Reads a ZIP archive (a `.pptx` file is a ZIP) and returns entries in
 * central-directory order. Throws if `input` is not a valid ZIP.
 *
 * `snapshot`: `input` is an archive `writeZip` returned, its bytes unchanged
 * since. Entries whose bytes are still in memory are then returned as they
 * are, and the others with their compression known.
 */
export const readZip = (
  input: Uint8Array,
  { snapshot = false }: { snapshot?: boolean } = {},
): ZipReadResult => {
  const known = snapshot ? archives.get(input) : undefined;
  const paths = new Map<string, string>();
  const partNames = new Set<string>();
  // Every entry, in the order the library would list them, and the bytes
  // of those an archive written here still has in memory.
  const listed: Record<string, Uint8Array | null> = {};
  const obj = unzipSync(input, {
    filter: ({ name }) => {
      // Repair Windows archive member separators without changing part bodies.
      const path = name.replace(/\\/g, "/");
      if (!path.endsWith("/")) {
        const key = path.toLowerCase();
        if (partNames.has(key))
          throw new Error(`package contains duplicate part: ${path}`);
        partNames.add(key);
      }
      paths.set(name, path);
      // An archive written here (an undo step's snapshot) holds bytes that
      // are still in memory, unchanged, when the deck being edited still
      // has that part: they are taken as they are rather than unpacked.
      const kept = known?.get(name)?.data.deref() ?? null;
      listed[name] = kept;
      return !kept;
    },
  });
  const entries: ZipEntry[] = [];
  for (const name of Object.keys(listed)) {
    const data = listed[name] ?? obj[name];
    if (data === undefined || data === null) continue;
    // Bytes unpacked from an archive written here were compressed for it;
    // the next save reuses that work.
    const entry = known?.get(name);
    if (entry && !written.has(data)) written.set(data, entry.written);
    entries.push({ name: paths.get(name)!, data });
  }
  return { entries };
};

/**
 * Writes a ZIP archive. Entries are written in the order given. Each entry's
 * compression method is chosen from its extension via `shouldStore`. Callers
 * who want a specific compression level can pass `levelOverride`.
 */
/** DEFLATE compression level. 0 stores uncompressed; 9 is best compression. */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

// What writing an entry's bytes came to: their CRC, and for a deflated entry
// the compressed bytes at the level used. A package's part bytes are
// replaced, never changed in place, when a part is written (see
// parts/package.ts), so an unchanged part is not compressed again on the next
// save: an edit to one slide of a large deck re-deflates that slide, not
// every slide, chart and workbook, and stored media is not checksummed again.
interface Written {
  crc: number;
  level: CompressionLevel;
  compressed: Uint8Array | null;
}
const written = new WeakMap<Uint8Array, Written>();
// What each archive written here holds, by entry name, for as long as the
// archive is kept: a package read back from it (the undo history keeps its
// snapshots as archives) takes the parts the deck in memory still shares
// with it as they are, unpacks only the others, and starts with every
// part's compressed bytes known, so the first edit after an undo compresses
// only what it changed. Each entry's bytes are held weakly: an archive
// keeps no part alive that no deck holds any more.
const archives = new WeakMap<
  Uint8Array,
  Map<string, { written: Written; data: WeakRef<Uint8Array> }>
>();

let crcTable: Int32Array | null = null;
const crc32 = (data: Uint8Array): number => {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < data.length; i++)
    c = crcTable[(c ^ data[i]!) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
};

const entryBytes = (data: Uint8Array, level: CompressionLevel): Written => {
  const hit = written.get(data);
  if (hit && hit.level === level) return hit;
  const entry: Written = {
    // A stored entry's checksum carries over whatever the level.
    crc: hit ? hit.crc : crc32(data),
    level,
    compressed: level ? deflateSync(data, { level }) : null,
  };
  written.set(data, entry);
  return entry;
};

const put16 = (out: Uint8Array, at: number, v: number): void => {
  out[at] = v & 255;
  out[at + 1] = (v >>> 8) & 255;
};
const put32 = (out: Uint8Array, at: number, v: number): void => {
  out[at] = v & 255;
  out[at + 1] = (v >>> 8) & 255;
  out[at + 2] = (v >>> 16) & 255;
  out[at + 3] = (v >>> 24) & 255;
};
const dosTime = (date: Date): number => {
  const y = date.getFullYear() - 1980;
  if (y < 0 || y > 119) throw new Error("date not in range 1980-2099");
  return (
    ((y << 25) |
      ((date.getMonth() + 1) << 21) |
      (date.getDate() << 16) |
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1)) >>>
    0
  );
};
const ENCODER = new TextEncoder();

export const writeZip = (
  entries: ReadonlyArray<ZipEntry>,
  options: { level?: CompressionLevel } = {},
): Uint8Array => {
  const defaultLevel: CompressionLevel = options.level ?? 6;
  // A name given twice keeps its first place and its last bytes.
  const byName = new Map<string, Uint8Array>();
  for (const e of entries) byName.set(e.name, e.data);
  // A part left without bytes (media added without its picture) is left
  // out, as the archive library this replaces did, rather than failing the
  // whole save.
  for (const [name, data] of byName)
    if (!(data instanceof Uint8Array)) byName.delete(name);
  const time = dosTime(new Date());
  const files: {
    name: Uint8Array;
    utf8: boolean;
    data: Uint8Array;
    size: number;
    crc: number;
    method: number;
    offset: number;
  }[] = [];
  let offset = 0;
  let central = 0;
  const contents = new Map<
    string,
    { written: Written; data: WeakRef<Uint8Array> }
  >();
  for (const [name, data] of byName) {
    const level: CompressionLevel = shouldStore(name) ? 0 : defaultLevel;
    const entry = entryBytes(data, level);
    const { crc, compressed } = entry;
    contents.set(name, { written: entry, data: new WeakRef(data) });
    const encoded = ENCODER.encode(name);
    if (encoded.length > 65535) throw new Error("filename too long");
    const body = compressed ?? data;
    files.push({
      name: encoded,
      utf8: encoded.length !== name.length,
      data: body,
      size: data.length,
      crc,
      method: compressed ? 8 : 0,
      offset,
    });
    offset += 30 + encoded.length + body.length;
    central += 46 + encoded.length;
  }
  const out = new Uint8Array(offset + central + 22);
  const header = (
    at: number,
    f: (typeof files)[number],
    centralEntry: boolean,
  ): number => {
    put32(out, at, centralEntry ? 0x02014b50 : 0x04034b50);
    at += 4;
    if (centralEntry) {
      out[at++] = 20;
      out[at++] = 0;
    }
    out[at] = 20;
    at += 2;
    out[at++] = 0;
    out[at++] = f.utf8 ? 8 : 0;
    put16(out, at, f.method);
    at += 2;
    put32(out, at, time);
    put32(out, at + 4, f.crc);
    put32(out, at + 8, f.data.length);
    put32(out, at + 12, f.size);
    put16(out, at + 16, f.name.length);
    at += 20;
    if (centralEntry) {
      // Comment length, disk, attributes: all zero.
      put32(out, at + 10, f.offset);
      at += 14;
    }
    out.set(f.name, at);
    return at + f.name.length;
  };
  for (const f of files) out.set(f.data, header(f.offset, f, false));
  let at = offset;
  for (const f of files) at = header(at, f, true);
  put32(out, at, 0x06054b50);
  put16(out, at + 8, files.length);
  put16(out, at + 10, files.length);
  put32(out, at + 12, central);
  put32(out, at + 16, offset);
  archives.set(out, contents);
  return out;
};
