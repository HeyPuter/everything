import type { Mask8, RGBA8 } from '../types';
import { M, blendChannel, blendColor, blendModeIndex, hash01, isSeparable, type BlendMode } from './modes';

// 8-bit B(Cb, Cs) tables for separable modes, built on first use (64 KiB each).
const luts: (Uint8Array | undefined)[] = [];
export function separableLut(mode: BlendMode | number): Uint8Array {
  const m = blendModeIndex(mode);
  let lut = luts[m];
  if (!lut) {
    lut = new Uint8Array(65536);
    for (let b = 0; b < 256; b++)
      for (let s = 0; s < 256; s++)
        lut[(b << 8) | s] = Math.round(blendChannel(m, b / 255, s / 255) * 255);
    luts[m] = lut;
  }
  return lut;
}

// Composites `src` onto `back` in place with source-over and the given blend
// mode (W3C: Cs' = (1 - ab) Cs + ab B(Cb, Cs)). `src` sits at `offset` in
// back's coordinates; `mask` (same size as src) scales its coverage. Pixels
// outside the overlap are left untouched. Dissolve uses `seed` with document
// coordinates so re-renders are stable.
export function compositeRGBA8(
  back: RGBA8,
  src: RGBA8,
  mode: BlendMode | number = 'normal',
  opacity = 1,
  mask?: Mask8,
  offset: { x: number; y: number } = { x: 0, y: 0 },
  seed = 0,
): RGBA8 {
  const m = blendModeIndex(mode);
  const ox = Math.round(offset.x), oy = Math.round(offset.y);
  const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
  const x1 = Math.min(back.width, ox + src.width), y1 = Math.min(back.height, oy + src.height);
  if (x1 <= x0 || y1 <= y0 || opacity <= 0) return back;
  const bd = back.data, sd = src.data, md = mask?.data;
  const sep = isSeparable(m) && m !== M.normal && m !== M.dissolve;
  const lut = sep ? separableLut(m) : undefined;
  const normal = m === M.normal || m === M.dissolve;
  const bc = [0, 0, 0], sc = [0, 0, 0], out = [0, 0, 0];
  const k = opacity / 255;
  for (let y = y0; y < y1; y++) {
    let bi = (y * back.width + x0) * 4;
    let si = ((y - oy) * src.width + (x0 - ox)) * 4;
    let mi = (y - oy) * src.width + (x0 - ox);
    for (let x = x0; x < x1; x++, bi += 4, si += 4, mi++) {
      let as = sd[si + 3] * k;
      if (md) as *= md[mi] / 255;
      if (as <= 0) continue;
      if (m === M.dissolve) {
        if (hash01(x, y, seed) >= as) continue;
        as = 1;
      }
      if (as > 1) as = 1;
      const ab = bd[bi + 3] / 255;
      const ao = as + ab * (1 - as);
      const wb = ((1 - as) * ab) / ao, ws = as / ao;
      if (normal || ab === 0) {
        bd[bi] = sd[si] * ws + bd[bi] * wb;
        bd[bi + 1] = sd[si + 1] * ws + bd[bi + 1] * wb;
        bd[bi + 2] = sd[si + 2] * ws + bd[bi + 2] * wb;
      } else if (lut) {
        const ka = 1 - ab;
        for (let c = 0; c < 3; c++) {
          const cb = bd[bi + c], cs = sd[si + c];
          bd[bi + c] = (ka * cs + ab * lut[(cb << 8) | cs]) * ws + cb * wb;
        }
      } else {
        bc[0] = bd[bi] / 255; bc[1] = bd[bi + 1] / 255; bc[2] = bd[bi + 2] / 255;
        sc[0] = sd[si] / 255; sc[1] = sd[si + 1] / 255; sc[2] = sd[si + 2] / 255;
        blendColor(m, bc, sc, out);
        const ka = 1 - ab;
        for (let c = 0; c < 3; c++)
          bd[bi + c] = ((ka * sc[c] + ab * out[c]) * ws + bc[c] * wb) * 255;
      }
      bd[bi + 3] = ao * 255;
    }
  }
  return back;
}

// Paints `src` onto `back` (same size) with locked transparency: each pixel's
// color moves toward the blended color by the source coverage, and alpha
// stays as it is, as brushes and fills do on a layer whose transparency is
// locked. Where the backdrop is partly transparent the blend result is mixed
// with the plain source color by the backdrop alpha (W3C Cs').
export function compositeRGBA8KeepAlpha(
  back: RGBA8,
  src: RGBA8,
  mode: BlendMode | number = 'normal',
  opacity = 1,
  mask?: Mask8,
  seed = 0,
): RGBA8 {
  const m = blendModeIndex(mode);
  if (opacity <= 0) return back;
  const w = Math.min(back.width, src.width), h = Math.min(back.height, src.height);
  const bd = back.data, sd = src.data, md = mask?.data;
  const normal = m === M.normal || m === M.dissolve;
  const lut = !normal && isSeparable(m) ? separableLut(m) : undefined;
  const bc = [0, 0, 0], sc = [0, 0, 0], out = [0, 0, 0];
  const k = opacity / 255;
  for (let y = 0; y < h; y++) {
    let bi = y * back.width * 4, si = y * src.width * 4, mi = y * src.width;
    for (let x = 0; x < w; x++, bi += 4, si += 4, mi++) {
      let a = sd[si + 3] * k;
      if (md) a *= md[mi] / 255;
      if (a <= 0) continue;
      if (m === M.dissolve) {
        if (hash01(x, y, seed) >= a) continue;
        a = 1;
      }
      if (a > 1) a = 1;
      const ab = bd[bi + 3] / 255;
      if (normal || ab === 0) {
        for (let c = 0; c < 3; c++) bd[bi + c] += (sd[si + c] - bd[bi + c]) * a;
      } else if (lut) {
        for (let c = 0; c < 3; c++) {
          const cb = bd[bi + c], cs = sd[si + c];
          bd[bi + c] = cb + (cs + (lut[(cb << 8) | cs] - cs) * ab - cb) * a;
        }
      } else {
        bc[0] = bd[bi] / 255; bc[1] = bd[bi + 1] / 255; bc[2] = bd[bi + 2] / 255;
        sc[0] = sd[si] / 255; sc[1] = sd[si + 1] / 255; sc[2] = sd[si + 2] / 255;
        blendColor(m, bc, sc, out);
        for (let c = 0; c < 3; c++)
          bd[bi + c] = (bc[c] + (sc[c] + (out[c] - sc[c]) * ab - bc[c]) * a) * 255;
      }
    }
  }
  return back;
}

// Layer opacity versus fill opacity: fill opacity scales only the layer's own
// pixels (and interior effects composite onto that faded fill), while layer
// opacity scales the whole group of layer plus effects. A shape with fill 0
// and a stroke shows just the stroke at full strength.
export type LayerOpacity = { layerOpacity: number; fillOpacity: number };
export function effectiveOpacities({ layerOpacity, fillOpacity }: LayerOpacity) {
  const l = Math.min(1, Math.max(0, layerOpacity));
  const f = Math.min(1, Math.max(0, fillOpacity));
  return { content: l * f, effects: l, fill: f, layer: l };
}
// Scales the alpha of `img` by `fillOpacity` in place.
export function applyFillOpacity(img: RGBA8, fillOpacity: number): RGBA8 {
  if (fillOpacity >= 1) return img;
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] *= fillOpacity;
  return img;
}
// Knockout: removes `target` coverage wherever `knock` (aligned, same size)
// has coverage, as "layer knocks out drop shadow" does with the layer shape.
export function knockoutAlpha(target: RGBA8, knock: RGBA8): RGBA8 {
  const t = target.data, k = knock.data;
  for (let i = 3; i < t.length; i += 4) t[i] = (t[i] * (255 - k[i])) / 255;
  return target;
}
