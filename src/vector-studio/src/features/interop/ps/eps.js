/**
 * EPS and PostScript import.
 *
 * The PostScript is interpreted into vector artwork (see interpreter.js).
 * When that fails (a construct the interpreter does not support), the
 * preview the file carries is used instead: the TIFF or metafile preview
 * of a binary (DOS) EPS header, or an EPSI hex preview, and the importer
 * says so. Legacy .ai files that are PostScript rather than PDF come here
 * too.
 */
import { PSInterpreter } from './interpreter.js';
import { Builder } from '../pdf/build.js';
import { decodeTIFF } from '../codec/tiff.js';
import { decodeDIB } from '../codec/bmp.js';
import { uid } from '../../../lib/ids.js';
import { createImage } from '../../../model/nodes.js';
import { nodeBounds, unionRect } from '../../../model/geometry.js';
import { dscIccProfile, iccImportSpace } from '../../icc/import.js';

const latin = (b, s = 0, e = b.length) => {
  let out = '';
  for (let i = s; i < e; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 0x8000)));
  return out;
};

export function isDosEPS(b) {
  return b.length > 30 && b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6;
}

export function isPostScript(b) {
  if (isDosEPS(b)) return true;
  let i = 0;
  while (i < b.length && i < 64 && (b[i] === 4 || b[i] === 10 || b[i] === 13 || b[i] === 32)) i++;
  return b[i] === 0x25 && b[i + 1] === 0x21;
}

/** Split a file into { ps (bytes), tiff?, wmf? }. */
export function epsParts(bytes) {
  if (!isDosEPS(bytes)) return { ps: bytes };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sec = (o) => {
    const off = dv.getUint32(o, true);
    const len = dv.getUint32(o + 4, true);
    return off && len && off + len <= bytes.length ? bytes.subarray(off, off + len) : null;
  };
  return { ps: sec(4) || new Uint8Array(0), wmf: sec(12), tiff: sec(20) };
}

/** DSC header values: bounding box (prefers HiRes), title, creator. */
export function dscInfo(ps) {
  const head = latin(ps, 0, Math.min(ps.length, 65536));
  const tail = latin(ps, Math.max(0, ps.length - 16384), ps.length);
  const box = (re) => {
    for (const s of [head, tail]) {
      const m = re.exec(s);
      if (m && !/atend/.test(m[0])) {
        const v = m[1].trim().split(/\s+/).map(Number);
        if (v.length === 4 && v.every(Number.isFinite) && v[2] > v[0] && v[3] > v[1]) return { x: v[0], y: v[1], w: v[2] - v[0], h: v[3] - v[1] };
      }
    }
    return null;
  };
  const bbox = box(/%%HiResBoundingBox:\s*([^\r\n]*)/) || box(/%%BoundingBox:\s*([^\r\n]*)/);
  const title = /%%Title:\s*([^\r\n]*)/.exec(head)?.[1]?.replace(/^\(|\)$/g, '').trim() || '';
  const creator = /%%Creator:\s*([^\r\n]*)/.exec(head)?.[1]?.trim() || '';
  return { bbox, title, creator };
}

/** EPSI preview (hex bitmap in comments) as RGBA, or null. */
export function epsiPreview(ps) {
  const text = latin(ps, 0, Math.min(ps.length, 4 << 20));
  const m = /%%BeginPreview:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(text);
  if (!m) return null;
  const [w, h, depth] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const end = text.indexOf('%%EndPreview', m.index);
  if (end < 0 || !w || !h || ![1, 2, 4, 8].includes(depth)) return null;
  const hex = text.slice(m.index + m[0].length, end).replace(/%/g, '').replace(/[^0-9a-fA-F]/g, '');
  const rowBytes = Math.ceil((w * depth) / 8);
  const data = new Uint8ClampedArray(w * h * 4);
  const max = 2 ** depth - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bit = y * rowBytes * 8 + x * depth;
      const byte = parseInt(hex.substr((bit >> 3) * 2, 2) || '0', 16);
      const v = (byte >> (8 - depth - (bit & 7))) & max;
      // EPSI: 0 is white.
      const g = Math.round(255 * (1 - v / max));
      const o = (y * w + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = g;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** The first device-independent bitmap in a Windows metafile preview, or null. */
export function wmfPreview(wmf) {
  if (!wmf) return null;
  const dv = new DataView(wmf.buffer, wmf.byteOffset, wmf.byteLength);
  let p = dv.getUint32(0, true) === 0x9ac6cdd7 ? 22 : 0;
  const headerWords = dv.getUint16(p + 2, true);
  p += headerWords * 2;
  for (let guard = 0; guard < 100000 && p + 6 <= wmf.length; guard++) {
    const size = dv.getUint32(p, true) * 2;
    const fn = dv.getUint16(p + 4, true);
    if (size < 6) break;
    const params = p + 6;
    let dib = -1;
    if (fn === 0x0f43) dib = params + 22; // StretchDIBits
    else if (fn === 0x0b41) dib = params + 20; // DIBStretchBlt (with source)
    else if (fn === 0x0940) dib = params + 16; // DIBBitBlt (with source)
    if (dib > 0 && dib < p + size) {
      try {
        return decodeDIB(wmf, dib);
      } catch {
        /* try the next record */
      }
    }
    if (fn === 0) break;
    p += size;
  }
  return null;
}

/**
 * Interpret EPS/PS bytes.
 * Returns { kind: 'vector', builder result..., bbox, warnings } or
 *         { kind: 'preview', image, bbox, warnings } or throws.
 */
export function interpretEPS(bytes, { families } = {}) {
  const parts = epsParts(bytes);
  const ps = parts.ps;
  const info = dscInfo(ps);
  const bbox = info.bbox || { x: 0, y: 0, w: 612, h: 792 };
  const base = [1, 0, 0, -1, -bbox.x, bbox.y + bbox.h];
  let interp = null;
  let error = null;
  // A profile declared in the DSC comments describes the file's device colors of its kind.
  const head = latin(ps, 0, Math.min(ps.length, 4 << 20));
  const icc = dscIccProfile(head);
  const profileSpace = icc ? [1, 3, 4].map((n) => iccImportSpace(icc, n)).find(Boolean) || null : null;
  try {
    interp = new PSInterpreter(ps, { families, base, bbox, profileSpace }).run();
    error = interp.error || null;
  } catch (err) {
    error = err;
  }
  const result = interp ? interp.out.finish() : { layers: [], nodes: new Map() };
  const count = result.layers.reduce((n, l) => n + l.ids.length, 0);
  const warnings = interp ? [...interp.warnings] : [];
  if (interp?.substituted?.size) warnings.push(`Fonts that are not available were substituted: ${[...interp.substituted].slice(0, 6).join(', ')}.`);
  if (count && !error) return { kind: 'vector', ...result, images: interp.images, spots: [...interp.spots.values()], bbox, info, warnings };
  // Fall back to the preview.
  let image = null;
  try {
    if (parts.tiff) image = decodeTIFF(parts.tiff);
  } catch {
    image = null;
  }
  if (!image) image = wmfPreview(parts.wmf) || epsiPreview(ps);
  const why = error?.psName ? ` (${error.message})` : '';
  if (image) {
    warnings.unshift(`Only the preview image of this file could be imported: its PostScript could not be converted to editable artwork${why}.`);
    return { kind: 'preview', image, bbox, info, warnings };
  }
  if (count) {
    warnings.unshift(`Part of this file could not be converted${why}; the artwork may be incomplete.`);
    return { kind: 'vector', ...result, images: interp.images, spots: [...interp.spots.values()], bbox, info, warnings };
  }
  throw new Error(`The PostScript in this file could not be converted${why}, and the file has no preview image.`);
}

/** Preview image as a layer record with one image node sized to the bounding box. */
export function previewNodes(image, bbox) {
  const id = uid('img');
  const node = createImage(id, image.width, image.height, [bbox.w / image.width, 0, 0, bbox.h / image.height, 0, 0], { name: 'Preview' });
  const nodes = new Map([[node.id, node]]);
  return { layers: [{ key: 'default', name: 'Layer 1', ids: [node.id] }], nodes, images: [{ id, img: { kind: 'rgba', ...image } }], spots: [] };
}

export function boundsOf(nodes, ids) {
  const shim = { get: (id) => nodes.get(id) };
  let b = null;
  for (const id of ids) b = unionRect(b, nodeBounds(shim, nodes.get(id)));
  return b;
}

export { Builder };
