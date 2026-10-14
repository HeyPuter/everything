// Compound File Binary (MS-CFB) — the container embedded OLE objects are
// stored in. Version 3 files (512-byte sectors), one storage level: enough to
// write an OLE Package (a file wrapped as `\x01Ole10Native`) and to read the
// streams of any embedded object back.

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

export interface CfbStream {
  readonly name: string;
  readonly data: Uint8Array;
}

const compareNames = (a: string, b: string): number =>
  a.length !== b.length
    ? a.length - b.length
    : a.toUpperCase() < b.toUpperCase()
      ? -1
      : a.toUpperCase() > b.toUpperCase()
        ? 1
        : 0;

/** Writes a compound file whose root storage holds `streams`. */
export const writeCfb = (
  streams: ReadonlyArray<CfbStream>,
  rootClsid: Uint8Array = new Uint8Array(16),
): Uint8Array => {
  const entries = [...streams].sort((a, b) => compareNames(a.name, b.name));
  // Small streams live in the mini stream, in 64-byte mini sectors.
  const mini: { start: number; count: number }[] = [];
  let miniSectors = 0;
  for (const s of entries) {
    if (s.data.length >= CUTOFF) {
      mini.push({ start: -1, count: 0 });
      continue;
    }
    const count = Math.max(1, Math.ceil(s.data.length / MINI));
    mini.push({ start: s.data.length ? miniSectors : END, count });
    if (s.data.length) miniSectors += count;
    else mini[mini.length - 1] = { start: END, count: 0 };
  }
  const miniStreamBytes = miniSectors * MINI;
  const miniStreamSectors = Math.ceil(miniStreamBytes / SECTOR);
  const miniFatSectors = Math.ceil((miniSectors * 4) / SECTOR);
  const dirSectors = Math.ceil(((entries.length + 1) * 128) / SECTOR);
  const bigSectors = entries.map((s) =>
    s.data.length >= CUTOFF ? Math.ceil(s.data.length / SECTOR) : 0,
  );
  const contentSectors =
    dirSectors +
    miniFatSectors +
    miniStreamSectors +
    bigSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < contentSectors + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error("writeCfb: object too large");
  const total = fatSectors + contentSectors;
  const out = new Uint8Array(SECTOR * (total + 1));
  const view = new DataView(out.buffer);
  const fat = new Uint32Array(fatSectors * (SECTOR / 4)).fill(FREE);
  let next = 0;
  const chain = (count: number): number => {
    if (!count) return END;
    const first = next;
    for (let i = 0; i < count; i++)
      fat[next + i] = i === count - 1 ? END : next + i + 1;
    next += count;
    return first;
  };
  for (let i = 0; i < fatSectors; i++) fat[next++] = FATSECT;
  const dirStart = chain(dirSectors);
  const miniFatStart = chain(miniFatSectors);
  const miniStreamStart = chain(miniStreamSectors);
  const bigStarts = bigSectors.map((count) => chain(count));
  const at = (sector: number) => SECTOR * (sector + 1);

  // Header
  out.set(SIGNATURE, 0);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 0x0003, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, dirStart, true);
  view.setUint32(56, CUTOFF, true);
  view.setUint32(60, miniFatSectors ? miniFatStart : END, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, END, true);
  view.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++)
    view.setUint32(76 + i * 4, i < fatSectors ? i : FREE, true);
  for (let i = 0; i < fat.length; i++)
    view.setUint32(at(Math.floor(i / 128)) + (i % 128) * 4, fat[i]!, true);

  // Mini FAT and mini stream
  const miniFat = new Uint32Array(miniFatSectors * 128).fill(FREE);
  entries.forEach((s, i) => {
    const m = mini[i]!;
    if (m.start === -1 || m.start === END) return;
    for (let k = 0; k < m.count; k++)
      miniFat[m.start + k] = k === m.count - 1 ? END : m.start + k + 1;
    const offset = m.start * MINI;
    const sector = miniStreamStart + Math.floor(offset / SECTOR);
    // The mini stream's sectors are contiguous, so a flat copy is enough.
    out.set(s.data, at(sector) + (offset % SECTOR));
  });
  for (let i = 0; i < miniFat.length; i++)
    view.setUint32(
      at(miniFatStart + Math.floor(i / 128)) + (i % 128) * 4,
      miniFat[i]!,
      true,
    );
  entries.forEach((s, i) => {
    if (bigSectors[i]) out.set(s.data, at(bigStarts[i]!));
  });

  // Directory: the root, then the streams as a balanced binary tree.
  const writeEntry = (
    index: number,
    name: string,
    type: number,
    start: number,
    size: number,
    left: number,
    right: number,
    child: number,
    clsid?: Uint8Array,
  ) => {
    const base = at(dirStart) + index * 128;
    for (let k = 0; k < name.length && k < 31; k++)
      view.setUint16(base + k * 2, name.charCodeAt(k), true);
    view.setUint16(base + 64, (Math.min(name.length, 31) + 1) * 2, true);
    out[base + 66] = type;
    out[base + 67] = 1; // black
    view.setUint32(base + 68, left, true);
    view.setUint32(base + 72, right, true);
    view.setUint32(base + 76, child, true);
    if (clsid) out.set(clsid.subarray(0, 16), base + 80);
    view.setUint32(base + 116, start, true);
    view.setUint32(base + 120, size, true);
  };
  const tree = (lo: number, hi: number): number => {
    if (lo > hi) return NOSTREAM;
    const mid = (lo + hi) >> 1;
    const s = entries[mid]!;
    const big = s.data.length >= CUTOFF;
    writeEntry(
      mid + 1,
      s.name,
      2,
      big ? bigStarts[mid]! : mini[mid]!.start,
      s.data.length,
      tree(lo, mid - 1),
      tree(mid + 1, hi),
      NOSTREAM,
    );
    return mid + 1;
  };
  const rootChild = tree(0, entries.length - 1);
  writeEntry(
    0,
    "Root Entry",
    5,
    miniStreamSectors ? miniStreamStart : END,
    miniStreamBytes,
    NOSTREAM,
    NOSTREAM,
    rootChild,
    rootClsid,
  );
  for (let i = entries.length + 1; i < dirSectors * 4; i++) {
    const base = at(dirStart) + i * 128;
    view.setUint32(base + 68, NOSTREAM, true);
    view.setUint32(base + 72, NOSTREAM, true);
    view.setUint32(base + 76, NOSTREAM, true);
  }
  return out;
};

/** The streams of a compound file (all storages flattened, by path). */
export const readCfb = (bytes: Uint8Array): CfbStream[] => {
  if (!SIGNATURE.every((b, i) => bytes[i] === b))
    throw new Error("Not a compound file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(30, true);
  const miniSize = 1 << view.getUint16(32, true);
  const cutoff = view.getUint32(56, true);
  const at = (sector: number) => sectorSize * (sector + 1);
  const u32 = (offset: number) =>
    offset + 4 <= bytes.length ? view.getUint32(offset, true) : END;
  // FAT sector locations: the header's 109, then the DIFAT chain.
  const fatLocations: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(76 + i * 4);
    if (s !== FREE) fatLocations.push(s);
  }
  let difat = u32(68);
  const per = sectorSize / 4;
  for (let guard = 0; difat !== END && difat !== FREE && guard < 1e5; guard++) {
    for (let i = 0; i < per - 1; i++) {
      const s = u32(at(difat) + i * 4);
      if (s !== FREE) fatLocations.push(s);
    }
    difat = u32(at(difat) + (per - 1) * 4);
  }
  const fat = (sector: number) => {
    const where = fatLocations[Math.floor(sector / per)];
    return where === undefined ? END : u32(at(where) + (sector % per) * 4);
  };
  const readChain = (start: number, size: number | null): Uint8Array => {
    const parts: number[] = [];
    for (
      let s = start, guard = 0;
      s !== END && s < FATSECT && guard < 1e6;
      guard++
    ) {
      parts.push(s);
      s = fat(s);
    }
    const out = new Uint8Array(parts.length * sectorSize);
    parts.forEach((s, i) =>
      out.set(bytes.subarray(at(s), at(s) + sectorSize), i * sectorSize),
    );
    return size === null ? out : out.subarray(0, size);
  };
  const dir = readChain(u32(48), null);
  const dirView = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entry = (i: number) => {
    const base = i * 128;
    const nameLength = dirView.getUint16(base + 64, true);
    let name = "";
    for (let k = 0; k < nameLength / 2 - 1; k++)
      name += String.fromCharCode(dirView.getUint16(base + k * 2, true));
    return {
      name,
      type: dir[base + 66]!,
      left: dirView.getUint32(base + 68, true),
      right: dirView.getUint32(base + 72, true),
      child: dirView.getUint32(base + 76, true),
      start: dirView.getUint32(base + 116, true),
      size: dirView.getUint32(base + 120, true),
    };
  };
  const root = entry(0);
  const miniStream = readChain(root.start, root.size);
  const miniFat = readChain(u32(60), null);
  const miniFatView = new DataView(
    miniFat.buffer,
    miniFat.byteOffset,
    miniFat.byteLength,
  );
  const readMini = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let s = start;
    for (let offset = 0; offset < size && s !== END; offset += miniSize) {
      out.set(
        miniStream.subarray(
          s * miniSize,
          s * miniSize + Math.min(miniSize, size - offset),
        ),
        offset,
      );
      s =
        (s + 1) * 4 <= miniFat.length
          ? miniFatView.getUint32(s * 4, true)
          : END;
    }
    return out;
  };
  const found: CfbStream[] = [];
  const seen = new Set<number>();
  const visit = (i: number, path: string) => {
    if (i === NOSTREAM || seen.has(i) || (i + 1) * 128 > dir.length) return;
    seen.add(i);
    const e = entry(i);
    visit(e.left, path);
    visit(e.right, path);
    if (e.type === 2)
      found.push({
        name: path + e.name,
        data:
          e.size < cutoff
            ? readMini(e.start, e.size)
            : readChain(e.start, e.size),
      });
    else if (e.type === 1) visit(e.child, `${path}${e.name}/`);
  };
  visit(root.child, "");
  return found;
};

// ---------------------------------------------------------------------------
// OLE Package: a file of any kind wrapped for embedding.

/** CLSID of the OLE Package class, {0003000C-0000-0000-C000-000000000046}. */
export const PACKAGE_CLSID = new Uint8Array([
  0x0c, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x46,
]);

const ansi = (text: string) =>
  Uint8Array.from(
    [...text].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63)),
  );

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const u16le = (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff]);
const zstr = (text: string) => concat([ansi(text), Uint8Array.of(0)]);
const utf16 = (text: string) => {
  const b = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    b[i * 2] = text.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return b;
};

/** The `\x01Ole10Native` stream for a packaged file. */
export const ole10Native = (fileName: string, data: Uint8Array): Uint8Array => {
  const temp = `C:\\Temp\\${fileName}`;
  const body = concat([
    u16le(2),
    zstr(fileName),
    zstr(fileName),
    u32le(0x00030000),
    u32le(ansi(temp).length + 1),
    zstr(temp),
    u32le(data.length),
    data,
    u32le(temp.length),
    utf16(temp),
    u32le(fileName.length),
    utf16(fileName),
    u32le(fileName.length),
    utf16(fileName),
  ]);
  return concat([u32le(body.length), body]);
};

const compObj = (): Uint8Array =>
  concat([
    u16le(1),
    u16le(0xfffe),
    u32le(0x00000a03),
    u32le(0xffffffff),
    PACKAGE_CLSID,
    u32le(12),
    zstr("OLE Package"),
    u32le(0),
    u32le(8),
    zstr("Package"),
    u32le(0x71b239f4),
    u32le(0),
    u32le(0),
    u32le(0),
  ]);

/** A compound file holding `data` as an OLE Package named `fileName`. */
export const writeOlePackage = (fileName: string, data: Uint8Array) =>
  writeCfb(
    [
      { name: "\x01Ole10Native", data: ole10Native(fileName, data) },
      { name: "\x01CompObj", data: compObj() },
      { name: "\x03ObjInfo", data: Uint8Array.of(0, 0, 3, 0, 4, 0) },
    ],
    PACKAGE_CLSID,
  );

/** The file inside an OLE Package, or null for other kinds of object. */
export const readOlePackage = (
  bytes: Uint8Array,
): { name: string; data: Uint8Array } | null => {
  const native = readCfb(bytes).find((s) => s.name === "\x01Ole10Native");
  if (!native) return null;
  const b = native.data;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 6;
  const cstr = () => {
    const start = at;
    while (at < b.length && b[at] !== 0) at++;
    const text = String.fromCharCode(...b.subarray(start, at));
    at++;
    return text;
  };
  try {
    const label = cstr();
    cstr();
    at += 4;
    const tempLength = view.getUint32(at, true);
    at += 4 + tempLength;
    const size = view.getUint32(at, true);
    at += 4;
    const data = b.slice(at, at + size);
    at += size;
    let name = label;
    // A Unicode label, when present, keeps characters ANSI could not.
    if (at + 4 <= b.length) {
      const n = view.getUint32(at, true);
      at += 4 + n * 2;
      if (at + 4 <= b.length) {
        const m = view.getUint32(at, true);
        at += 4;
        if (at + m * 2 <= b.length && m > 0) {
          let text = "";
          for (let i = 0; i < m; i++)
            text += String.fromCharCode(view.getUint16(at + i * 2, true));
          name = text;
        }
      }
    }
    return { name, data };
  } catch {
    return null;
  }
};
