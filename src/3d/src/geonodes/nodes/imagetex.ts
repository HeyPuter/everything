// Image Texture in geometry trees: samples an image's pixels on the CPU at UV coordinates (the
// Vector input, Position when unlinked) with linear / closest / cubic interpolation and the four
// extension modes. Pixels come from the image canvas; trees re-evaluate once decoding finished.
import { geoNode, sock, enumProp } from './gndef';
import { idSocketBody, sprop } from './defs';
import { positionField } from '../inputs';
import { textureFields } from './textures';
import { app, onAppReady } from '../../app/app';
import { imageCanvas, imageReady } from '../../render/images';
import type { ImageData as Img } from '../../data/types';

interface Pixels {
  key: string;
  w: number;
  h: number;
  /** linear RGBA floats */
  data: Float32Array;
}

const cache = new Map<string, Pixels>();
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LUT = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

const keyOf = (img: Img) => `${img.width}x${img.height}|${img.revision ?? 0}|${img.bytes?.length ?? 0}|${img.colorspace}|${img.source}`;

let pending = false;
/** Re-evaluate the trees once a decoding image becomes available. */
function waitFor(img: Img) {
  if (pending) return;
  pending = true;
  let tries = 0;
  const tick = () => {
    if (imageReady(img) || ++tries > 100) {
      pending = false;
      if (imageReady(img)) refresh?.();
      return;
    }
    setTimeout(tick, 50);
  };
  setTimeout(tick, 50);
}
let refresh: (() => void) | null = null;
onAppReady(() => (refresh = () => app.changed('doc')));

/** Linear RGBA pixels of an image, or null while it is still decoding. */
export function imagePixels(img: Img): Pixels | null {
  if (typeof document === 'undefined') return null;
  const key = keyOf(img);
  const hit = cache.get(img.id);
  if (hit && hit.key === key) return hit;
  let canvas: HTMLCanvasElement;
  try {
    canvas = imageCanvas(img);
  } catch {
    return null;
  }
  if (!imageReady(img)) {
    waitFor(img);
    return null;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const w = canvas.width,
    h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h * 4);
  const lin = img.colorspace !== 'Non-Color';
  // canvas rows run top to bottom; texture rows bottom to top
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4,
        o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = lin ? LUT[d[s + c]] : d[s + c] / 255;
      data[o + 3] = d[s + 3] / 255;
    }
  const px = { key, w, h, data };
  cache.set(img.id, px);
  return px;
}

type Ext = 'REPEAT' | 'EXTEND' | 'CLIP' | 'MIRROR';

/** Texel (x, y) after the extension mode; null outside a clipped image. */
function texel(p: Pixels, x: number, y: number, ext: Ext, out: number[], w: number) {
  let ix = x,
    iy = y;
  if (ext === 'REPEAT') {
    ix = ((ix % p.w) + p.w) % p.w;
    iy = ((iy % p.h) + p.h) % p.h;
  } else if (ext === 'MIRROR') {
    const mx = ((ix % (2 * p.w)) + 2 * p.w) % (2 * p.w),
      my = ((iy % (2 * p.h)) + 2 * p.h) % (2 * p.h);
    ix = mx < p.w ? mx : 2 * p.w - 1 - mx;
    iy = my < p.h ? my : 2 * p.h - 1 - my;
  } else if (ext === 'CLIP') {
    if (ix < 0 || iy < 0 || ix >= p.w || iy >= p.h) return;
  } else {
    ix = Math.max(0, Math.min(p.w - 1, ix));
    iy = Math.max(0, Math.min(p.h - 1, iy));
  }
  const o = (iy * p.w + ix) * 4;
  for (let c = 0; c < 4; c++) out[c] += p.data[o + c] * w;
}

/** Cubic B-spline weights for fractional offset t. */
function bspline(t: number): [number, number, number, number] {
  const t2 = t * t,
    t3 = t2 * t;
  return [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
}

export function sampleImage(p: Pixels, u: number, v: number, interp: string, ext: Ext, out: number[]) {
  out[0] = out[1] = out[2] = out[3] = 0;
  if (ext === 'CLIP' && (u < 0 || v < 0 || u > 1 || v > 1)) return out;
  const fx = u * p.w,
    fy = v * p.h;
  if (interp === 'Closest') {
    texel(p, Math.floor(fx), Math.floor(fy), ext, out, 1);
    return out;
  }
  const x = fx - 0.5,
    y = fy - 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const tx = x - ix,
    ty = y - iy;
  if (interp === 'Cubic' || interp === 'Smart') {
    const wx = bspline(tx),
      wy = bspline(ty);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) texel(p, ix - 1 + i, iy - 1 + j, ext, out, wx[i] * wy[j]);
    return out;
  }
  texel(p, ix, iy, ext, out, (1 - tx) * (1 - ty));
  texel(p, ix + 1, iy, ext, out, tx * (1 - ty));
  texel(p, ix, iy + 1, ext, out, (1 - tx) * ty);
  texel(p, ix + 1, iy + 1, ext, out, tx * ty);
  return out;
}

const imageSock = sock('Image', 'IMAGE', { hide_value: true });

geoNode(
  {
    idname: 'GeometryNodeImageTexture',
    label: 'Image Texture',
    category: 'texture',
    width: 240,
    description: 'Sample values from an image texture',
    inputs: [imageSock, sock('Vector', 'VECTOR', { hide_value: true, field: true }), sock('Frame', 'INT', { d: 0 })],
    outputs: [sock('Color', 'RGBA', { dot: true }), sock('Alpha', 'FLOAT', { dot: true })],
    props: [
      enumProp('interpolation', 'Interpolation', [
        ['Linear', 'Linear'],
        ['Closest', 'Closest'],
        ['Cubic', 'Cubic'],
      ]),
      enumProp('extension', 'Extension', [
        ['REPEAT', 'Repeat'],
        ['EXTEND', 'Extend'],
        ['CLIP', 'Clip'],
        ['MIRROR', 'Mirror'],
      ]),
    ],
    drawBody: (ctx) => idSocketBody(ctx, ctx.tree.links.some((l) => l.to_node === ctx.node.id && l.to_socket === 'Image') ? [] : [imageSock]),
    bodyHeight: () => 26,
  },
  {
    exec: (ctx) => {
      const id = ctx.idRef('Image');
      const img = id ? ctx.env.doc.images[id] : undefined;
      const px = img ? imagePixels(img) : null;
      const interp = sprop(ctx.node, 'interpolation') || 'Linear';
      const ext = (sprop(ctx.node, 'extension') || 'REPEAT') as Ext;
      return textureFields(ctx, {
        inputs: [['Vector', 'VECTOR']],
        outputs: [
          ['Color', 'RGBA'],
          ['Alpha', 'FLOAT'],
        ],
        kernel: () => {
          const c = [0, 0, 0, 0];
          return (iv, ov) => {
            if (!px) return;
            sampleImage(px, iv[0], iv[1], interp, ext, c);
            ov[0] = c[0];
            ov[1] = c[1];
            ov[2] = c[2];
            ov[3] = c[3];
            ov[4] = c[3];
          };
        },
      });
    },
    implicit: { Vector: positionField },
    sig: (n, env) => {
      const id = n.inputs.Image as string | null;
      const img = id ? env.doc.images[id] : undefined;
      return img ? `${keyOf(img)}|${imageReady(img) ? 1 : 0}` : '';
    },
  },
);
