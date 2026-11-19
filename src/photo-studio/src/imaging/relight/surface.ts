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
  isIdentityRelight,
  prepareLights,
  relightGeometry,
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

const GAMMA_INV = 1 / 2.2;

/** Bilinear taps along one axis: for each full-resolution coordinate, the
 * two reduced indices and the weight of the second. */
function axisTaps(n: number, factor: number, size: number) {
  const i0 = new Int32Array(n),
    i1 = new Int32Array(n),
    t = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const q = (v + 0.5) / factor - 0.5,
      iq = Math.floor(q);
    i0[v] = Math.min(size - 1, Math.max(0, iq));
    i1[v] = Math.min(size - 1, Math.max(0, iq + 1));
    t[v] = q - iq;
  }
  return { i0, i1, t };
}

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
  const n = lights.length;
  const surface =
    opts.surface ?? estimateSurface(px, width, height, p, docWidth, docHeight, ox, oy);
  const g = surface.geometry,
    N = surface.normals,
    S = surface.shadows;
  const ambient = p.ambient / 100;
  const cols = axisTaps(width, g.factor, g.width),
    rows = axisTaps(height, g.factor, g.height);
  // Light records as flat arrays (x, y, z, reach, r, g, b, wrap).
  const L = new Float64Array(n * 8);
  lights.forEach((l, k) => L.set([l.x, l.y, l.z, l.reach, l.r, l.g, l.b, l.wrap], k * 8));
  const shade = new Float64Array(8).fill(1);
  const w = g.width;
  for (let y = 0; y < height; y++) {
    const r0 = rows.i0[y] * w,
      r1 = rows.i1[y] * w,
      ty = rows.t[y];
    const Y = oy + y + 0.5;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!(px[i + 3] > 0)) continue;
      const tx = cols.t[x];
      const a = (r0 + cols.i0[x]) * 4,
        b = (r0 + cols.i1[x]) * 4,
        c = (r1 + cols.i0[x]) * 4,
        d = (r1 + cols.i1[x]) * 4;
      const w00 = (1 - tx) * (1 - ty),
        w10 = tx * (1 - ty),
        w01 = (1 - tx) * ty,
        w11 = tx * ty;
      let nx = N[a] * w00 + N[b] * w10 + N[c] * w01 + N[d] * w11,
        ny = N[a + 1] * w00 + N[b + 1] * w10 + N[c + 1] * w01 + N[d + 1] * w11,
        nz = N[a + 2] * w00 + N[b + 2] * w10 + N[c + 2] * w01 + N[d + 2] * w11;
      const H = N[a + 3] * w00 + N[b + 3] * w10 + N[c + 3] * w01 + N[d + 3] * w11;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-6) ((nx /= len), (ny /= len), (nz /= len));
      else ((nx = 0), (ny = 0), (nz = 1));
      if (S)
        for (let ch = 0; ch < 4 && 2 * ch < n; ch++) {
          // Unpack each tap, then interpolate (as the shader does).
          let hi = 0,
            lo = 0;
          for (let q = 0; q < 4; q++) {
            const v = S[(q === 0 ? a : q === 1 ? b : q === 2 ? c : d) + ch];
            const wt = q === 0 ? w00 : q === 1 ? w10 : q === 2 ? w01 : w11;
            const h8 = Math.floor(v / 256);
            hi += h8 * wt;
            lo += (v - h8 * 256) * wt;
          }
          shade[2 * ch] = hi / 255;
          shade[2 * ch + 1] = lo / 255;
        }
      const X = ox + x + 0.5;
      let sr = 0,
        sg = 0,
        sb = 0;
      for (let k = 0; k < n; k++) {
        const o = k * 8;
        const lx = L[o] - X,
          ly = L[o + 1] - Y,
          lz = L[o + 2] - H;
        const dist = Math.max(1e-3, Math.sqrt(lx * lx + ly * ly + lz * lz));
        const ndl = (nx * lx + ny * ly + nz * lz) / dist;
        const wrap = L[o + 7];
        const dif = (ndl + wrap) / (1 + wrap);
        if (dif <= 0) continue;
        const q = dist / L[o + 3];
        const e = (dif / (1 + q * q)) * shade[k];
        sr += L[o + 4] * e;
        sg += L[o + 5] * e;
        sb += L[o + 6] * e;
      }
      // In linear light the color is scaled by (ambient + light); back in
      // gamma space that is the same as scaling by its 1/2.2 power.
      const v0 = Math.max(0, px[i]) * Math.pow(ambient + sr, GAMMA_INV),
        v1 = Math.max(0, px[i + 1]) * Math.pow(ambient + sg, GAMMA_INV),
        v2 = Math.max(0, px[i + 2]) * Math.pow(ambient + sb, GAMMA_INV);
      out[i] = clampTop ? Math.min(1, v0) : v0;
      out[i + 1] = clampTop ? Math.min(1, v1) : v1;
      out[i + 2] = clampTop ? Math.min(1, v2) : v2;
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
