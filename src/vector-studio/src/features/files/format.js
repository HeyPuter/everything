/**
 * The native .vstudio format: the document JSON (VDocument.toJSON(): nodes,
 * images as data URLs in `assets`) plus a `meta` block with a PNG
 * thumbnail, gzip-compressed with CompressionStream.
 *
 * Loading accepts gzip or plain JSON (detected by the gzip magic bytes),
 * validates the structure with readable errors, and migrates older format
 * versions step by step up to FORMAT_VERSION.
 */
import { VDocument, FORMAT_VERSION } from '../../model/document.js';
import { DEFAULT_SWATCHES } from '../../model/swatches.js';
import { DEFAULT_CHAR } from '../../model/nodes.js';

export { FORMAT_VERSION };

export class FileFormatError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'FileFormatError';
    this.code = code;
  }
}

const encoder = new TextEncoder();

export function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function pipe(bytes, stream) {
  const writer = stream.writable.getWriter();
  // Write and read concurrently: the writer only drains while someone reads.
  const done = writer.write(bytes).then(() => writer.close());
  done.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks = [];
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  await done;
  return concat(chunks);
}

export function canCompress() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

export function gzip(bytes) {
  return pipe(bytes, new CompressionStream('gzip'));
}

export function gunzip(bytes) {
  return pipe(bytes, new DecompressionStream('gzip'));
}

/** Bytes from a Blob, ArrayBuffer, typed array or string. */
export async function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return encoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  if (input && typeof input.text === 'function') return encoder.encode(await input.text());
  throw new FileFormatError('Nothing to open: the file is empty or unreadable.', 'empty');
}

/** Asset ids no node mentions (deleted images) are dropped so files do not keep growing. */
function usedAssets(json) {
  const ids = Object.keys(json.assets || {});
  if (!ids.length) return json.assets || {};
  const text = JSON.stringify(json.nodes);
  const out = {};
  for (const id of ids) if (text.includes(JSON.stringify(id))) out[id] = json.assets[id];
  return out;
}

/** The JSON object written to disk. */
export function documentData(doc, { thumbnail = null, savedAt = Date.now(), app = 'Vector Studio' } = {}) {
  const json = doc.toJSON();
  json.assets = usedAssets(json);
  json.meta = { app, saved: new Date(savedAt).toISOString(), thumbnail: thumbnail || null };
  return json;
}

/** Serialize a document to file bytes (gzip by default). */
export async function serializeDocument(doc, { thumbnail = null, compress = true, savedAt } = {}) {
  const bytes = encoder.encode(JSON.stringify(documentData(doc, { thumbnail, savedAt })));
  if (!compress || !canCompress()) return bytes;
  return gzip(bytes);
}

// ---- migrations ----

/**
 * MIGRATIONS[v] upgrades data at version v to v + 1. Version 0 is the
 * unversioned shape (a bare { nodes, assets } without format/version).
 */
export const MIGRATIONS = {
  0: (data) => ({ ...data, format: 'vector-studio', version: 1 }),
};

export function migrate(data) {
  let v = Number(data.version ?? 0);
  let out = data;
  let steps = 0;
  while (v < FORMAT_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new FileFormatError(`This document uses an old format (version ${v}) that cannot be upgraded.`, 'version');
    out = step(out);
    v = Number(out.version);
    steps++;
  }
  return { data: out, migrated: steps > 0 };
}

export function normalizeBleed(b) {
  if (Number.isFinite(b)) return { top: b, bottom: b, left: b, right: b };
  const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { top: n(b?.top), bottom: n(b?.bottom), left: n(b?.left), right: n(b?.right) };
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const CONTAINERS = new Set(['root', 'layer', 'group', 'compound']);
const isMatrix = (m) => Array.isArray(m) && m.length === 6 && m.every(finite);

/**
 * The fields drawing and hit testing rely on, patched with safe defaults
 * where they are missing or malformed (points that are not points are
 * dropped, missing curve handles sit on their point).
 */
function repairNode(node) {
  let patch = null;
  const set = (k, v) => ((patch ||= {})[k] = v);
  if (CONTAINERS.has(node.type) && !Array.isArray(node.children)) set('children', []);
  if (node.type === 'path') {
    let changed = !Array.isArray(node.anchors);
    const anchors = [];
    for (const a of Array.isArray(node.anchors) ? node.anchors : []) {
      if (!a || typeof a !== 'object' || !finite(a.x) || !finite(a.y)) {
        changed = true;
        continue;
      }
      if (finite(a.ix) && finite(a.iy) && finite(a.ox) && finite(a.oy)) anchors.push(a);
      else {
        changed = true;
        anchors.push({ ...a, ix: finite(a.ix) ? a.ix : a.x, iy: finite(a.iy) ? a.iy : a.y, ox: finite(a.ox) ? a.ox : a.x, oy: finite(a.oy) ? a.oy : a.y });
      }
    }
    if (changed) set('anchors', anchors);
  }
  if (node.type === 'text') {
    if (typeof node.text !== 'string') set('text', node.text == null ? '' : String(node.text));
    if (!node.char || typeof node.char !== 'object' || Array.isArray(node.char)) set('char', { ...DEFAULT_CHAR });
    if (!isMatrix(node.transform)) set('transform', [1, 0, 0, 1, 0, 0]);
  }
  return patch ? { ...node, ...patch } : node;
}

/**
 * Check the structure and repair what can be repaired safely: missing
 * root fields get defaults, dangling child ids are dropped. Throws
 * FileFormatError for anything that cannot be opened.
 */
export function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new FileFormatError('This file is not a Vector Studio document.');
  if (data.format && data.format !== 'vector-studio') throw new FileFormatError(`This file is a "${String(data.format).slice(0, 40)}" file, not a Vector Studio document.`, 'format');
  if (data.version != null && (!Number.isInteger(data.version) || data.version < 0)) throw new FileFormatError('The document version is not valid.', 'version');
  if (data.version > FORMAT_VERSION) {
    throw new FileFormatError(`This document was saved by a newer version of Vector Studio (format ${data.version}). Reload the app to get the latest version, then open it again.`, 'newer');
  }
  const nodes = data.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) throw new FileFormatError('The document has no artwork data. The file may be damaged.', 'damaged');
  const root = nodes.root;
  if (!root || typeof root !== 'object') throw new FileFormatError('The document is missing its root. The file may be damaged.', 'damaged');
  let repaired = 0;
  const fixed = {};
  for (const [id, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
      repaired++;
      continue;
    }
    const ok = repairNode(node);
    fixed[id] = ok.id === id ? ok : { ...ok, id };
  }
  for (const [id, node] of Object.entries(fixed)) {
    if (!Array.isArray(node.children)) continue;
    const kids = node.children.filter((c) => typeof c === 'string' && fixed[c] && c !== id);
    if (kids.length !== node.children.length) {
      repaired += node.children.length - kids.length;
      fixed[id] = { ...node, children: kids };
    }
  }
  const r = fixed.root;
  const rootPatch = {};
  if (r.type !== 'root') rootPatch.type = 'root';
  if (!Array.isArray(r.children)) rootPatch.children = [];
  const boards = Array.isArray(r.artboards) ? r.artboards.filter((a) => a && finite(a.x) && finite(a.y) && finite(a.w) && finite(a.h) && a.w > 0 && a.h > 0) : [];
  if (!boards.length) boards.push({ id: 'a-recovered', name: 'Artboard 1', x: 0, y: 0, w: 612, h: 792 });
  if (!Array.isArray(r.artboards) || boards.length !== r.artboards.length) rootPatch.artboards = boards;
  if (!Array.isArray(r.guides)) rootPatch.guides = [];
  if (!Array.isArray(r.swatches)) rootPatch.swatches = DEFAULT_SWATCHES.map((s) => ({ ...s }));
  if (typeof r.units !== 'string') rootPatch.units = 'pt';
  if (!r.grid || !finite(r.grid.spacing) || !finite(r.grid.subdivisions) || r.grid.spacing <= 0 || r.grid.subdivisions < 1) rootPatch.grid = { spacing: 72, subdivisions: 8 };
  if (typeof r.name !== 'string') rootPatch.name = 'Untitled';
  if (Object.keys(rootPatch).length) fixed.root = { ...r, ...rootPatch };
  // A document needs at least one layer to draw into.
  if (!fixed.root.children.some((c) => fixed[c]?.type === 'layer')) {
    const id = 'l-recovered';
    fixed[id] = { id, type: 'layer', name: 'Layer 1', color: '#4f80ff', children: [], hidden: false, locked: false, parent: 'root' };
    fixed.root = { ...fixed.root, children: [...fixed.root.children, id] };
  }
  const assets = {};
  for (const [id, a] of Object.entries(data.assets && typeof data.assets === 'object' ? data.assets : {})) {
    if (a && typeof a.data === 'string') assets[id] = a;
  }
  return { data: { ...data, nodes: fixed, assets }, repaired };
}

/** Decode file bytes (gzip or plain) to the parsed JSON object. */
export async function decodeBytes(bytes) {
  let raw = bytes;
  if (!raw.length) throw new FileFormatError('The file is empty.', 'empty');
  if (isGzip(raw)) {
    if (!canCompress()) throw new FileFormatError('This browser cannot decompress Vector Studio files.', 'unsupported');
    try {
      raw = await gunzip(raw);
    } catch {
      throw new FileFormatError('The file is damaged: it could not be decompressed.', 'damaged');
    }
  }
  const text = new TextDecoder().decode(raw).replace(/^﻿/, '');
  const head = text.trimStart().slice(0, 64);
  if (head.startsWith('<')) throw new FileFormatError('This is an SVG or XML file, not a Vector Studio document.', 'svg');
  if (head.startsWith('%PDF')) throw new FileFormatError('This is a PDF file, not a Vector Studio document.', 'format');
  try {
    return JSON.parse(text);
  } catch {
    throw new FileFormatError(isGzip(bytes) ? 'The file is damaged: its contents are not valid.' : 'This file is not a Vector Studio document.', 'damaged');
  }
}

/**
 * Parse file contents into a document.
 * Returns { doc, meta, version, migrated, repaired, compressed }.
 */
export async function parseDocument(input) {
  const bytes = await toBytes(input);
  const json = await decodeBytes(bytes);
  const checked = validateData(json);
  const { data, migrated } = migrate(checked.data);
  let doc;
  try {
    doc = VDocument.fromJSON(data);
  } catch (err) {
    throw new FileFormatError(`The document could not be read: ${err?.message || err}`, 'damaged');
  }
  return {
    doc,
    meta: json.meta && typeof json.meta === 'object' ? json.meta : {},
    version: Number(json.version ?? 0),
    migrated,
    repaired: checked.repaired,
    compressed: isGzip(bytes),
  };
}

/** Only the embedded thumbnail (for file lists), without building a document. */
export async function readThumbnail(input) {
  try {
    const json = await decodeBytes(await toBytes(input));
    const t = json?.meta?.thumbnail;
    return typeof t === 'string' && t.startsWith('data:image/') ? t : null;
  } catch {
    return null;
  }
}
