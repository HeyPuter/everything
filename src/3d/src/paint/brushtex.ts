// Brush textures: an image or a built-in procedural pattern modulating the brush strength, mapped
// in screen space around the brush (view plane), tiled over the view, or randomly per dab.
import { Matrix4 } from 'three';
import { app } from '../app/app';
import type { View3D } from '../editors/view3d/view3d';
import type { PaintBrush } from './brushes';
import type { MeshSession } from './session';

export interface BrushTexture {
  source: 'NONE' | 'IMAGE' | 'NOISE' | 'CELLS' | 'STRIPES' | 'RINGS';
  image?: string | null;
  map_mode: 'VIEW_PLANE' | 'TILED' | 'RANDOM';
  /** radians */
  angle: number;
  scale: number;
  /** blend between no texture (0) and the full texture (1) */
  strength?: number;
}

export const TEX_SOURCES: [BrushTexture['source'], string][] = [
  ['NONE', 'None'],
  ['IMAGE', 'Image'],
  ['NOISE', 'Noise'],
  ['CELLS', 'Cells'],
  ['STRIPES', 'Stripes'],
  ['RINGS', 'Rings'],
];

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

const imgCache = new Map<string, { key: string; w: number; h: number; data: Float32Array }>();

/** Intensity samples of an image (luminance × alpha), or null while it is not available. */
function imageIntensity(id: string) {
  const img = app.doc.images[id];
  if (!img || typeof document === 'undefined') return null;
  const key = `${img.revision ?? 0}|${img.width}x${img.height}|${img.bytes?.length ?? 0}`;
  const hit = imgCache.get(id);
  if (hit && hit.key === key) return hit;
  // imported lazily: the canvas helpers need the DOM
  const canvas = imageCanvasOf?.(img);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = ((d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255) * (d[i * 4 + 3] / 255);
  const e = { key, w: canvas.width, h: canvas.height, data };
  imgCache.set(id, e);
  return e;
}

/** Set by the UI module (keeps this file free of renderer imports for tests). */
export let imageCanvasOf: ((img: import('../data/types').ImageData) => HTMLCanvasElement) | null = null;
export function setImageCanvasSource(fn: typeof imageCanvasOf) {
  imageCanvasOf = fn;
}

/** Texture intensity at texture coordinates (u, v) in [-1, 1] around the brush. */
export function sampleTex(t: BrushTexture, u: number, v: number): number {
  if (t.source === 'IMAGE') {
    const im = t.image ? imageIntensity(t.image) : null;
    if (!im) return 1;
    const x = Math.floor(fract(u * 0.5 + 0.5) * im.w),
      y = Math.floor(fract(0.5 - v * 0.5) * im.h);
    return im.data[Math.min(im.h - 1, y) * im.w + Math.min(im.w - 1, x)];
  }
  return proceduralTex(t.source, u, v);
}

export function textureActive(b: PaintBrush): boolean {
  const t = b.texture_slot;
  return !!t && t.source !== 'NONE' && (t.source !== 'IMAGE' || !!t.image);
}

/**
 * Per-dab sampler: texture factor for a vertex (object space) given the dab center in viewport
 * pixels and the dab radius in pixels. Returns null when the brush has no texture.
 */
export function dabTexture(b: PaintBrush, s: MeshSession, v: View3D, cx: number, cy: number, radiusPx: number, dabIndex: number): ((vi: number) => number) | null {
  if (!textureActive(b)) return null;
  const t = b.texture_slot!;
  const cam = v.camera;
  cam.updateMatrixWorld();
  const e = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(s.world()).elements;
  const W = v.width,
    H = v.height;
  let ang = t.angle;
  let ox = 0,
    oy = 0;
  if (t.map_mode === 'RANDOM') {
    ang += hash2(dabIndex, 7.3) * Math.PI * 2;
    ox = hash2(dabIndex, 1.1) * 2;
    oy = hash2(dabIndex, 2.9) * 2;
  }
  const cos = Math.cos(-ang),
    sin = Math.sin(-ang);
  const scale = Math.max(1e-3, t.scale);
  const k = t.strength ?? 1;
  const P = s.positions;
  return (vi: number) => {
    const x = P[vi * 3],
      y = P[vi * 3 + 1],
      z = P[vi * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (cw <= 1e-9) return 1;
    const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * W;
    const sy = (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5 + 0.5) * H;
    let u: number, w: number;
    if (t.map_mode === 'TILED') {
      u = sx / (radiusPx * scale);
      w = -sy / (radiusPx * scale);
    } else {
      const dx = (sx - cx) / radiusPx,
        dy = -(sy - cy) / radiusPx;
      u = (dx * cos - dy * sin) / scale + ox;
      w = (dx * sin + dy * cos) / scale + oy;
    }
    const f = sampleTex(t, u, w);
    return 1 - k + k * f;
  };
}
