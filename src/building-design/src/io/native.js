/**
 * Native project files (.bdp): the document as JSON, gzip-compressed when
 * the platform supports it. Reading accepts compressed and plain JSON.
 */
import { Doc } from '../core/doc.js';

export const NATIVE_EXT = '.bdp';
export const MIME = 'application/x-building-design';

export async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes) {
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed projects.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeProject(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(doc.toJSON()));
  const out = await gzip(bytes);
  return new Blob([out], { type: out === bytes ? 'application/json' : 'application/octet-stream' });
}

export async function decodeProject(buffer) {
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const bytes = await gunzip(raw);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('This file is damaged or is not a project file.');
  }
  return Doc.fromJSON(data);
}

export function baseName(name) {
  return String(name || 'Untitled')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(bdp|json)$/i, '');
}

/** File name safe for most file systems. */
export function safeFileName(name) {
  return (
    String(name || 'Untitled')
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'Untitled'
  );
}
