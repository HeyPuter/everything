// Shared tiles and asset chunks travel deflated and are addressed by the
// SHA-256 of their uncompressed bytes. Both ends inflate with a size cap and
// check the hash, so nobody can store garbage under another tile's address.
import { deflate, Inflate } from 'pako';
import { decode, encode, hash } from './protocol';

/** Largest uncompressed asset chunk. */
export const MAX_CHUNK = 4 * 1024 * 1024;

export function packAsset(bytes: Uint8Array) {
  return encode(deflate(bytes, { level: 3 }));
}
/** Inflate and verify an asset; throws when it is not what `expected` names. */
export async function unpackAsset(data: unknown, expected: string, max = MAX_CHUNK): Promise<Uint8Array> {
  const packed = decode(data, Math.ceil((max * 1.02 + 1024) / 3) * 4);
  const inflator = new Inflate({ chunkSize: 65536 });
  const parts: Uint8Array[] = [];
  let total = 0,
    over = false;
  inflator.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > max) {
      // Stop inflating at once: a small input can expand enormously.
      over = true;
      throw new Error('Invalid shared asset.');
    }
    parts.push(chunk.slice());
  };
  try {
    inflator.push(packed, true);
  } catch {
    over = true;
  }
  if (over || inflator.err) throw new Error('Invalid shared asset.');
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if ((await hash(out)) !== expected) throw new Error('Invalid shared asset.');
  return out;
}
