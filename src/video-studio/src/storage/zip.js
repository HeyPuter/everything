/**
 * Minimal ZIP container, no dependencies. Files are stored uncompressed
 * (media is already compressed), so writing is just headers around Blob
 * slices and memory stays flat: the output Blob references the inputs.
 * ZIP64 records are added only when an entry or the archive passes 4 GB.
 *
 * Reading accepts stored entries and, where the browser has
 * DecompressionStream, deflated ones (archives re-zipped by other tools).
 */

const CHUNK = 8 << 20;
const MAX32 = 0xffffffff;
const enc = new TextEncoder();

let table = null;
function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC-32 of bytes, continuing from a previous value. */
export function crc32(bytes, crc = 0) {
  const t = crcTable();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function crcOfBlob(blob) {
  let crc = 0;
  for (let off = 0; off < blob.size; off += CHUNK) {
    crc = crc32(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()), crc);
  }
  return crc;
}

function toBlob(data) {
  if (data instanceof Blob) return data;
  if (typeof data === 'string') return new Blob([enc.encode(data)]);
  return new Blob([data]);
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Little-endian byte writer. */
function bytes(size) {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  const w = {
    u16(v) {
      view.setUint16(o, v, true);
      o += 2;
      return w;
    },
    u32(v) {
      view.setUint32(o, v >>> 0, true);
      o += 4;
      return w;
    },
    u64(v) {
      view.setBigUint64(o, BigInt(v), true);
      o += 8;
      return w;
    },
    raw(b) {
      buf.set(b, o);
      o += b.length;
      return w;
    },
    buf,
  };
  return w;
}

/**
 * Build a ZIP from entries [{ name, data: Blob | string | Uint8Array, modified? }].
 * Returns a Blob of type application/zip. force64 writes ZIP64 records even
 * for small archives (tests).
 */
export async function zipBlobs(entries, { force64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  const names = new Set();
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`Duplicate file name in archive: ${e.name}`);
    names.add(e.name);
    const blob = toBlob(e.data);
    const name = enc.encode(e.name);
    const crc = await crcOfBlob(blob);
    const size = blob.size;
    const { time, date } = dosDateTime(e.modified);
    const big = force64 || size >= MAX32 || offset >= MAX32;
    // Local header: ZIP64 extra carries the sizes when they do not fit.
    const localExtra = big ? bytes(20).u16(0x0001).u16(16).u64(size).u64(size).buf : new Uint8Array(0);
    const local = bytes(30 + name.length + localExtra.length)
      .u32(0x04034b50).u16(big ? 45 : 20).u16(0x0800).u16(0).u16(time).u16(date)
      .u32(crc).u32(big ? MAX32 : size).u32(big ? MAX32 : size)
      .u16(name.length).u16(localExtra.length).raw(name).raw(localExtra).buf;
    parts.push(local, blob);
    central.push({ name, crc, size, time, date, offset, big });
    offset += local.length + size;
  }
  const cdStart = offset;
  for (const c of central) {
    const extra = c.big ? bytes(28).u16(0x0001).u16(24).u64(c.size).u64(c.size).u64(c.offset).buf : new Uint8Array(0);
    const rec = bytes(46 + c.name.length + extra.length)
      .u32(0x02014b50).u16(c.big ? 45 : 20).u16(c.big ? 45 : 20).u16(0x0800).u16(0).u16(c.time).u16(c.date)
      .u32(c.crc).u32(c.big ? MAX32 : c.size).u32(c.big ? MAX32 : c.size)
      .u16(c.name.length).u16(extra.length).u16(0).u16(0).u16(0).u32(0).u32(c.big ? MAX32 : c.offset)
      .raw(c.name).raw(extra).buf;
    parts.push(rec);
    offset += rec.length;
  }
  const cdSize = offset - cdStart;
  const need64 = force64 || central.some((c) => c.big) || cdStart >= MAX32 || central.length >= 0xffff;
  if (need64) {
    const eocd64At = offset;
    parts.push(bytes(56).u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
      .u64(central.length).u64(central.length).u64(cdSize).u64(cdStart).buf);
    parts.push(bytes(20).u32(0x07064b50).u32(0).u64(eocd64At).u32(1).buf);
  }
  parts.push(bytes(22).u32(0x06054b50).u16(0).u16(0)
    .u16(need64 ? 0xffff : central.length).u16(need64 ? 0xffff : central.length)
    .u32(need64 ? MAX32 : cdSize).u32(need64 ? MAX32 : cdStart).u16(0).buf);
  return new Blob(parts, { type: 'application/zip' });
}

async function view(blob, start, end) {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

/** ZIP64 extended info: replace 0xffffffff fields with their 64-bit values, in order. */
function readZip64Extra(dv, start, len, fields) {
  let o = start;
  while (o + 4 <= start + len) {
    const id = dv.getUint16(o, true);
    const size = dv.getUint16(o + 2, true);
    if (id === 0x0001) {
      let p = o + 4;
      for (const key of Object.keys(fields)) {
        if (fields[key] !== MAX32) continue;
        fields[key] = Number(dv.getBigUint64(p, true));
        p += 8;
      }
      break;
    }
    o += 4 + size;
  }
  return fields;
}

/**
 * Read a ZIP Blob. Returns [{ name, size, blob() }] where blob() resolves to
 * the file's contents (a slice of the input for stored entries).
 */
export async function readZip(zip) {
  if (zip.size < 22) throw new Error('This file is not a project file (too small).');
  // End of central directory: the last 22 bytes plus up to 64 KB of comment.
  const tailStart = Math.max(0, zip.size - 22 - 0xffff);
  const tail = await view(zip, tailStart, zip.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a project file (not a ZIP archive).');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdStart = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === MAX32 || cdStart === MAX32) {
    let locator = tail;
    let locAt = eocd - 20;
    // A long comment can push part or all of the locator outside the tail
    // window. Read just those 20 bytes; ordinary archives reuse the tail.
    if (locAt < 0) {
      const start = tailStart + locAt;
      if (start < 0) throw new Error('This archive is damaged.');
      locator = await view(zip, start, start + 20);
      locAt = 0;
    }
    if (locator.getUint32(locAt, true) !== 0x07064b50) throw new Error('This archive is damaged.');
    const e64At = Number(locator.getBigUint64(locAt + 8, true));
    const e64 = await view(zip, e64At, e64At + 56);
    if (e64.getUint32(0, true) !== 0x06064b50) throw new Error('This archive is damaged.');
    count = Number(e64.getBigUint64(32, true));
    cdSize = Number(e64.getBigUint64(40, true));
    cdStart = Number(e64.getBigUint64(48, true));
  }
  if (cdStart + cdSize > zip.size) throw new Error('This archive is damaged or incomplete.');
  const cd = await view(zip, cdStart, cdStart + cdSize);
  const dec = new TextDecoder();
  const out = [];
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (o + 46 > cd.byteLength || cd.getUint32(o, true) !== 0x02014b50) throw new Error('This archive is damaged.');
    const flags = cd.getUint16(o + 8, true);
    const method = cd.getUint16(o + 10, true);
    const checksum = cd.getUint32(o + 16, true);
    const nameLen = cd.getUint16(o + 28, true);
    const extraLen = cd.getUint16(o + 30, true);
    const commentLen = cd.getUint16(o + 32, true);
    const name = dec.decode(new Uint8Array(cd.buffer, o + 46, nameLen));
    const f = readZip64Extra(cd, o + 46 + nameLen, extraLen, {
      size: cd.getUint32(o + 24, true),
      compressed: cd.getUint32(o + 20, true),
      offset: cd.getUint32(o + 42, true),
    });
    o += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Encrypted archives are not supported.');
    out.push({
      name,
      size: f.size,
      method,
      async blob() {
        // Blob.slice clamps out-of-bounds ranges silently. Validate before slicing so
        // a damaged length cannot turn directory bytes (or a truncated file) into media.
        if (![f.offset, f.size, f.compressed].every((n) => Number.isSafeInteger(n) && n >= 0) || f.offset + 30 > cdStart) {
          throw new Error('This archive is damaged or incomplete.');
        }
        const lh = await view(zip, f.offset, f.offset + 30);
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('This archive is damaged.');
        const start = f.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        if (start + f.compressed > cdStart || (method === 0 && f.compressed !== f.size)) {
          throw new Error('This archive is damaged or incomplete.');
        }
        const raw = zip.slice(start, start + f.compressed);
        if (method === 0) {
          if (await crcOfBlob(raw) !== checksum) throw new Error('This archive is damaged (checksum mismatch).');
          return raw;
        }
        if (method === 8 && typeof DecompressionStream === 'function' && raw.stream) {
          let size = 0;
          let crc = 0;
          // Validate while streaming: never buffer output beyond the declared size,
          // and calculate the checksum without rereading the complete decoded Blob.
          const validate = new TransformStream({
            transform(chunk, controller) {
              size += chunk.byteLength;
              if (size > f.size) throw new Error('This archive is damaged or incomplete.');
              crc = crc32(chunk, crc);
              controller.enqueue(chunk);
            },
            flush() {
              if (size !== f.size) throw new Error('This archive is damaged or incomplete.');
              if (crc !== checksum) throw new Error('This archive is damaged (checksum mismatch).');
            },
          });
          return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).pipeThrough(validate)).blob();
        }
        throw new Error(`${name} uses a compression this browser cannot read.`);
      },
    });
  }
  return out;
}
