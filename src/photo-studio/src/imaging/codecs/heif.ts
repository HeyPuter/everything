// Pixel size of an AVIF or HEIC image from its ISO base media boxes (ftyp,
// meta → pitm, iprp → ipco/ipma → ispe), so oversized images can be refused
// before the browser decodes them. Only the header is read.
import { asciiAt } from './bytes';

type Box = { type: string; start: number; body: number; end: number };

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let o = from;
  while (o + 8 <= to) {
    let size = be32(o);
    let body = o + 8;
    if (size === 1) {
      if (o + 16 > to) return;
      // 64-bit sizes: anything past 2^32 runs beyond what was read.
      size = be32(o + 8) ? Infinity : be32(o + 12);
      body = o + 16;
    } else if (size === 0) size = to - o;
    if (size < body - o) return;
    const end = Math.min(to, o + size);
    yield { type: asciiAt(b, o + 4, 4), start: o, body, end };
    if (o + size >= to) return;
    o += size;
  }
}
const child = (b: Uint8Array, parent: Box, type: string, skip = 0) => {
  for (const x of boxes(b, parent.body + skip, parent.end)) if (x.type === type) return x;
};

/** Width and height of the primary image (undefined when the boxes are not
 * found in `b`, for example because only the start of the file was read). */
export function heifImageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const be16 = (o: number) => (b[o] << 8) | b[o + 1];
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let meta: Box | undefined;
  for (const x of boxes(b, 0, b.length))
    if (x.type === 'meta') {
      meta = x;
      break;
    }
  if (!meta) return undefined;
  // meta, pitm, ipma are full boxes: one version byte and three flag bytes.
  const iprp = child(b, meta, 'iprp', 4);
  const ipco = iprp && child(b, iprp, 'ipco');
  if (!iprp || !ipco) return undefined;
  const props: Box[] = [...boxes(b, ipco.body, ipco.end)];
  const sizeOf = (p: Box | undefined) => (p?.type === 'ispe' && p.body + 12 <= p.end ? { width: be32(p.body + 4), height: be32(p.body + 8) } : undefined);
  const pitm = child(b, meta, 'pitm', 4);
  const ipma = child(b, iprp, 'ipma');
  if (pitm && ipma && pitm.body + 6 <= pitm.end) {
    const primary = b[pitm.body] === 0 ? be16(pitm.body + 4) : be32(pitm.body + 4);
    const version = b[ipma.body],
      wide = b[ipma.body + 3] & 1;
    let o = ipma.body + 4;
    const count = o + 4 <= ipma.end ? be32(o) : 0;
    o += 4;
    for (let i = 0; i < count && o < ipma.end; i++) {
      const item = version < 1 ? be16(o) : be32(o);
      o += version < 1 ? 2 : 4;
      const n = b[o++];
      for (let k = 0; k < n && o < ipma.end; k++) {
        const index = wide ? be16(o) & 0x7fff : b[o] & 0x7f;
        o += wide ? 2 : 1;
        const size = item === primary ? sizeOf(props[index - 1]) : undefined;
        if (size) return size;
      }
    }
  }
  // Without associations, the largest stated size (thumbnails and grid tiles
  // are smaller than the image they belong to).
  let best: { width: number; height: number } | undefined;
  for (const p of props) {
    const s = sizeOf(p);
    if (s && (!best || s.width * s.height > best.width * best.height)) best = s;
  }
  return best;
}
