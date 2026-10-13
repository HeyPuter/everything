// JUMBF boxes (ISO/IEC 19566-5): a superbox 'jumb' starts with a description
// box 'jumd' (16-byte type UUID, toggles, optional label and ID) followed by
// content boxes ('cbor', 'json', ...) or nested superboxes. Boxes are ISO
// BMFF style: 32-bit big-endian length (LBox) and a four-character type.
import { CodecError, asciiAt } from '../codecs/bytes';

export type JumbfContent = { kind: 'content'; type: string; data: Uint8Array; start?: number; end?: number };
export type JumbfSuperbox = {
  kind: 'super';
  uuid: Uint8Array;
  label?: string;
  // Description toggles; bit 0x01 requestable, 0x02 label, 0x04 ID, 0x08 signature.
  toggles: number;
  id?: number;
  // Signature (0x08) and private box (0x10) of the description, kept raw.
  extra?: Uint8Array;
  children: JumbfBox[];
  // Byte range of the whole box in the parsed input and where its contents
  // start after the header (reader only).
  start?: number;
  end?: number;
  body?: number;
};
export type JumbfBox = JumbfContent | JumbfSuperbox;

/** Type UUID "XXXXXXXX-0011-0010-8000-00AA00389B71" whose first four bytes spell `fourcc`. */
export function jumbfUuid(fourcc: string): Uint8Array {
  const u = new Uint8Array(16);
  for (let i = 0; i < 4; i++) u[i] = fourcc.charCodeAt(i);
  u.set([0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 4);
  return u;
}
/** The fourcc of a type UUID in the ISO family above, else undefined. */
export function uuidFourcc(u: Uint8Array): string | undefined {
  const tail = jumbfUuid('    ').subarray(4);
  return u.length === 16 && tail.every((v, i) => u[4 + i] === v) ? asciiAt(u, 0, 4) : undefined;
}

export const superbox = (fourcc: string, label: string, children: JumbfBox[]): JumbfSuperbox => ({ kind: 'super', uuid: jumbfUuid(fourcc), label, toggles: 0x03, children });
export const contentBox = (type: string, data: Uint8Array): JumbfContent => ({ kind: 'content', type, data });

function header(size: number, type: string): Uint8Array {
  if (size > 0xffffffff) throw new CodecError('JUMBF box exceeds 4 GB.');
  const h = new Uint8Array(8);
  new DataView(h.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) h[4 + i] = type.charCodeAt(i);
  return h;
}
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

function descriptionPayload(b: JumbfSuperbox): Uint8Array {
  const parts = [b.uuid, Uint8Array.of(b.toggles)];
  if (b.toggles & 0x02) parts.push(new TextEncoder().encode(b.label ?? ''), Uint8Array.of(0));
  if (b.toggles & 0x04) {
    const id = new Uint8Array(4);
    new DataView(id.buffer).setUint32(0, b.id ?? 0);
    parts.push(id);
  }
  if (b.extra) parts.push(b.extra);
  return join(parts);
}

/** Serialize a box (superbox with its description, or a content box). */
export function writeJumbf(b: JumbfBox): Uint8Array {
  if (b.kind === 'content') return join([header(8 + b.data.length, b.type), b.data]);
  const d = descriptionPayload(b);
  const body = [header(8 + d.length, 'jumd'), d, ...b.children.map(writeJumbf)];
  return join([header(8 + body.reduce((n, p) => n + p.length, 0), 'jumb'), ...body]);
}

/** Boxes in `bytes[start, end)`. LBox 0 runs to the end; LBox 1 reads a 64-bit XLBox. */
function readBoxes(bytes: Uint8Array, start: number, end: number, depth: number): JumbfBox[] {
  if (depth > 32) throw new CodecError('JUMBF boxes are nested too deeply.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: JumbfBox[] = [];
  let p = start;
  while (p < end) {
    if (p + 8 > end) throw new CodecError('JUMBF box header is truncated.');
    let size = dv.getUint32(p);
    const type = asciiAt(bytes, p + 4, 4);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) throw new CodecError('JUMBF box header is truncated.');
      size = dv.getUint32(p + 8) * 0x100000000 + dv.getUint32(p + 12);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head || p + size > end) throw new CodecError(`JUMBF box ${type} has a bad length.`);
    const boxEnd = p + size;
    if (type === 'jumb') out.push(readSuperbox(bytes, p, p + head, boxEnd, depth));
    else out.push({ kind: 'content', type, data: bytes.subarray(p + head, boxEnd), start: p, end: boxEnd });
    p = boxEnd;
  }
  return out;
}
function readSuperbox(bytes: Uint8Array, start: number, body: number, end: number, depth: number): JumbfSuperbox {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (body + 8 > end || asciiAt(bytes, body + 4, 4) !== 'jumd') throw new CodecError('JUMBF superbox has no description box.');
  const dEnd = body + dv.getUint32(body);
  if (dEnd > end || dEnd < body + 25) throw new CodecError('JUMBF description box has a bad length.');
  let p = body + 8;
  const uuid = bytes.slice(p, p + 16);
  const toggles = bytes[p + 16];
  p += 17;
  const box: JumbfSuperbox = { kind: 'super', uuid, toggles, children: [], start, end, body };
  if (toggles & 0x02) {
    const z = bytes.indexOf(0, p);
    if (z < 0 || z >= dEnd) throw new CodecError('JUMBF label is not terminated.');
    box.label = new TextDecoder().decode(bytes.subarray(p, z));
    p = z + 1;
  }
  if (toggles & 0x04) {
    if (p + 4 > dEnd) throw new CodecError('JUMBF description is truncated.');
    box.id = dv.getUint32(p);
    p += 4;
  }
  if (p < dEnd) box.extra = bytes.slice(p, dEnd);
  box.children = readBoxes(bytes, dEnd, end, depth + 1);
  return box;
}

/** Parse a buffer holding one top-level JUMBF superbox. */
export function readJumbf(bytes: Uint8Array): JumbfSuperbox {
  const [b] = readBoxes(bytes, 0, bytes.length, 0);
  if (b?.kind !== 'super') throw new CodecError('Not a JUMBF superbox.');
  return b;
}

/** Child superbox by label. */
export const childByLabel = (b: JumbfSuperbox, label: string) =>
  b.children.find((c): c is JumbfSuperbox => c.kind === 'super' && c.label === label);
/** First content box of a superbox, optionally of one type. */
export const firstContent = (b: JumbfSuperbox, type?: string) =>
  b.children.find((c): c is JumbfContent => c.kind === 'content' && (!type || c.type === type));
