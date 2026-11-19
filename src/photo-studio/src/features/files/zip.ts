// Minimal ZIP writer (STORE method only), from the PKWARE APPNOTE 6.3.x
// layout: local file headers, the stored bytes, then a central directory.
// Image files are already compressed, so deflating them again buys little.
import { crc32 } from '../../imaging/codecs/bytes';

export type ZipEntry = { name: string; data: Uint8Array; date?: Date };

// MS-DOS date/time fields (2-second resolution, local time, 1980 epoch).
function dosDateTime(d: Date): [number, number] {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Unique archive names: "a.png", "a 2.png", ... (case-insensitive). */
export function uniqueName(name: string, used: Set<string>): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '_') || 'file';
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  let out = clean;
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${stem} ${i}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

/** A file of a ZIP built as a Blob: its bytes stay where the Blob keeps them. */
export type ZipBlobEntry = { name: string; blob: Blob; crc: number; date?: Date };

/** The headers of a stored ZIP: one local header per entry, written before
 * the entry's bytes, and the central directory with its end record after
 * the last entry. */
function zipHeaders(entries: { name: string; size: number; crc: number; date?: Date }[]): {
  locals: Uint8Array[];
  tail: Uint8Array;
} {
  if (entries.length > 0xffff)
    throw new Error('A ZIP archive without ZIP64 holds at most 65535 files.');
  const enc = new TextEncoder();
  const names = entries.map((e) => enc.encode(e.name));
  let size = 22;
  entries.forEach((e, i) => (size += 30 + 46 + 2 * names[i].length + e.size));
  if (size > 0xffffffff) throw new Error('The archive exceeds 4 GB.');
  const central: { offset: number; time: number; date: number }[] = [];
  let p = 0;
  const locals = entries.map((e, i) => {
    const [time, date] = dosDateTime(e.date ?? new Date());
    central.push({ offset: p, time, date });
    const out = new Uint8Array(30 + names[i].length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version needed: 2.0
    dv.setUint16(6, 0x0800, true); // bit 11: names are UTF-8
    dv.setUint16(8, 0, true); // method 0: stored
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, e.crc, true);
    dv.setUint32(18, e.size, true);
    dv.setUint32(22, e.size, true);
    dv.setUint16(26, names[i].length, true);
    dv.setUint16(28, 0, true);
    out.set(names[i], 30);
    p += out.length + e.size;
    return out;
  });
  const cdStart = p;
  const tail = new Uint8Array(size - cdStart);
  const dv = new DataView(tail.buffer);
  let q = 0;
  entries.forEach((e, i) => {
    const c = central[i];
    dv.setUint32(q, 0x02014b50, true);
    dv.setUint16(q + 4, 20, true); // made by: MS-DOS/FAT attributes, 2.0
    dv.setUint16(q + 6, 20, true);
    dv.setUint16(q + 8, 0x0800, true);
    dv.setUint16(q + 10, 0, true);
    dv.setUint16(q + 12, c.time, true);
    dv.setUint16(q + 14, c.date, true);
    dv.setUint32(q + 16, e.crc, true);
    dv.setUint32(q + 20, e.size, true);
    dv.setUint32(q + 24, e.size, true);
    dv.setUint16(q + 28, names[i].length, true);
    // Extra, comment, disk number, internal and external attributes stay 0.
    dv.setUint32(q + 42, c.offset, true);
    tail.set(names[i], q + 46);
    q += 46 + names[i].length;
  });
  dv.setUint32(q, 0x06054b50, true);
  dv.setUint16(q + 8, entries.length, true);
  dv.setUint16(q + 10, entries.length, true);
  dv.setUint32(q + 12, q, true);
  dv.setUint32(q + 16, cdStart, true);
  return { locals, tail };
}

export function zipStore(entries: ZipEntry[]): Uint8Array {
  const { locals, tail } = zipHeaders(
    entries.map((e) => ({ name: e.name, size: e.data.length, crc: crc32(e.data), date: e.date })),
  );
  const out = new Uint8Array(
    locals.reduce((n, h, i) => n + h.length + entries[i].data.length, tail.length),
  );
  let p = 0;
  entries.forEach((e, i) => {
    out.set(locals[i], p);
    p += locals[i].length;
    out.set(e.data, p);
    p += e.data.length;
  });
  out.set(tail, p);
  return out;
}

/** A stored ZIP as a Blob made of the entries' Blobs and the headers, so the
 * archive is not a second copy of its files in memory. */
export function zipBlob(entries: ZipBlobEntry[]): Blob {
  const { locals, tail } = zipHeaders(
    entries.map((e) => ({ name: e.name, size: e.blob.size, crc: e.crc, date: e.date })),
  );
  return new Blob(
    [
      ...entries.flatMap((e, i) => [locals[i] as Uint8Array<ArrayBuffer>, e.blob]),
      tail as Uint8Array<ArrayBuffer>,
    ],
    { type: 'application/zip' },
  );
}
