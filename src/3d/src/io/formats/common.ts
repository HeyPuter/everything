// Shared helpers for the interchange formats (DOM-free so they run in unit tests).
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { DocumentData, ID } from '../../data/types';

export type NamedKind = 'objects' | 'meshes' | 'materials' | 'collections' | 'curves' | 'lights' | 'cameras' | 'armatures' | 'actions' | 'images' | 'node_groups' | 'texts';

/** Name unique within a data-block table, using the `.001` suffix convention. */
export function uniqueName(doc: DocumentData, base: string, kind: NamedKind = 'objects', taken?: Set<string>): string {
  base = (base || 'Unnamed').slice(0, 63);
  const names = taken ?? new Set(Object.values(doc[kind] as Record<string, { name: string }>).map((o) => o.name));
  let out = base;
  if (names.has(out)) {
    const stem = base.replace(/\.\d{3}$/, '');
    for (let i = 1; ; i++) {
      out = `${stem}.${String(i).padStart(3, '0')}`;
      if (!names.has(out)) break;
    }
  }
  names.add(out);
  return out;
}

/** The collection new objects go into when no UI preference exists. */
export function defaultCollection(doc: DocumentData): ID {
  const act = doc.scene.active_object;
  const holder = act ? Object.values(doc.collections).find((c) => c.id !== doc.scene.collection && c.objects.includes(act)) : undefined;
  if (holder) return holder.id;
  return doc.collections[doc.scene.collection].children[0] ?? doc.scene.collection;
}

// ---------------------------------------------------------------------------
// Images

export function sniffMime(bytes: Uint8Array, fallbackName = ''): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  const ext = fallbackName.toLowerCase().split('.').pop() ?? '';
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        bmp: 'image/bmp',
        gif: 'image/gif',
        tga: 'image/x-tga',
        tif: 'image/tiff',
        tiff: 'image/tiff',
        exr: 'image/x-exr',
        hdr: 'image/vnd.radiance',
        ktx2: 'image/ktx2',
        dds: 'image/vnd-ms.dds',
        avif: 'image/avif',
      } as Record<string, string>
    )[ext] ?? 'application/octet-stream'
  );
}

/** Pixel size from PNG/JPEG/WebP/GIF/BMP headers (0×0 if unknown). */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const mime = sniffMime(bytes);
    if (mime === 'image/png') return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (mime === 'image/gif') return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (mime === 'image/bmp') return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
    if (mime === 'image/jpeg') {
      let p = 2;
      while (p + 9 < bytes.length) {
        if (bytes[p] !== 0xff) {
          p++;
          continue;
        }
        const marker = bytes[p + 1];
        const len = dv.getUint16(p + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: dv.getUint16(p + 7), height: dv.getUint16(p + 5) };
        p += 2 + len;
      }
    }
    if (mime === 'image/webp') {
      const kind = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
      if (kind === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (kind === 'VP8L') {
        const b = dv.getUint32(21, true);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === 'VP8X') return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}

export function extOfMime(mime: string) {
  return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/png' ? '.png' : mime === 'image/bmp' ? '.bmp' : mime === 'image/gif' ? '.gif' : '.bin';
}

export function baseName(path: string) {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export function stripExt(name: string) {
  return name.replace(/\.[^./\\]+$/, '');
}

// ---------------------------------------------------------------------------
// Axis conversion (forward/up axis enums of the IO options)

export type AxisId = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';
export const AXIS_ITEMS: [string, string][] = [
  ['X', 'X'],
  ['Y', 'Y'],
  ['Z', 'Z'],
  ['-X', '-X'],
  ['-Y', '-Y'],
  ['-Z', '-Z'],
];

function axisVec(a: AxisId): [number, number, number] {
  const s = a.startsWith('-') ? -1 : 1;
  const c = a.replace('-', '');
  return [c === 'X' ? s : 0, c === 'Y' ? s : 0, c === 'Z' ? s : 0];
}

/**
 * Row-major 3×3 rotation mapping a file's (forward, up) axes onto the document's
 * (+Y forward, +Z up). Returns null if the axes are parallel.
 */
export function axisConversion(forward: AxisId, up: AxisId): number[] | null {
  const f = axisVec(forward),
    u = axisVec(up);
  if (Math.abs(f[0] * u[0] + f[1] * u[1] + f[2] * u[2]) > 0.5) return null;
  const r = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]];
  // rows: right → X, forward → Y, up → Z
  return [...r, ...f, ...u];
}

export function transpose3(m: number[]) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** 4×4 from a row-major 3×3 and uniform scale. */
export function basisMatrix(axis: number[], scale = 1): Matrix4 {
  const m = new Matrix4();
  m.set(axis[0] * scale, axis[1] * scale, axis[2] * scale, 0, axis[3] * scale, axis[4] * scale, axis[5] * scale, 0, axis[6] * scale, axis[7] * scale, axis[8] * scale, 0, 0, 0, 0, 1);
  return m;
}

export function applyBasis(axis: number[], scale: number, src: ArrayLike<number>, normalize = false): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i + 2 < src.length; i += 3) {
    const x = src[i],
      y = src[i + 1],
      z = src[i + 2];
    let a = (axis[0] * x + axis[1] * y + axis[2] * z) * scale,
      b = (axis[3] * x + axis[4] * y + axis[5] * z) * scale,
      c = (axis[6] * x + axis[7] * y + axis[8] * z) * scale;
    if (normalize) {
      const l = Math.hypot(a, b, c) || 1;
      a /= l;
      b /= l;
      c /= l;
    }
    out[i] = a;
    out[i + 1] = b;
    out[i + 2] = c;
  }
  return out;
}

export function isIdentityAxis(axis: number[]) {
  return axis.every((v, i) => v === [1, 0, 0, 0, 1, 0, 0, 0, 1][i]);
}

// ---------------------------------------------------------------------------
// Matrices

export function decompose(m: Matrix4) {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

/** Rotation+translation of a matrix with scale removed. */
export function withoutScale(m: Matrix4): Matrix4 {
  const { p, q } = decompose(m);
  return new Matrix4().compose(p, q, new Vector3(1, 1, 1));
}

export function hasShear(m: Matrix4, eps = 1e-4) {
  const e = m.elements;
  const x = new Vector3(e[0], e[1], e[2]).normalize(),
    y = new Vector3(e[4], e[5], e[6]).normalize(),
    z = new Vector3(e[8], e[9], e[10]).normalize();
  return Math.abs(x.dot(y)) > eps || Math.abs(y.dot(z)) > eps || Math.abs(x.dot(z)) > eps;
}

export const round = (v: number, d = 6) => {
  const f = 10 ** d;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** sRGB (0..1) → linear */
export function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function linearToSrgb(c: number) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { mime, bytes };
}

/** Light units: glTF/USD-style photometric ↔ the document's radiometric watts. */
export const WATTS_TO_LUMENS = 683;
export const pointWattsToCandela = (w: number) => (w / (4 * Math.PI)) * WATTS_TO_LUMENS;
export const candelaToPointWatts = (cd: number) => (cd * 4 * Math.PI) / WATTS_TO_LUMENS;
