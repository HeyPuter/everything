// zlib/Deflate decompression with an output limit. A few megabytes of
// Deflate can expand to gigabytes, so readers that know how much data an
// image needs stop there instead of inflating everything a file holds.
import { Inflate } from 'pako';

/** Inflate at most `max` bytes. Returns the (possibly cut) output, or
 * undefined when the stream is corrupt or ends early, as pako's `inflate`
 * does; a stream that holds more than `max` bytes is cut at `max`. */
export function inflateLimited(src: Uint8Array, max: number, opts: { raw?: boolean } = {}): Uint8Array | undefined {
  const inflator = new Inflate({ raw: !!opts.raw, chunkSize: Math.max(1024, Math.min(1 << 16, max)) });
  const parts: Uint8Array[] = [];
  let n = 0;
  const full = new Error('full');
  inflator.onData = (chunk: Uint8Array) => {
    const take = Math.min(chunk.length, max - n);
    if (take > 0) parts.push(take === chunk.length ? chunk : chunk.subarray(0, take));
    n += take;
    if (n >= max) throw full;
  };
  let cut = false;
  try {
    inflator.push(src, true);
  } catch (e) {
    if (e !== full) throw e;
    cut = true;
  }
  // `ended` is set once the stream's end was reached (pako's types omit it).
  if (!cut && (inflator.err || !(inflator as unknown as { ended: boolean }).ended)) return undefined;
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
