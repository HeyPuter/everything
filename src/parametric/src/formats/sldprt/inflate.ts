// Decompression through the platform's DecompressionStream (browsers, workers
// and Node 18+), so no inflate library ships with the app.

/** Raw DEFLATE ('deflate-raw') or zlib ('deflate') data. Returns whatever was
 *  decoded before an error, or null when nothing could be. */
export async function inflate(data: Uint8Array, format: 'deflate' | 'deflate-raw', limit = 512 * 1024 * 1024): Promise<Uint8Array | null> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  // Errors surface on the reader; the writer's promises must not go unhandled.
  writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      if (total > limit) throw new Error('Decompressed data is too large');
    }
  } catch (e) {
    if (total > limit) throw e;
    // Truncated or followed by trailing bytes: keep what was decoded.
    reader.cancel().catch(() => {});
    if (!total) return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
