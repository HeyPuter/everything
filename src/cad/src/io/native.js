/**
 * Native drawing files (.cad): the drawing as JSON, gzip-compressed when the
 * platform supports it. Reading accepts both compressed and plain JSON.
 */
export const NATIVE_EXT = '.cad';
export const FORMAT = 'cad-drawing';

export async function encodeDrawing(drawing) {
  const json = JSON.stringify({ format: FORMAT, ...drawing.toJSON() });
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'undefined') return new Blob([bytes], { type: 'application/json' });
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = await new Response(stream).arrayBuffer();
  return new Blob([out], { type: 'application/octet-stream' });
}

/** Parse native file bytes into plain drawing data (see schema.js). */
export async function decodeDrawing(buffer) {
  let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed drawings.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (!data || (data.format && data.format !== FORMAT) || !Array.isArray(data.entities)) throw new Error('This is not a drawing file.');
  return validate(data);
}

/** Drop malformed records so a damaged file still opens. */
function validate(data) {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  data.entities = data.entities.filter((e) => e && typeof e.type === 'string' && finite(e.id));
  data.layers = (data.layers || []).filter((l) => l && typeof l.name === 'string');
  data.blocks = (data.blocks || []).filter((b) => b && typeof b.name === 'string' && Array.isArray(b.entities));
  return data;
}

/** File kind from a name: 'native' | 'dxf' | 'dwg' | null. */
export function fileKind(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith(NATIVE_EXT)) return 'native';
  if (n.endsWith('.dxf')) return 'dxf';
  if (n.endsWith('.dwg')) return 'dwg';
  return null;
}

/** File name extension for a file kind. */
export function kindExt(kind) {
  if (kind === 'dxf') return '.dxf';
  if (kind === 'dwg') return '.dwg';
  return NATIVE_EXT;
}

export function baseName(name) {
  return String(name).replace(/^.*[\\/]/, '').replace(/\.(cad|dxf|dwg)$/i, '');
}
