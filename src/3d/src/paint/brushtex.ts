// Brush textures: an image or a built-in procedural pattern modulating the brush strength (and,
// in Texture Paint, the paint color). Mapping: around the brush in screen space (view plane), on
// the surface plane under the brush (area plane), fixed on the screen (tiled), in object space
// (3D), randomly per dab, or through a stencil placed over the viewport. A second "mask" texture
// only scales the strength.
import { Matrix4, Vector3 } from 'three';
import { app } from '../app/app';
import type { View3D } from '../editors/view3d/view3d';
import type { PaintBrush } from './brushes';
import type { MeshSession } from './session';

export type TexMapMode = 'VIEW_PLANE' | 'AREA_PLANE' | 'TILED' | '3D' | 'RANDOM' | 'STENCIL';

export interface BrushTexture {
  source: 'NONE' | 'IMAGE' | 'NOISE' | 'CELLS' | 'STRIPES' | 'RINGS';
  image?: string | null;
  map_mode: TexMapMode;
  /** radians */
  angle: number;
  scale: number;
  /** blend between no texture (0) and the full texture (1) */
  strength?: number;
  /** texture offset (in units of the brush radius / stencil size) */
  offset?: [number, number, number];
  /** random rotation per dab, up to `random_angle` */
  use_random?: boolean;
  random_angle?: number;
}

/** Brush settings for stencils (stored on the brush; positions in region pixels, y up). */
export interface StencilSettings {
  stencil_pos?: [number, number];
  stencil_dimension?: [number, number];
  mask_stencil_pos?: [number, number];
  mask_stencil_dimension?: [number, number];
}

export const TEX_SOURCES: [BrushTexture['source'], string][] = [
  ['NONE', 'None'],
  ['IMAGE', 'Image'],
  ['NOISE', 'Noise'],
  ['CELLS', 'Cells'],
  ['STRIPES', 'Stripes'],
  ['RINGS', 'Rings'],
];

/** Mapping modes of the brush texture per paint mode (and of the mask texture). */
export function mapModes(mode: string, mask = false): [TexMapMode, string, string][] {
  const all: [TexMapMode, string, string][] = [
    ['VIEW_PLANE', 'View Plane', 'The texture follows the brush, aligned with the screen'],
    ['AREA_PLANE', 'Area Plane', 'The texture lies on the surface under the brush'],
    ['TILED', 'Tiled', 'The texture is fixed on the screen and repeats'],
    ['3D', '3D', 'The texture is placed in object space (procedural textures)'],
    ['RANDOM', 'Random', 'A new rotation and offset for every dab'],
    ['STENCIL', 'Stencil', 'Paint through a stencil laid over the viewport (right-drag moves it)'],
  ];
  if (mask) return all.filter((m) => m[0] === 'VIEW_PLANE' || m[0] === 'TILED' || m[0] === 'RANDOM' || m[0] === 'STENCIL');
  if (mode === 'SCULPT') return all;
  return all.filter((m) => m[0] !== 'AREA_PLANE');
}

export const DEFAULT_STENCIL_POS: [number, number] = [256, 256];
export const DEFAULT_STENCIL_DIM: [number, number] = [256, 256];

const fract = (x: number) => x - Math.floor(x);
function hash2(x: number, y: number) {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
}
function valueNoise(x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const fx = x - ix,
    fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx),
    uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy),
    b = hash2(ix + 1, iy),
    c = hash2(ix, iy + 1),
    d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Procedural intensity (0..1) at texture coordinates (u, v), one unit = brush radius. */
export function proceduralTex(source: string, u: number, v: number): number {
  switch (source) {
    case 'NOISE': {
      let s = 0,
        amp = 0.5,
        f = 2;
      for (let o = 0; o < 4; o++) {
        s += valueNoise(u * f, v * f) * amp;
        amp *= 0.5;
        f *= 2;
      }
      return Math.min(1, s * 1.1);
    }
    case 'CELLS': {
      // distance to the nearest jittered cell point
      const x = u * 3,
        y = v * 3;
      const ix = Math.floor(x),
        iy = Math.floor(y);
      let best = 9;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const px = ix + i + hash2(ix + i, iy + j),
            py = iy + j + hash2(iy + j + 17, ix + i + 31);
          best = Math.min(best, Math.hypot(x - px, y - py));
        }
      return Math.min(1, best * 1.4);
    }
    case 'STRIPES':
      return 0.5 + 0.5 * Math.sin(u * Math.PI * 4);
    case 'RINGS':
      return 0.5 + 0.5 * Math.cos(Math.hypot(u, v) * Math.PI * 4);
    default:
      return 1;
  }
}

/** Procedural intensity in object space: the 2D pattern on the three axis planes, averaged. */
export function proceduralTex3(source: string, x: number, y: number, z: number): number {
  if (source === 'RINGS') return 0.5 + 0.5 * Math.cos(Math.hypot(x, y, z) * Math.PI * 4);
  if (source === 'STRIPES') return 0.5 + 0.5 * Math.sin(x * Math.PI * 4);
  return (proceduralTex(source, x, y) + proceduralTex(source, y + 3.1, z + 1.7) + proceduralTex(source, z + 5.3, x + 2.9)) / 3;
}

interface ImgCache {
  key: string;
  w: number;
  h: number;
  /** luminance × alpha */
  data: Float32Array;
  /** display RGBA 0..1 */
  rgba: Float32Array;
}
const imgCache = new Map<string, ImgCache>();

/** Samples of an image, or null while it is not available. */
function imageSamples(id: string): ImgCache | null {
  const img = app.doc.images[id];
  if (!img || typeof document === 'undefined') return null;
  const key = `${img.revision ?? 0}|${img.width}x${img.height}|${img.bytes?.length ?? 0}`;
  const hit = imgCache.get(id);
  if (hit && hit.key === key) return hit;
  // set lazily by the UI: the canvas helpers need the DOM
  const canvas = imageCanvasOf?.(img);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const n = canvas.width * canvas.height;
  const data = new Float32Array(n);
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i] = ((d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255) * (d[i * 4 + 3] / 255);
    for (let c = 0; c < 4; c++) rgba[i * 4 + c] = d[i * 4 + c] / 255;
  }
  const e = { key, w: canvas.width, h: canvas.height, data, rgba };
  imgCache.set(id, e);
  return e;
}

/** Set by the UI module (keeps this file free of renderer imports for tests). */
/** The image's canvas once its pixels are loaded (null while decoding). */
export let imageCanvasOf: ((img: import('../data/types').ImageData) => HTMLCanvasElement | null) | null = null;
export function setImageCanvasSource(fn: typeof imageCanvasOf) {
  imageCanvasOf = fn;
}

/** Image pixel for texture coordinates in [-1, 1] (repeating). */
function imageIndex(im: ImgCache, u: number, v: number) {
  const x = Math.floor(fract(u * 0.5 + 0.5) * im.w),
    y = Math.floor(fract(0.5 - v * 0.5) * im.h);
  return Math.min(im.h - 1, y) * im.w + Math.min(im.w - 1, x);
}

/** Texture intensity at texture coordinates (u, v) in [-1, 1] around the brush. */
export function sampleTex(t: BrushTexture, u: number, v: number): number {
  if (t.source === 'IMAGE') {
    const im = t.image ? imageSamples(t.image) : null;
    if (!im) return 1;
    return im.data[imageIndex(im, u, v)];
  }
  return proceduralTex(t.source, u, v);
}

/** Texture color (display RGB) and alpha at (u, v); procedural textures are grey. */
export function sampleTexRGBA(t: BrushTexture, u: number, v: number, out: number[]): number[] {
  if (t.source === 'IMAGE') {
    const im = t.image ? imageSamples(t.image) : null;
    if (!im) {
      out[0] = out[1] = out[2] = out[3] = 1;
      return out;
    }
    const i = imageIndex(im, u, v) * 4;
    out[0] = im.rgba[i];
    out[1] = im.rgba[i + 1];
    out[2] = im.rgba[i + 2];
    out[3] = im.rgba[i + 3];
    return out;
  }
  const f = proceduralTex(t.source, u, v);
  out[0] = out[1] = out[2] = f;
  out[3] = 1;
  return out;
}

const slotActive = (t: BrushTexture | undefined | null): t is BrushTexture => !!t && t.source !== 'NONE' && (t.source !== 'IMAGE' || !!t.image);

export function textureActive(b: PaintBrush): boolean {
  return slotActive(b.texture_slot);
}

export function maskTextureActive(b: PaintBrush): boolean {
  return slotActive(b.mask_texture_slot);
}

/** The stencil rectangle of a brush texture (center and half size in viewport pixels, y down). */
export function stencilRect(b: PaintBrush, mask: boolean, viewH: number) {
  const pos = (mask ? b.mask_stencil_pos : b.stencil_pos) ?? DEFAULT_STENCIL_POS;
  const dim = (mask ? b.mask_stencil_dimension : b.stencil_dimension) ?? DEFAULT_STENCIL_DIM;
  const t = mask ? b.mask_texture_slot : b.texture_slot;
  return { cx: pos[0], cy: viewH - pos[1], hw: Math.max(1, dim[0]), hh: Math.max(1, dim[1]), angle: t?.angle ?? 0 };
}

/** Per-dab placement of a texture. */
export interface DabPlace {
  /** dab center, viewport pixels */
  cx: number;
  cy: number;
  radiusPx: number;
  index: number;
  viewH: number;
  /** area plane (object space): dab center, surface normal and radius */
  area?: { center: Vector3; normal: Vector3; radius: number } | null;
}

/**
 * Texture coordinates for a texture slot and a dab: (screen x, screen y, local x, y, z) →
 * [u, v], or null where the texture does not reach (outside a stencil).
 */
export function texMapper(t: BrushTexture, b: PaintBrush, mask: boolean, d: DabPlace): (sx: number, sy: number, lx: number, ly: number, lz: number, out: number[]) => number[] | null {
  let ang = t.angle;
  const off = t.offset ?? [0, 0, 0];
  let ox = off[0],
    oy = off[1];
  if (t.map_mode === 'RANDOM') {
    ang += hash2(d.index, 7.3) * Math.PI * 2;
    ox += hash2(d.index, 1.1) * 2;
    oy += hash2(d.index, 2.9) * 2;
  } else if (t.use_random) ang += hash2(d.index, 4.7) * (t.random_angle ?? Math.PI * 2);
  const scale = Math.max(1e-3, t.scale);
  const cos = Math.cos(-ang),
    sin = Math.sin(-ang);
  const R = Math.max(1e-6, d.radiusPx);
  switch (t.map_mode) {
    case 'STENCIL': {
      const r = stencilRect(b, mask, d.viewH);
      const c = Math.cos(-r.angle),
        s = Math.sin(-r.angle);
      return (sx, sy, _x, _y, _z, out) => {
        // rotate the pixel offset into the stencil's frame, then normalize by its half size
        const dx = sx - r.cx,
          dy = -(sy - r.cy);
        const u = (dx * c - dy * s) / r.hw,
          v = (dx * s + dy * c) / r.hh;
        if (u < -1 || u > 1 || v < -1 || v > 1) return null;
        out[0] = u / scale + ox;
        out[1] = v / scale + oy;
        return out;
      };
    }
    case 'TILED':
      return (sx, sy, _x, _y, _z, out) => {
        out[0] = sx / (R * scale) + ox;
        out[1] = -sy / (R * scale) + oy;
        return out;
      };
    case '3D':
      return (_sx, _sy, x, y, z, out) => {
        out[0] = x / scale + off[0];
        out[1] = y / scale + off[1];
        out[2] = z / scale + off[2];
        return out;
      };
    case 'AREA_PLANE': {
      const a = d.area;
      if (a) {
        const n = a.normal.clone().normalize();
        const tu = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1).cross(n).normalize() : new Vector3(1, 0, 0).cross(n).normalize();
        const tv = n.clone().cross(tu);
        const k = 1 / Math.max(1e-9, a.radius);
        return (_sx, _sy, x, y, z, out) => {
          const px = x - a.center.x,
            py = y - a.center.y,
            pz = z - a.center.z;
          const du = (px * tu.x + py * tu.y + pz * tu.z) * k,
            dv = (px * tv.x + py * tv.y + pz * tv.z) * k;
          out[0] = (du * cos - dv * sin) / scale + ox;
          out[1] = (du * sin + dv * cos) / scale + oy;
          return out;
        };
      }
      break;
    }
  }
  // view plane (and random): around the dab, aligned with the screen
  return (sx, sy, _x, _y, _z, out) => {
    const dx = (sx - d.cx) / R,
      dy = -(sy - d.cy) / R;
    out[0] = (dx * cos - dy * sin) / scale + ox;
    out[1] = (dx * sin + dy * cos) / scale + oy;
    return out;
  };
}

/** Intensity of a slot through a mapper (0 outside a stencil). */
function slotIntensity(t: BrushTexture, map: ReturnType<typeof texMapper>, sx: number, sy: number, x: number, y: number, z: number, tmp: number[]): number {
  const uv = map(sx, sy, x, y, z, tmp);
  if (!uv) return 0;
  if (t.map_mode === '3D') return t.source === 'IMAGE' ? sampleTex(t, uv[0], uv[1]) : proceduralTex3(t.source, uv[0], uv[1], uv[2]);
  return sampleTex(t, uv[0], uv[1]);
}

/**
 * Strength factor of the brush texture and the mask texture at a screen / object-space point,
 * for one dab. Returns null when the brush has neither.
 */
export function dabTextureAt(b: PaintBrush, d: DabPlace): ((sx: number, sy: number, x: number, y: number, z: number) => number) | null {
  const tex = textureActive(b) ? b.texture_slot! : null;
  const msk = maskTextureActive(b) ? b.mask_texture_slot! : null;
  if (!tex && !msk) return null;
  const tm = tex ? texMapper(tex, b, false, d) : null;
  const mm = msk ? texMapper(msk, b, true, d) : null;
  const k = tex?.strength ?? 1,
    km = msk?.strength ?? 1;
  const tmp = [0, 0, 0];
  return (sx, sy, x, y, z) => {
    let f = 1;
    if (tex && tm) f *= 1 - k + k * slotIntensity(tex, tm, sx, sy, x, y, z, tmp);
    if (msk && mm) f *= 1 - km + km * slotIntensity(msk, mm, sx, sy, x, y, z, tmp);
    return f;
  };
}

/** Texture color sampler for Texture Paint (display RGBA of the brush texture), or null. */
export function dabTextureColor(b: PaintBrush, d: DabPlace): ((sx: number, sy: number, x: number, y: number, z: number, out: number[]) => number[] | null) | null {
  const tex = textureActive(b) ? b.texture_slot! : null;
  if (!tex) return null;
  const map = texMapper(tex, b, false, d);
  const tmp = [0, 0, 0];
  return (sx, sy, x, y, z, out) => {
    const uv = map(sx, sy, x, y, z, tmp);
    if (!uv) return null;
    if (tex.map_mode === '3D' && tex.source !== 'IMAGE') {
      const f = proceduralTex3(tex.source, uv[0], uv[1], uv[2]);
      out[0] = out[1] = out[2] = f;
      out[3] = 1;
      return out;
    }
    return sampleTexRGBA(tex, uv[0], uv[1], out);
  };
}

/** Mask texture factor for Texture Paint, or null. */
export function dabMaskAt(b: PaintBrush, d: DabPlace): ((sx: number, sy: number, x: number, y: number, z: number) => number) | null {
  const msk = maskTextureActive(b) ? b.mask_texture_slot! : null;
  if (!msk) return null;
  const mm = texMapper(msk, b, true, d);
  const km = msk.strength ?? 1;
  const tmp = [0, 0, 0];
  return (sx, sy, x, y, z) => 1 - km + km * slotIntensity(msk, mm, sx, sy, x, y, z, tmp);
}

/**
 * Per-dab sampler: texture factor for a vertex (object space) given the dab center in viewport
 * pixels and the dab radius in pixels. Returns null when the brush has no texture.
 */
export function dabTexture(b: PaintBrush, s: MeshSession, v: View3D, cx: number, cy: number, radiusPx: number, dabIndex: number, area?: DabPlace['area']): ((vi: number) => number) | null {
  const at = dabTextureAt(b, { cx, cy, radiusPx, index: dabIndex, viewH: v.height, area });
  if (!at) return null;
  const cam = v.camera;
  cam.updateMatrixWorld();
  const e = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(s.world()).elements;
  const W = v.width,
    H = v.height;
  const P = s.positions;
  return (vi: number) => {
    const x = P[vi * 3],
      y = P[vi * 3 + 1],
      z = P[vi * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-9) return 1;
    const sx = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw) * 0.5 + 0.5) * W;
    const sy = (-((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5 + 0.5) * H;
    return at(sx, sy, x, y, z);
  };
}
