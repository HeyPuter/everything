// Minimal ZIP (store, no compression) writer and reader, used to download a
// session with its media as one file and to open it again. Audio does not
// compress well with deflate, so storing keeps this small and fast.

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

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Limits of a plain (non-ZIP64) archive: 32-bit sizes and offsets and a
 * 16-bit entry count. Past them the fields would wrap and the archive be
 * corrupt, so the writer refuses instead.
 */
export const ZIP_LIMITS = { bytes: 0xffffffff, entries: 0xffff };

/**
 * Why `entries` ([{ name, size }]) cannot be stored in one ZIP, or ''.
 * Checked before any data is read, so callers can fall back early.
 */
export function zipProblem(entries, limits = ZIP_LIMITS) {
  if (entries.length > limits.entries) return `A ZIP file holds at most ${limits.entries} files; there are ${entries.length}.`;
  const enc = new TextEncoder();
  let total = 22;
  for (const e of entries) total += 30 + 46 + 2 * enc.encode(e.name).length + e.size;
  if (total > limits.bytes) return `These files add up to more than ${limits.bytes >= 0xffffffff ? '4 GB' : `${limits.bytes} bytes`}, more than a ZIP file can hold.`;
  return '';
}

/**
 * @param {{ name: string, data: Uint8Array }[]} files
 * @param {{ limits?: { bytes: number, entries: number } }} [o] (tests lower the limits)
 * @returns {Blob} application/zip
 */
export function zipStore(files, { limits = ZIP_LIMITS } = {}) {
  const problem = zipProblem(files.map((f) => ({ name: f.name, size: f.data.length })), limits);
  if (problem) throw new Error(problem);
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // store
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/** Reads a stored (uncompressed) ZIP: Map(name -> Uint8Array). Compressed entries are skipped. */
export function unzipStore(buffer) {
  const dv = new DataView(buffer);
  const dec = new TextDecoder();
  const out = new Map();
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true);
    const comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
    if (method === 0) {
      const lNameLen = dv.getUint16(local + 26, true);
      const lExtra = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtra;
      out.set(name, new Uint8Array(buffer, start, size));
    }
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
