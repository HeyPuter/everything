// Surface estimate and shading of relight layers: the exact CPU reference.
// src/renderer/filter-shaders.ts runs the same passes on the GPU (modes 1, 2
// and 6-10); keep both in step.
//
// The shape is guessed from luminance, as a painter reads form from light:
//   1. Reduce the image to at most RELIGHT_WORK pixels on the long side
//      (block averages of luma * alpha and alpha).
//   2. Blur at three scales (fine, medium, broad) and mix them into a height
//      map; `detail` moves weight from the broad scale to the fine one.
//   3. Smooth the height map with a cross-bilateral filter guided by the fine
//      luminance, so object edges stay crisp while textures flatten out.
//   4. Normals from the height gradient (central differences) scaled by the
//      relief; the height in document pixels is kept for the light vectors.
//   5. Optional soft shadows: march from each texel toward each light over
//      the height map; a penumbra grows with distance and the light's
//      softness. Two lights share a channel at 8-bit precision.
// Shading (per document pixel) samples the reduced planes bilinearly and
// adds wrapped diffuse light with an inverse-square-like falloff, in linear
// light, to the existing lighting scaled by the ambient amount.
import type { RGBA8 } from '../types';
import { luma } from '../adjust/color-math';
import {
  fromLinear,
  isIdentityRelight,
  prepareLights,
  relightGeometry,
  toLinear,
  type PreparedLight,
  type RelightGeometry,
  type RelightParams,
} from './model';

export type Surface = {
  geometry: RelightGeometry;
  // Per reduced texel: normal x, y, z and height in document pixels.
  normals: Float32Array;
  // Per reduced texel: four channels, two packed shadow factors each (see packPair).
  shadows?: Float32Array;
};

function gaussian(
  src: Float32Array,
  w: number,
  h: number,
  sigma: number,
  radius: number,
  horizontal: boolean,
) {
  const out = new Float32Array(src.length);
  const k = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++)
    sum += k[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) {
        const sx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x,
          sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        acc += k[i + radius] * src[sy * w + sx];
      }
      out[y * w + x] = acc / sum;
    }
  return out;
}

function bilateral(
  hgt: Float32Array,
  guide: Float32Array,
  w: number,
  h: number,
  g: RelightGeometry,
  horizontal: boolean,
) {
  const out = new Float32Array(hgt.length);
  const r = g.radiusS,
    s2 = 2 * g.sigmaS * g.sigmaS,
    r2 = 2 * g.sigmaR * g.sigmaR;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = guide[y * w + x];
      let acc = 0,
        sw = 0;
      for (let i = -r; i <= r; i++) {
        const sx = horizontal ? Math.min(w - 1, Math.max(0, x + i)) : x,
          sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + i));
        const j = sy * w + sx,
          d = guide[j] - c;
        const wt = Math.exp(-(i * i) / s2) * Math.exp(-(d * d) / r2);
        acc += wt * hgt[j];
        sw += wt;
      }
      out[y * w + x] = acc / sw;
    }
  return out;
}

/** Two shadow factors in 0..1 as one exactly representable float. */
export const packPair = (a: number, b: number) =>
  Math.floor(Math.min(1, Math.max(0, a)) * 255 + 0.5) * 256 +
  Math.floor(Math.min(1, Math.max(0, b)) * 255 + 0.5);
export function unpackPair(v: number): [number, number] {
  const hi = Math.floor(v / 256);
  return [hi / 255, (v - hi * 256) / 255];
}

/** Shadow factor (1 = lit) of one light at reduced texel (bx, by). */
export function shadowAt(
  normals: Float32Array,
  g: RelightGeometry,
  bx: number,
  by: number,
  l: PreparedLight,
  strength: number,
): number {
  const w = g.width,
    f = g.factor;
  const H = normals[(by * w + bx) * 4 + 3];
  const px = (bx + 0.5) * f,
    py = (by + 0.5) * f;
  const dx = l.x - px,
    dy = l.y - py;
  const dist = Math.hypot(dx, dy);
  if (dist < f) return 1;
  // Unit step in reduced pixels toward the light.
  const ux = dx / dist,
    uy = dy / dist;
  const rise = (l.z - H) / dist; // height gained per document pixel
  const soft = 0.05 + 0.5 * l.wrap;
  let t = 0,
    occl = 0;
  for (let i = 0; i < g.shadowSteps; i++) {
    t += g.shadowStep * (1 + 0.25 * i);
    const travel = t * f;
    if (travel >= dist) break;
    const sx = Math.floor(bx + 0.5 + ux * t),
      sy = Math.floor(by + 0.5 + uy * t);
    if (sx < 0 || sy < 0 || sx >= w || sy >= g.height) break;
    const above = normals[(sy * w + sx) * 4 + 3] - (H + rise * travel);
    if (above <= 0) continue;
    const pen = soft * travel + 1e-3;
    const o = Math.min(1, above / pen);
    const k = o * o * (3 - 2 * o);
    if (k > occl) occl = k;
  }
  return 1 - occl * strength;
}

/** Steps 1-5 on straight RGBA floats in 0..1 (stride 4). */
export function estimateSurface(
  px: Float32Array,
  width: number,
  height: number,
  p: RelightParams,
  docWidth = width,
  docHeight = height,
  ox = 0,
  oy = 0,
): Surface {
  const g = relightGeometry(width, height, p, Math.max(docWidth, docHeight));
  const { factor: f, width: w, height: h } = g;
  const la = new Float32Array(w * h),
    al = new Float32Array(w * h);
  for (let by = 0; by < h; by++)
    for (let bx = 0; bx < w; bx++) {
      let sl = 0,
        sa = 0,
        n = 0;
      const x1 = Math.min(width, bx * f + f),
        y1 = Math.min(height, by * f + f);
      for (let y = by * f; y < y1; y++)
        for (let x = bx * f; x < x1; x++) {
          const i = (y * width + x) * 4;
          sl += luma(px[i], px[i + 1], px[i + 2]) * px[i + 3];
          sa += px[i + 3];
          n++;
        }
      la[by * w + bx] = sl / n;
      al[by * w + bx] = sa / n;
    }
  const lum: Float32Array[] = [];
  for (let s = 0; s < 3; s++) {
    const sg = g.sigmas[s],
      r = g.radii[s];
    const bl = gaussian(gaussian(la, w, h, sg, r, true), w, h, sg, r, false);
    const ba = gaussian(gaussian(al, w, h, sg, r, true), w, h, sg, r, false);
    lum.push(bl.map((v, i) => (ba[i] > 1e-6 ? v / ba[i] : 0)));
  }
  const guide = lum[0];
  let hgt = new Float32Array(w * h);
  for (let i = 0; i < hgt.length; i++)
    hgt[i] = g.weights[0] * lum[0][i] + g.weights[1] * lum[1][i] + g.weights[2] * lum[2][i];
  hgt = bilateral(hgt, guide, w, h, g, true);
  hgt = bilateral(hgt, guide, w, h, g, false);
  const normals = new Float32Array(w * h * 4);
  const slope = g.relief / f;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const at = (xx: number, yy: number) =>
        hgt[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
      const nx = -((at(x + 1, y) - at(x - 1, y)) / 2) * slope,
        ny = -((at(x, y + 1) - at(x, y - 1)) / 2) * slope;
      const len = Math.hypot(nx, ny, 1);
      const o = (y * w + x) * 4;
      normals[o] = nx / len;
      normals[o + 1] = ny / len;
      normals[o + 2] = 1 / len;
      normals[o + 3] = hgt[y * w + x] * g.relief;
    }
  const surface: Surface = { geometry: g, normals };
  const lights = prepareLights(p, docWidth, docHeight).map((l) => ({
    ...l,
    x: l.x - ox,
    y: l.y - oy,
  }));
  if (p.shadows > 0 && lights.length) {
    const strength = p.shadows / 100;
    const sh = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++) {
          const a = lights[2 * c] ? shadowAt(normals, g, x, y, lights[2 * c], strength) : 1;
          const b = lights[2 * c + 1] ? shadowAt(normals, g, x, y, lights[2 * c + 1], strength) : 1;
          sh[(y * w + x) * 4 + c] = packPair(a, b);
        }
    surface.shadows = sh;
  }
  return surface;
}

/** Bilinear coordinates of full-resolution pixel (x, y) in a reduced plane. */
function taps(g: RelightGeometry, x: number, y: number) {
  const qx = (x + 0.5) / g.factor - 0.5,
    qy = (y + 0.5) / g.factor - 0.5;
  const ix = Math.floor(qx),
    iy = Math.floor(qy);
  const x0 = Math.min(g.width - 1, Math.max(0, ix)),
    x1 = Math.min(g.width - 1, Math.max(0, ix + 1)),
    y0 = Math.min(g.height - 1, Math.max(0, iy)),
    y1 = Math.min(g.height - 1, Math.max(0, iy + 1));
  return {
    i00: y0 * g.width + x0,
    i10: y0 * g.width + x1,
    i01: y1 * g.width + x0,
    i11: y1 * g.width + x1,
    tx: qx - ix,
    ty: qy - iy,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Relit straight RGBA floats. (ox, oy): document position of the first
 * pixel; the lights are placed in a document of docWidth x docHeight. */
export function relightFloat(
  px: Float32Array,
  width: number,
  height: number,
  p: RelightParams,
  opts: {
    ox?: number;
    oy?: number;
    docWidth?: number;
    docHeight?: number;
    clampTop?: boolean;
    surface?: Surface;
  } = {},
): Float32Array {
  const out = new Float32Array(px);
  if (isIdentityRelight(p)) return out;
  const ox = opts.ox ?? 0,
    oy = opts.oy ?? 0;
  const docWidth = opts.docWidth ?? width,
    docHeight = opts.docHeight ?? height;
  const clampTop = opts.clampTop ?? true;
  const lights = prepareLights(p, docWidth, docHeight);
  const surface =
    opts.surface ?? estimateSurface(px, width, height, p, docWidth, docHeight, ox, oy);
  const g = surface.geometry,
    N = surface.normals,
    S = surface.shadows;
  const ambient = p.ambient / 100;
  const shade = new Float64Array(8);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!(px[i + 3] > 0)) continue;
      const t = taps(g, x, y);
      const bil = (plane: Float32Array, c: number) =>
        lerp(
          lerp(plane[t.i00 * 4 + c], plane[t.i10 * 4 + c], t.tx),
          lerp(plane[t.i01 * 4 + c], plane[t.i11 * 4 + c], t.tx),
          t.ty,
        );
      let nx = bil(N, 0),
        ny = bil(N, 1),
        nz = bil(N, 2);
      const H = bil(N, 3);
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-6) ((nx /= len), (ny /= len), (nz /= len));
      else ((nx = 0), (ny = 0), (nz = 1));
      shade.fill(1);
      if (S)
        for (let c = 0; c < 4; c++) {
          const a = [t.i00, t.i10, t.i01, t.i11].map((k) => unpackPair(S[k * 4 + c]));
          shade[2 * c] = lerp(lerp(a[0][0], a[1][0], t.tx), lerp(a[2][0], a[3][0], t.tx), t.ty);
          shade[2 * c + 1] = lerp(lerp(a[0][1], a[1][1], t.tx), lerp(a[2][1], a[3][1], t.tx), t.ty);
        }
      const X = ox + x + 0.5,
        Y = oy + y + 0.5;
      let sr = 0,
        sg = 0,
        sb = 0;
      for (let k = 0; k < lights.length; k++) {
        const l = lights[k];
        const lx = l.x - X,
          ly = l.y - Y,
          lz = l.z - H;
        const dist = Math.max(1e-3, Math.hypot(lx, ly, lz));
        const ndl = (nx * lx + ny * ly + nz * lz) / dist;
        const d = Math.max(0, (ndl + l.wrap) / (1 + l.wrap));
        const q = dist / l.reach;
        const e = (d / (1 + q * q)) * shade[k];
        sr += l.r * e;
        sg += l.g * e;
        sb += l.b * e;
      }
      const vals = [sr, sg, sb];
      for (let c = 0; c < 3; c++) {
        const v = fromLinear(toLinear(px[i + c]) * (ambient + vals[c]));
        out[i + c] = clampTop ? Math.min(1, v) : v;
      }
    }
  return out;
}

// The last few estimates, keyed by the source content and the settings the
// shape depends on: moving or recoloring lights reuses the shape.
const surfaceCache: { key: string; surface: Surface }[] = [];
function contentKey(px: Float32Array, width: number, height: number) {
  let h = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(px.length / 65536));
  for (let i = 0; i < px.length; i += step)
    h = Math.imul(h ^ Math.round(px[i] * 65535), 16777619) >>> 0;
  return `${width}x${height}:${px.length}:${h.toString(36)}`;
}
export function cachedSurface(
  px: Float32Array,
  width: number,
  height: number,
  p: RelightParams,
  docWidth: number,
  docHeight: number,
  ox: number,
  oy: number,
): Surface {
  const lights =
    p.shadows > 0
      ? JSON.stringify(prepareLights(p, docWidth, docHeight).map((l) => [l.x, l.y, l.z, l.wrap]))
      : '';
  const key = `${contentKey(px, width, height)}:${p.relief}:${p.detail}:${p.shadows}:${docWidth}x${docHeight}:${ox},${oy}:${lights}`;
  const hit = surfaceCache.find((c) => c.key === key);
  if (hit) return hit.surface;
  const surface = estimateSurface(px, width, height, p, docWidth, docHeight, ox, oy);
  surfaceCache.unshift({ key, surface });
  surfaceCache.length = Math.min(surfaceCache.length, 3);
  return surface;
}

export type RelightContext = { x?: number; y?: number; docWidth?: number; docHeight?: number };

/** Relight an RGBA8 image (alpha kept). */
export function relight(src: RGBA8, p: RelightParams, ctx: RelightContext = {}): RGBA8 {
  const px = new Float32Array(src.data.length);
  for (let i = 0; i < px.length; i++) px[i] = src.data[i] / 255;
  const ox = Math.round(ctx.x ?? 0),
    oy = Math.round(ctx.y ?? 0);
  const docWidth = ctx.docWidth ?? src.width,
    docHeight = ctx.docHeight ?? src.height;
  const surface = cachedSurface(px, src.width, src.height, p, docWidth, docHeight, ox, oy);
  const res = relightFloat(px, src.width, src.height, p, { ox, oy, docWidth, docHeight, surface });
  const out: RGBA8 = {
    width: src.width,
    height: src.height,
    data: new Uint8ClampedArray(src.data),
  };
  for (let i = 0; i < res.length; i++) if ((i & 3) !== 3) out.data[i] = res[i] * 255;
  return out;
}
