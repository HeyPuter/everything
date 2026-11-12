// Byte-level PSD builders for files with alpha and spot channels: a flat file
// from planes, and adding channels to an existing file's merged image.

export type ChannelInfo = { name: string; display?: { rgb: [number, number, number]; opacity: number; mode: number } };

const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

/** PackBits rows: runs of equal bytes as repeats, the rest as literals. */
export function packBits(row: Uint8Array): number[] {
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
    out.push(i - start - 1, ...row.subarray(start, i));
  }
  return out;
}

function resource(id: number, data: number[]) {
  return [...'8BIM'].map((c) => c.charCodeAt(0)).concat(be16(id), [0, 0], be32(data.length), data, data.length & 1 ? [0] : []);
}
/** Image resources naming the channels (1045 Unicode names, 1006 Pascal names) and their display (1077). */
export function channelResources(channels: ChannelInfo[], kind: 'unicode' | 'pascal' = 'unicode'): number[] {
  const out: number[] = [];
  if (kind === 'unicode')
    out.push(...resource(1045, channels.flatMap((c) => [...be32(c.name.length + 1), ...[...c.name].flatMap((ch) => be16(ch.charCodeAt(0))), 0, 0])));
  else out.push(...resource(1006, channels.flatMap((c) => [c.name.length, ...[...c.name].map((ch) => ch.charCodeAt(0))])));
  if (channels.some((c) => c.display))
    out.push(...resource(1077, [...be32(1), ...channels.flatMap((c) => {
      const d = c.display ?? { rgb: [255, 0, 0], opacity: 50, mode: 0 };
      return [...be16(0), ...d.rgb.flatMap((v) => be16(v * 257)), ...be16(0), ...be16(d.opacity), d.mode];
    })]));
  return out;
}

function imageData(planes: Uint8Array[], height: number, rowBytes: number, compression: 0 | 1, psb: boolean): number[] {
  if (compression === 0) return [0, 0, ...planes.flatMap((p) => [...p])];
  const rows = planes.flatMap((p) => Array.from({ length: height }, (_, y) => packBits(p.subarray(y * rowBytes, (y + 1) * rowBytes))));
  return [0, 1, ...rows.flatMap((r) => (psb ? be32(r.length) : be16(r.length))), ...rows.flat()];
}

/** A flat RGB file (no layers): `planes` are big-endian samples, color first. */
export function flatPsd(o: { width: number; height: number; depth: 8 | 16 | 32; planes: Uint8Array[]; compression: 0 | 1; resources?: number[]; psb?: boolean }): Uint8Array {
  const header = [...'8BPS'].map((c) => c.charCodeAt(0)).concat(be16(o.psb ? 2 : 1), [0, 0, 0, 0, 0, 0], be16(o.planes.length), be32(o.height), be32(o.width), be16(o.depth), be16(3));
  const res = o.resources ?? [];
  const layers = o.psb ? [0, 0, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0];
  return new Uint8Array([...header, 0, 0, 0, 0, ...be32(res.length), ...res, ...layers, ...imageData(o.planes, o.height, (o.width * o.depth) >> 3, o.compression, !!o.psb)]);
}

/** Add channels to the merged image of a PSD (not PSB) and resources describing them. */
export function addChannels(psd: Uint8Array, planes: Uint8Array[], resources: number[]): Uint8Array {
  const v = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
  const channels = v.getUint16(12),
    height = v.getUint32(14),
    width = v.getUint32(18),
    depth = v.getUint16(22);
  const rowBytes = (width * depth) >> 3;
  let o = 26;
  o += 4 + v.getUint32(o);
  const resStart = o;
  const resLength = v.getUint32(o);
  o += 4 + resLength;
  const afterResources = o;
  o += 4 + v.getUint32(o);
  const image = o;
  const compression = v.getUint16(image);
  let section: number[];
  if (compression === 0) section = [...psd.subarray(image), ...planes.flatMap((p) => [...p])];
  else {
    const counts = psd.subarray(image + 2, image + 2 + channels * height * 2);
    const rows = planes.flatMap((p) => Array.from({ length: height }, (_, y) => packBits(p.subarray(y * rowBytes, (y + 1) * rowBytes))));
    section = [0, 1, ...counts, ...rows.flatMap((r) => be16(r.length)), ...psd.subarray(image + 2 + counts.length), ...rows.flat()];
  }
  const out = new Uint8Array([
    ...psd.subarray(0, resStart),
    ...be32(resLength + resources.length),
    ...psd.subarray(resStart + 4, afterResources),
    ...resources,
    ...psd.subarray(afterResources, image),
    ...section,
  ]);
  new DataView(out.buffer).setUint16(12, channels + planes.length);
  return out;
}
