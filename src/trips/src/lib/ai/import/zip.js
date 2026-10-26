// Minimal ZIP reader for small archives held in memory (PKPass). Stored and deflated entries only.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input?.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  throw new ZipError('zip_invalid');
}

async function inflate(data, limit) {
  if (typeof DecompressionStream !== 'function') throw new ZipError('zip_unsupported');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } })
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let step;
    try { step = await reader.read(); } catch { throw new ZipError('zip_invalid'); }
    if (step.done) break;
    total += step.value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new ZipError('zip_too_large'); }
    chunks.push(step.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/**
 * Entries of a ZIP archive: `[{name, size, read()}]`, where `read()` resolves to the entry's bytes.
 * `maxEntryBytes` caps each inflated entry so a crafted archive cannot exhaust memory.
 */
export async function readZip(input, { maxEntryBytes = 2 * 1024 * 1024, maxEntries = 500 } = {}) {
  const bytes = await bytesOf(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new ZipError('zip_invalid');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('zip_invalid');
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const start = view.getUint32(eocd + 16, true);
  if (count > maxEntries || start + size > bytes.length) throw new ZipError('zip_invalid');
  const decoder = new TextDecoder();
  const entries = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL) throw new ZipError('zip_invalid');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const length = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name, size: length,
      async read() {
        if (flags & 1) throw new ZipError('zip_encrypted');
        if (length > maxEntryBytes) throw new ZipError('zip_too_large');
        if (offset + 30 > bytes.length || view.getUint32(offset, true) !== LOCAL) throw new ZipError('zip_invalid');
        const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
        if (dataStart + compressed > bytes.length) throw new ZipError('zip_invalid');
        const data = bytes.subarray(dataStart, dataStart + compressed);
        if (method === 0) return data.slice();
        if (method === 8) return inflate(data, maxEntryBytes);
        throw new ZipError('zip_unsupported');
      },
    });
  }
  return entries;
}
