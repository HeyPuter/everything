import type { AdjustmentSpec } from '../model/document';

// Change detection for adjustment layers runs every frame. Large payloads
// (a .cube file's text, a baked table) would make a plain JSON key cost
// milliseconds, so long strings are replaced by an interned token (equal
// text, equal token; strings are immutable) and typed arrays by their length
// and a 64-bit digest of their bytes.
const internedText = new Map<string, number>();
let nextTextToken = 0;
function textToken(s: string): number {
  let t = internedText.get(s);
  if (t === undefined) {
    if (internedText.size >= 32) internedText.delete(internedText.keys().next().value!);
    internedText.set(s, (t = nextTextToken++));
  }
  return t;
}
function bytesDigest(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const words = bytes.byteLength >> 2;
  const w = v.byteOffset % 4 === 0 ? new Uint32Array(v.buffer, v.byteOffset, words) : undefined;
  let h1 = 0x811c9dc5 ^ bytes.byteLength,
    h2 = 0x9e3779b9;
  for (let i = 0; i < words; i++) {
    const x = w
      ? w[i]
      : bytes[i * 4] |
        (bytes[i * 4 + 1] << 8) |
        (bytes[i * 4 + 2] << 16) |
        (bytes[i * 4 + 3] << 24);
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ x, 0x85ebca6b) ^ (h2 >>> 13);
  }
  for (let i = words * 4; i < bytes.byteLength; i++) h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
  return `${v.constructor.name}:${bytes.byteLength}:${h1 >>> 0}:${h2 >>> 0}`;
}
export function adjustmentKey(spec: AdjustmentSpec | undefined): string {
  return (
    JSON.stringify(spec, (_k, v) =>
      typeof v === 'string' && v.length > 1024
        ? `\u0000text:${textToken(v)}`
        : ArrayBuffer.isView(v)
          ? `\u0000bytes:${bytesDigest(v)}`
          : v,
    ) ?? ''
  );
}
