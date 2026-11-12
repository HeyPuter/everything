// Alpha and spot channels of RGB PSD/PSB files (saved selections, spot inks).
// The PSD codec only reads the color and transparency channels of the merged
// image correctly, so the extra channels are taken out of the image data
// section here, decoded as 8-bit planes, and the codec is given the file
// without them (header channel count and image data rewritten).

export type PsdExtraChannel = {
  name: string;
  // One 8-bit sample per pixel, as stored (white = selected for alpha channels).
  data: Uint8Array;
  color?: string;
  opacity?: number;
  spot?: boolean;
};
export type PsdChannelSplit = {
  // The file with only the color (and transparency) channels in its merged image.
  bytes: Uint8Array;
  extras: PsdExtraChannel[];
};

type Sections = { psb: boolean; channels: number; width: number; height: number; depth: number; resources: [number, number]; layerCount?: number; imageData: number };

function sections(b: Uint8Array): Sections | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 26) return;
  const psb = v.getUint16(4) === 2;
  const len = (o: number, wide: boolean) => (wide ? Number(v.getBigUint64(o)) : v.getUint32(o));
  let o = 26;
  if (o + 4 > b.length) return;
  o += 4 + v.getUint32(o);
  if (o + 4 > b.length) return;
  const resources: [number, number] = [o + 4, o + 4 + v.getUint32(o)];
  o = resources[1];
  const w = psb ? 8 : 4;
  if (o + w > b.length) return;
  const layerSection = len(o, psb);
  let layerCount: number | undefined;
  // Layer info: its own length, then a signed layer count (negative when the
  // first extra channel of the merged image is its transparency).
  if (layerSection >= w + 2 && o + w + w + 2 <= b.length && len(o + w, psb) >= 2) layerCount = v.getInt16(o + w + w);
  o += w + layerSection;
  if (o + 2 > b.length) return;
  return { psb, channels: v.getUint16(12), height: v.getUint32(14), width: v.getUint32(18), depth: v.getUint16(22), resources, layerCount, imageData: o };
}

function resourceData(b: Uint8Array, [start, end]: [number, number], id: number): Uint8Array | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start;
  while (o + 12 <= end) {
    const rid = v.getUint16(o + 4);
    const nameLength = b[o + 6];
    o += 6 + ((nameLength + 2) & ~1);
    if (o + 4 > end) return;
    const size = v.getUint32(o);
    o += 4;
    if (o + size > end) return;
    if (rid === id) return b.subarray(o, o + size);
    o += (size + 1) & ~1;
  }
}

// Alpha identifiers (1053): one per extra channel, 0 for the merged image's
// transparency. The surest sign of which extra channel is transparency.
function alphaIdentifiers(b: Uint8Array, s: Sections): number[] | undefined {
  const data = resourceData(b, s.resources, 1053);
  if (!data) return;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return Array.from({ length: data.length >> 2 }, (_, i) => v.getUint32(i * 4));
}

function channelNames(b: Uint8Array, s: Sections): string[] | undefined {
  const unicode = resourceData(b, s.resources, 1045);
  if (unicode) {
    const v = new DataView(unicode.buffer, unicode.byteOffset, unicode.byteLength);
    const names: string[] = [];
    for (let o = 0; o + 4 <= unicode.length; ) {
      const n = v.getUint32(o);
      o += 4;
      if (o + n * 2 > unicode.length) break;
      let name = '';
      for (let i = 0; i < n; i++) name += String.fromCharCode(v.getUint16(o + i * 2));
      o += n * 2;
      names.push(name.replace(/\0+$/, ''));
    }
    return names;
  }
  const pascal = resourceData(b, s.resources, 1006);
  if (pascal) {
    const names: string[] = [];
    for (let o = 0; o < pascal.length; ) {
      const n = pascal[o++];
      names.push(String.fromCharCode(...pascal.subarray(o, o + n)));
      o += n;
    }
    return names;
  }
}

type Display = { color?: string; opacity: number; spot: boolean };
function displayInfo(b: Uint8Array, s: Sections): Display[] {
  const read = (data: Uint8Array, at: number, stride: number) => {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: Display[] = [];
    for (let o = at; o + 13 <= data.length; o += stride) {
      const space = v.getUint16(o);
      const hex = (k: number) => Math.round(v.getUint16(o + 2 + k * 2) / 257).toString(16).padStart(2, '0');
      out.push({ color: space === 0 ? `#${hex(0)}${hex(1)}${hex(2)}` : undefined, opacity: Math.max(0, Math.min(100, v.getUint16(o + 10))) / 100, spot: data[o + 12] === 2 });
    }
    return out;
  };
  // 1077 (version, then 13 bytes per channel) supersedes 1007 (14 bytes).
  const current = resourceData(b, s.resources, 1077);
  if (current && current.length >= 4) return read(current, 4, 13);
  const legacy = resourceData(b, s.resources, 1007);
  return legacy ? read(legacy, 0, 14) : [];
}

function unpackBits(src: Uint8Array, out: Uint8Array) {
  let i = 0,
    o = 0;
  while (i < src.length && o < out.length) {
    const n = src[i++];
    if (n < 128) {
      const count = Math.min(n + 1, out.length - o, src.length - i);
      out.set(src.subarray(i, i + count), o);
      i += n + 1;
      o += count;
    } else if (n > 128) {
      const count = Math.min(257 - n, out.length - o);
      out.fill(src[i++] ?? 0, o, o + count);
      o += count;
    }
  }
}

function toMask(plane: Uint8Array, depth: number, pixels: number): Uint8Array {
  if (depth === 8) return plane.slice(0, pixels);
  const v = new DataView(plane.buffer, plane.byteOffset, plane.byteLength);
  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++)
    out[i] = depth === 16 ? Math.round(v.getUint16(i * 2) / 257) : Math.round(Math.max(0, Math.min(1, v.getFloat32(i * 4) || 0)) * 255);
  return out;
}

/** Split the extra channels off an RGB PSD/PSB; undefined when it has none
 * (or its merged image is stored in a way left to the codec). */
export function splitPsdChannels(bytes: Uint8Array, maxBytes = Infinity): PsdChannelSplit | undefined {
  const s = sections(bytes);
  if (!s || s.channels <= 3) return;
  // More names than extra channels: left over from a file whose channels were
  // dropped by another writer, so they say nothing about these channels.
  const listed = channelNames(bytes, s);
  const names = listed && listed.length <= s.channels - 3 ? listed : undefined;
  const display = displayInfo(bytes, s);
  // The alpha channel names list every extra channel; one more channel is the
  // transparency of the merged image. Without names, a negative layer count
  // (or a lone fourth channel) marks transparency.
  const ids = alphaIdentifiers(bytes, s);
  const transparency =
    ids && ids.length <= s.channels - 3
      ? ids.includes(0) || s.channels - 3 - ids.length >= 1
      : names
        ? s.channels - 3 - names.length >= 1
        : s.channels === 4 || (s.layerCount ?? 0) < 0;
  const keep = transparency ? 4 : 3;
  const count = s.channels - keep;
  if (count <= 0) return;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compression = v.getUint16(s.imageData);
  if (compression > 1) return;
  const rowBytes = (s.width * s.depth) >> 3,
    planeBytes = rowBytes * s.height,
    pixels = s.width * s.height;
  if (count * planeBytes > maxBytes) throw new Error('PSD exceeds the 512 MB decoded pixel budget.');
  const body = s.imageData + 2;
  const planes: Uint8Array[] = [];
  let section: Uint8Array;
  if (compression === 0) {
    if (body + planeBytes * s.channels > bytes.length) return;
    for (let c = keep; c < s.channels; c++) planes.push(bytes.subarray(body + c * planeBytes, body + (c + 1) * planeBytes));
    section = bytes.subarray(s.imageData, body + keep * planeBytes);
  } else {
    const entry = s.psb ? 4 : 2;
    const rows = s.channels * s.height;
    if (body + rows * entry > bytes.length) return;
    const counts = new Array<number>(rows);
    for (let r = 0; r < rows; r++) counts[r] = s.psb ? v.getUint32(body + r * 4) : v.getUint16(body + r * 2);
    let o = body + rows * entry;
    const starts: number[] = [];
    for (let r = 0; r < rows; r++) {
      starts.push(o);
      o += counts[r];
    }
    if (o > bytes.length) return;
    for (let c = keep; c < s.channels; c++) {
      const plane = new Uint8Array(planeBytes);
      for (let y = 0; y < s.height; y++) {
        const r = c * s.height + y;
        unpackBits(bytes.subarray(starts[r], starts[r] + counts[r]), plane.subarray(y * rowBytes, (y + 1) * rowBytes));
      }
      planes.push(plane);
    }
    // Compression word, the kept channels' row counts and their rows.
    const keptRows = keep * s.height;
    const dataStart = body + rows * entry;
    const dataEnd = keptRows < rows ? starts[keptRows] : o;
    section = new Uint8Array(2 + keptRows * entry + (dataEnd - dataStart));
    section.set(bytes.subarray(s.imageData, body + keptRows * entry));
    section.set(bytes.subarray(dataStart, dataEnd), 2 + keptRows * entry);
  }
  const out = new Uint8Array(s.imageData + section.length);
  out.set(bytes.subarray(0, s.imageData));
  out.set(section, s.imageData);
  new DataView(out.buffer).setUint16(12, keep);
  const extras = planes.map((plane, i): PsdExtraChannel => {
    const d = display[i];
    const name = names?.[i]?.trim();
    return {
      name: name || (d?.spot ? `Spot Color ${i + 1}` : `Alpha ${i + 1}`),
      data: toMask(plane, s.depth, pixels),
      ...(d?.color ? { color: d.color } : {}),
      ...(d ? { opacity: d.opacity } : {}),
      ...(d?.spot ? { spot: true } : {}),
    };
  });
  return { bytes: out, extras };
}

function packRow(row: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < row.length && i - start < 128 && !(i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2])) i++;
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(row[k]);
  }
  return out;
}
function resourceRecord(id: number, data: number[]): number[] {
  const n = data.length;
  return [0x38, 0x42, 0x49, 0x4d, id >> 8, id & 255, 0, 0, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...data, ...(n & 1 ? [0] : [])];
}
// Resources that describe the extra channels; replaced when channels are written.
export const channelResourceIds = [1006, 1007, 1045, 1053, 1077];

/** Add channels to the merged image of a written PSD/PSB (after its color and
 * transparency channels), with resources naming them. `data` is 8-bit. */
export function appendPsdChannels(bytes: Uint8Array, channels: PsdExtraChannel[]): Uint8Array {
  const s = sections(bytes);
  if (!s || !channels.length) return bytes;
  if (s.channels + channels.length > 56) throw new Error('A PSD file holds at most 53 alpha and spot channels.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compression = v.getUint16(s.imageData);
  if (compression > 1) throw new Error('Unsupported PSD image data compression.');
  const pixels = s.width * s.height,
    rowBytes = (s.width * s.depth) >> 3;
  const planes = channels.map((c) => {
    const out = new Uint8Array(rowBytes * s.height);
    const w = new DataView(out.buffer);
    for (let i = 0; i < pixels; i++) {
      const x = c.data[i];
      if (s.depth === 8) out[i] = x;
      else if (s.depth === 16) w.setUint16(i * 2, x * 257);
      else w.setFloat32(i * 4, x / 255);
    }
    return out;
  });
  let section: Uint8Array;
  const old = bytes.subarray(s.imageData);
  if (compression === 0) {
    section = new Uint8Array(old.length + planes.length * planes[0].length);
    section.set(old);
    planes.forEach((p, i) => section.set(p, old.length + i * p.length));
  } else {
    const entry = s.psb ? 4 : 2;
    const table = s.channels * s.height * entry;
    const rows = planes.flatMap((p) => Array.from({ length: s.height }, (_, y) => packRow(p.subarray(y * rowBytes, (y + 1) * rowBytes))));
    const counts = new Uint8Array(rows.length * entry);
    const cv = new DataView(counts.buffer);
    rows.forEach((r, i) => (s.psb ? cv.setUint32(i * 4, r.length) : cv.setUint16(i * 2, r.length)));
    const data = Uint8Array.from(rows.flat());
    section = new Uint8Array(old.length + counts.length + data.length);
    section.set(old.subarray(0, 2 + table));
    section.set(counts, 2 + table);
    section.set(old.subarray(2 + table), 2 + table + counts.length);
    section.set(data, old.length + counts.length);
  }
  // Image resources: the old channel descriptions out, the new ones in.
  const [start, end] = s.resources;
  const kept: Uint8Array[] = [];
  for (let o = start; o + 12 <= end; ) {
    const id = v.getUint16(o + 4);
    const nameEnd = o + 6 + ((bytes[o + 6] + 2) & ~1);
    const size = v.getUint32(nameEnd);
    const next = nameEnd + 4 + ((size + 1) & ~1);
    if (!channelResourceIds.includes(id)) kept.push(bytes.subarray(o, next));
    o = next;
  }
  const be32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const unicode = channels.flatMap((c) => [...be32(c.name.length + 1), ...[...c.name].flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255]), 0, 0]);
  const pascal = channels.flatMap((c) => {
    const name = [...c.name].map((ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63)).slice(0, 255);
    return [name.length, ...name];
  });
  const rgb = (hex: string | undefined) => (hex && /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) * 257) : [65535, 0, 0]);
  const display = [0, 0, 0, 1, ...channels.flatMap((c) => {
    const opacity = Math.round((c.opacity ?? (c.spot ? 1 : 0.5)) * 100);
    return [0, 0, ...rgb(c.color).flatMap((x) => [x >> 8, x & 255]), 0, 0, 0, opacity, c.spot ? 2 : 0];
  })];
  // Identifiers tell readers which extra channel is transparency (0), as the
  // format defines them; without them some take the last channel for it.
  const identifiers = [...(s.channels > 3 ? [0] : []), ...channels.map((_, i) => i + 1)].flatMap(be32);
  const added = Uint8Array.from([...resourceRecord(1006, pascal), ...resourceRecord(1045, unicode), ...resourceRecord(1053, identifiers), ...resourceRecord(1077, display)]);
  const resources = kept.reduce((n, k) => n + k.length, 0) + added.length;
  const out = new Uint8Array(start + resources + (s.imageData - end) + section.length);
  out.set(bytes.subarray(0, start));
  let at = start;
  for (const k of kept) {
    out.set(k, at);
    at += k.length;
  }
  out.set(added, at);
  at += added.length;
  out.set(bytes.subarray(end, s.imageData), at);
  at += s.imageData - end;
  out.set(section, at);
  const ov = new DataView(out.buffer);
  ov.setUint32(start - 4, resources);
  ov.setUint16(12, s.channels + channels.length);
  return out;
}
