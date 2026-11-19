// Pure helpers for the retouching and selection UI: stroke masks, crops,
// write-back blending, outlines for previews and layer matting. No DOM, so they
// are unit-tested under Node and can run in the worker.
import { mask8, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';
import { maskToOutline } from '../../imaging/segment/mask-ops';
import { decontaminate, refineEdge } from '../../imaging/segment/refine';
import { colorRange, type ColorRangePreset } from '../../imaging/segment/color-select';
import { boundingBox } from '../../imaging/segment/mask-ops';
import { KNOWN, UNKNOWN, solveMembrane } from '../../imaging/retouch/poisson';
import { blendColor } from '../../imaging/blend/modes';

export type Pt = [number, number];

export function clampRect(r: IRect, w: number, h: number): IRect | null {
  const x0 = Math.max(0, Math.floor(r.x)),
    y0 = Math.max(0, Math.floor(r.y)),
    x1 = Math.min(w, Math.ceil(r.x + r.width)),
    y1 = Math.min(h, Math.ceil(r.y + r.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
export function expandRect(r: IRect, m: number, w: number, h: number): IRect | null {
  return clampRect({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m }, w, h);
}
/** Bounds of a polyline drawn with a round brush of `radius`. */
export function strokeBounds(points: Pt[], radius: number): IRect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const r = radius + 1;
  return { x: Math.floor(x0 - r), y: Math.floor(y0 - r), width: Math.ceil(x1 - x0 + 2 * r) + 1, height: Math.ceil(y1 - y0 + 2 * r) + 1 };
}

/** Round dabs along a polyline (document coordinates) into a mask covering
 * `rect`. Coverage combines by maximum, so overlapping dabs never exceed the
 * tip profile; the falloff matches the paint engine's soft tips. */
export function strokeMask(points: Pt[], size: number, hardness: number, rect: IRect): Mask8 {
  const m = mask8(rect.width, rect.height);
  if (!points.length) return m;
  const radius = Math.max(0.5, size / 2),
    hard = Math.min(0.999, Math.max(0, hardness));
  const inner = radius * hard,
    soft = Math.max(1, radius - inner);
  const dab = (cx: number, cy: number) => {
    const x0 = Math.max(0, Math.floor(cx - radius - 1 - rect.x)),
      x1 = Math.min(rect.width, Math.ceil(cx + radius + 1 - rect.x)),
      y0 = Math.max(0, Math.floor(cy - radius - 1 - rect.y)),
      y1 = Math.min(rect.height, Math.ceil(cy + radius + 1 - rect.y));
    for (let y = y0; y < y1; y++) {
      const dy = y + rect.y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + rect.x + 0.5 - cx,
          r = Math.sqrt(dx * dx + dy * dy);
        if (r >= radius + 0.5) continue;
        let a: number;
        if (r <= inner - 0.5) a = 1;
        else if (hard > 0.99) a = Math.min(1, radius + 0.5 - r);
        else {
          const t = Math.min(1, Math.max(0, (r - inner) / soft));
          a = (1 - t * t) * (1 - t * t);
        }
        const v = Math.round(a * 255),
          i = y * rect.width + x;
        if (v > m.data[i]) m.data[i] = v;
      }
    }
  };
  const step = Math.max(0.5, size * 0.12);
  dab(points[0][0], points[0][1]);
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1],
      [bx, by] = points[k],
      len = Math.hypot(bx - ax, by - ay),
      n = Math.ceil(len / step);
    for (let s = 1; s <= n; s++) dab(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
  }
  return m;
}

export function cropRGBA(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}
export function cropMask(m: Mask8, r: IRect): Mask8 {
  const out = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) out.set(m.data.subarray((y + r.y) * m.width + r.x, (y + r.y) * m.width + r.x + r.width), y * r.width);
  return { width: r.width, height: r.height, data: out };
}
/** Copy `src` into `dst` at (x, y), clipped to `dst`. */
export function pasteMask(dst: Mask8, src: Mask8, x: number, y: number) {
  for (let v = Math.max(0, -y); v < src.height && v + y < dst.height; v++) {
    const u0 = Math.max(0, -x),
      u1 = Math.min(src.width, dst.width - x);
    if (u1 > u0) dst.data.set(src.data.subarray(v * src.width + u0, v * src.width + u1), (v + y) * dst.width + x + u0);
  }
  return dst;
}
/** A mask translated by whole pixels; uncovered areas become 0. */
export function shiftMask(m: Mask8, dx: number, dy: number): Mask8 {
  return pasteMask(mask8(m.width, m.height), m, Math.round(dx), Math.round(dy));
}

/** Limit a change to the selection: `after` moves back toward `before` where
 * coverage is partial. Mutates and returns `after`. */
export function limitToCoverage(before: RGBA8, after: RGBA8, cover: Mask8 | null): RGBA8 {
  if (!cover) return after;
  const a = after.data,
    b = before.data;
  for (let i = 0; i < cover.data.length; i++) {
    const k = cover.data[i];
    if (k === 255) continue;
    const o = i * 4,
      t = k / 255;
    for (let c = 0; c < 4; c++) a[o + c] = b[o + c] + (a[o + c] - b[o + c]) * t;
  }
  return after;
}
/** Composite `top` over `base` with per-pixel weight (normal mode, straight
 * alpha), as painting would. Used when the source is the merged image and the
 * target layer may be empty. Returns a new image. */
export function paintOver(base: RGBA8, top: RGBA8, weight: Mask8): RGBA8 {
  const out = new Uint8ClampedArray(base.data);
  for (let i = 0; i < weight.data.length; i++) {
    const w = weight.data[i];
    if (!w) continue;
    const o = i * 4,
      k = (w / 255) * (top.data[o + 3] / 255),
      ba = base.data[o + 3] / 255,
      oa = k + ba * (1 - k);
    if (oa <= 0) continue;
    for (let c = 0; c < 3; c++) out[o + c] = (top.data[o + c] * k + base.data[o + c] * ba * (1 - k)) / oa;
    out[o + 3] = oa * 255;
  }
  return { width: base.width, height: base.height, data: out };
}
/** Binary "touched" mask: 255 where coverage is nonzero. */
export function binarize(m: Mask8, threshold = 1): Mask8 {
  const o = mask8(m.width, m.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = m.data[i] >= threshold ? 255 : 0;
  return o;
}

/** Nearest-neighbor downscale by an integer step (preview resolution). */
export function downsampleMask(m: Mask8, step: number): Mask8 {
  if (step <= 1) return m;
  const w = Math.ceil(m.width / step),
    h = Math.ceil(m.height / step),
    o = mask8(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(m.height - 1, y * step + (step >> 1));
    for (let x = 0; x < w; x++) o.data[y * w + x] = m.data[sy * m.width + Math.min(m.width - 1, x * step + (step >> 1))];
  }
  return o;
}
/** SVG path data (document units) of the 50% contour, traced on a coarser grid
 * for large masks so previews stay cheap. `ox`/`oy` offset the result. */
export function outlinePath(m: Mask8, maxCells = 700_000, ox = 0, oy = 0): string {
  const step = Math.max(1, Math.ceil(Math.sqrt((m.width * m.height) / maxCells)));
  const small = downsampleMask(m, step);
  let d = '';
  for (const poly of maskToOutline(small)) {
    if (poly.length < 3) continue;
    d += poly.map(([x, y], i) => `${i ? 'L' : 'M'}${+((x + 0.5) * step + ox).toFixed(2)} ${+((y + 0.5) * step + oy).toFixed(2)}`).join('') + 'Z';
  }
  return d;
}
/** Bilinear resize of a mask (proxy previews to full resolution and back). */
export function resizeMask(m: Mask8, w: number, h: number): Mask8 {
  if (m.width === w && m.height === h) return { width: w, height: h, data: new Uint8Array(m.data) };
  const o = mask8(w, h),
    sx = m.width / w,
    sy = m.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(m.height - 1, Math.max(0, (y + 0.5) * sy - 0.5)),
      y0 = Math.floor(fy),
      y1 = Math.min(m.height - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(m.width - 1, Math.max(0, (x + 0.5) * sx - 0.5)),
        x0 = Math.floor(fx),
        x1 = Math.min(m.width - 1, x0 + 1),
        tx = fx - x0;
      const a = m.data[y0 * m.width + x0] + (m.data[y0 * m.width + x1] - m.data[y0 * m.width + x0]) * tx;
      const b = m.data[y1 * m.width + x0] + (m.data[y1 * m.width + x1] - m.data[y1 * m.width + x0]) * tx;
      o.data[y * w + x] = Math.round(a + (b - a) * ty);
    }
  }
  return o;
}
/** Area-averaging downscale of RGBA (alpha-weighted) for proxies. */
export function downscaleImage(img: RGBA8, w: number, h: number): RGBA8 {
  if (img.width === w && img.height === h) return img;
  const out = new Uint8ClampedArray(w * h * 4),
    sx = img.width / w,
    sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * sy),
      yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * sx),
        xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let v = ya; v < yb; v++)
        for (let u = xa; u < xb; u++) {
          const o = (v * img.width + u) * 4,
            al = img.data[o + 3];
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          n++;
        }
      const o = (y * w + x) * 4;
      if (a) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}
/** Size that fits within `max` on the longer side (never upscales). */
export function fitSize(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** Magnetic Lasso: distance along the live path after which an anchor is
 * fixed automatically, for a frequency of 0-100 (higher = more anchors). */
export function anchorSpacing(frequency: number) {
  const f = Math.max(0, Math.min(100, frequency));
  return 8 + (100 - f) * 1.2;
}
export function pathLength(points: Pt[]) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return s;
}
/** Luminance gradient magnitude in [0, 1] at a pixel (central differences). */
export function edgeStrength(img: RGBA8, x: number, y: number) {
  const { width: w, height: h, data: d } = img;
  const X = Math.min(w - 2, Math.max(1, Math.round(x))),
    Y = Math.min(h - 2, Math.max(1, Math.round(y)));
  const lum = (i: number) => (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * (d[i * 4 + 3] / 255);
  if (w < 3 || h < 3) return 0;
  const i = Y * w + X;
  return Math.min(1, Math.hypot(lum(i + 1) - lum(i - 1), lum(i + w) - lum(i - w)) / 255);
}

// ----- Matting (Layer > Matting) -----
/** Undo a matte: colors that were blended against black or white at partial
 * alpha are recovered from C = aF + (1 - a)B. */
export function removeMatte(img: RGBA8, matte: 'black' | 'white'): RGBA8 {
  const out = new Uint8ClampedArray(img.data),
    B = matte === 'white' ? 255 : 0;
  for (let o = 0; o < out.length; o += 4) {
    const a = out[o + 3] / 255;
    if (a <= 0 || a >= 1) continue;
    for (let c = 0; c < 3; c++) out[o + c] = (img.data[o + c] - B * (1 - a)) / a;
  }
  return { width: img.width, height: img.height, data: out };
}
/** Defringe: replace the colors of partially transparent edge pixels within
 * `width` px of the edge with the colors of the nearest more opaque pixels,
 * removing halos picked up from an old background. Alpha is kept. */
export function defringe(img: RGBA8, width: number): RGBA8 {
  const { width: w, height: h } = img,
    n = w * h,
    out = new Uint8ClampedArray(img.data);
  const r = Math.max(1, Math.round(width));
  // Color sources: nearly opaque pixels. Propagate their colors outward ring by
  // ring (r passes of a 3x3 dilation), so each edge pixel gets the color of a
  // close interior pixel.
  let known = new Uint8Array(n);
  for (let i = 0; i < n; i++) known[i] = img.data[i * 4 + 3] >= 250 ? 1 : 0;
  const color = new Uint8ClampedArray(img.data);
  for (let pass = 0; pass < r; pass++) {
    const next = new Uint8Array(known);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i] || !img.data[i * 4 + 3]) continue;
        let R = 0, G = 0, Bc = 0, cnt = 0;
        for (let v = Math.max(0, y - 1); v <= Math.min(h - 1, y + 1); v++)
          for (let u = Math.max(0, x - 1); u <= Math.min(w - 1, x + 1); u++) {
            const j = v * w + u;
            if (!known[j]) continue;
            R += color[j * 4];
            G += color[j * 4 + 1];
            Bc += color[j * 4 + 2];
            cnt++;
          }
        if (!cnt) continue;
        color[i * 4] = R / cnt;
        color[i * 4 + 1] = G / cnt;
        color[i * 4 + 2] = Bc / cnt;
        next[i] = 1;
      }
    known = next;
  }
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3];
    if (a > 0 && a < 250 && known[i]) {
      out[i * 4] = color[i * 4];
      out[i * 4 + 1] = color[i * 4 + 1];
      out[i * 4 + 2] = color[i * 4 + 2];
    }
  }
  return { width: w, height: h, data: out };
}
/** Color Decontaminate on a cut-out layer: its own alpha is the matte. */
export function decontaminateLayer(img: RGBA8, amount: number): RGBA8 {
  const m = mask8(img.width, img.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = img.data[i * 4 + 3];
  // Background pixels are transparent here, so edge colors are pulled toward
  // the propagated colors of nearby opaque foreground pixels.
  const out = decontaminate(img, m, Math.max(0, Math.min(1, amount)));
  for (let i = 0; i < m.data.length; i++) out.data[i * 4 + 3] = img.data[i * 4 + 3];
  return out;
}

// ----- Select and Mask -----
export type RefineSettings = {
  radius: number;
  adaptiveRadius: boolean;
  smooth: number;
  feather: number;
  contrast: number;
  shiftEdge: number;
  // 0-1; 0 leaves colors alone.
  decontaminate: number;
};
/** Refine Edge with the workspace's extras: Adaptive Radius narrows the band
 * where the image edge is sharp (keeping hard outlines crisp) and leaves it wide
 * where the edge is soft; pixels painted with the Refine Edge Brush (`brushed`)
 * are re-estimated with a band of at least `brushRadius`, so wispy areas far
 * from the selection edge are matted too. */
export function refineComposite(img: RGBA8, mask: Mask8, s: RefineSettings, brushed?: Mask8 | null, brushRadius = 0): { mask: Mask8; image?: RGBA8 } {
  const common = { smooth: s.smooth, feather: s.feather, contrast: s.contrast, shiftEdge: s.shiftEdge };
  const out = refineEdge(img, mask, { ...common, radius: s.radius }).mask;
  const n = out.data.length;
  if (s.adaptiveRadius && s.radius >= 3) {
    const tight = refineEdge(img, mask, { ...common, radius: Math.max(1, Math.round(s.radius / 3)) }).mask;
    const { width: w, height: h } = img;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (out.data[i] === tight.data[i]) continue;
        const g = edgeStrength(img, x, y);
        // Strong local contrast = a hard edge: trust the narrow band there.
        const t = Math.min(1, Math.max(0, (g - 0.06) / 0.18));
        out.data[i] = Math.round(out.data[i] + (tight.data[i] - out.data[i]) * t);
      }
  }
  if (brushed) {
    let any = false;
    for (let i = 0; i < n && !any; i++) if (brushed.data[i]) any = true;
    if (any) {
      const wide = refineEdge(img, mask, { ...common, radius: Math.max(s.radius, brushRadius) }).mask;
      for (let i = 0; i < n; i++) {
        const k = brushed.data[i];
        if (k) out.data[i] = Math.round(out.data[i] + ((wide.data[i] - out.data[i]) * k) / 255);
      }
    }
  }
  return { mask: out, image: s.decontaminate > 0 ? decontaminate(img, out, Math.min(1, s.decontaminate)) : undefined };
}

// ----- Color Range -----
export type ColorRangeSettings = {
  range: ColorRangePreset;
  add: Pt[];
  addColors: [number, number, number][];
  subtractColors: [number, number, number][];
  subtract: Pt[];
  fuzziness: number;
  // Localized Color Clusters: limit each sample's reach to `rangePct` percent of the longer side.
  localized: boolean;
  rangePct: number;
  invert: boolean;
};
/** Color Range with several positive samples, negative samples that carve
 * colors back out, and per-sample localized clusters. */
export function colorRangeMulti(img: RGBA8, s: ColorRangeSettings): Mask8 {
  const { width: w, height: h } = img;
  const radius = (Math.max(w, h) * Math.max(1, s.rangePct)) / 100;
  const pick = (colors: [number, number, number][], pts: Pt[]): Mask8 => {
    if (!s.localized || !colors.length) return colorRange(img, colors, s.fuzziness);
    const acc = mask8(w, h);
    colors.forEach((c, i) => {
      const p = pts[i] ?? [w / 2, h / 2];
      const m = colorRange(img, [c], s.fuzziness, { localized: { x: p[0], y: p[1], radius } });
      for (let j = 0; j < acc.data.length; j++) if (m.data[j] > acc.data[j]) acc.data[j] = m.data[j];
    });
    return acc;
  };
  let m: Mask8;
  if (s.range !== 'sampled') m = colorRange(img, [], s.fuzziness, { range: s.range });
  else {
    m = pick(s.addColors, s.add);
    if (s.subtractColors.length) {
      const neg = pick(s.subtractColors, s.subtract);
      for (let i = 0; i < m.data.length; i++) m.data[i] = Math.round((m.data[i] * (255 - neg.data[i])) / 255);
    }
  }
  if (s.invert) for (let i = 0; i < m.data.length; i++) m.data[i] = (img.data[i * 4 + 3] ? 255 : 0) - m.data[i];
  return m;
}

/** Composite `patch` (with coverage `mask`, same size) onto a copy of `base`
 * at (ox, oy), normal mode with straight alpha. */
export function placeOver(base: RGBA8, patch: RGBA8, mask: Mask8, ox: number, oy: number): RGBA8 {
  const out = new Uint8ClampedArray(base.data),
    W = base.width,
    H = base.height;
  ox = Math.round(ox);
  oy = Math.round(oy);
  for (let v = 0; v < patch.height; v++) {
    const Y = v + oy;
    if (Y < 0 || Y >= H) continue;
    for (let u = 0; u < patch.width; u++) {
      const X = u + ox,
        m = mask.data[v * patch.width + u];
      if (X < 0 || X >= W || !m) continue;
      const s = (v * patch.width + u) * 4,
        o = (Y * W + X) * 4;
      const k = (m / 255) * (patch.data[s + 3] / 255),
        ba = out[o + 3] / 255,
        oa = k + ba * (1 - k);
      if (oa <= 0) continue;
      for (let c = 0; c < 3; c++) out[o + c] = (patch.data[s + c] * k + out[o + c] * ba * (1 - k)) / oa;
      out[o + 3] = oa * 255;
    }
  }
  return { width: W, height: H, data: out };
}
/** Linear mix of two equally sized images (t = 0 gives `a`). */
export function mixImages(a: RGBA8, b: RGBA8, t: number): RGBA8 {
  const out = new Uint8ClampedArray(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] + (b.data[i] - a.data[i]) * t;
  return { width: a.width, height: a.height, data: out };
}
/** Patch size for the Structure setting (1-7) of Patch and Context Move. */
export function patchSizeFor(structure: number) {
  return [5, 5, 7, 7, 9, 11, 13][Math.max(1, Math.min(7, Math.round(structure))) - 1];
}
/** Context Fill color adaptation for the Color setting (0-10). */
export function colorAdaptationFor(color: number): 'none' | 'default' | 'high' {
  return color <= 0 ? 'none' : color <= 6 ? 'default' : 'high';
}
export function unionRects(a: IRect, b: IRect): IRect {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Replace fully covered hole pixels with a smooth membrane fill from the
 * surroundings, in place. Context Fill's high color adaptation compares patch
 * means that include the hole's current pixels, so the object being removed
 * would otherwise tint its own replacement. Soft-edge pixels keep their colors
 * because the final composite still blends them with the original. */
export function prefillHole(img: RGBA8, hole: Mask8): RGBA8 {
  const b = boundingBox(hole, 255);
  if (!b) return img;
  const R = { x: Math.max(0, b.x - 1), y: Math.max(0, b.y - 1), width: 0, height: 0 };
  R.width = Math.min(img.width, b.x + b.width + 1) - R.x;
  R.height = Math.min(img.height, b.y + b.height + 1) - R.y;
  const n = R.width * R.height,
    type = new Uint8Array(n),
    val = new Float32Array(n * 4);
  let known = 0;
  for (let y = 0; y < R.height; y++)
    for (let x = 0; x < R.width; x++) {
      const j = y * R.width + x,
        i = (y + R.y) * img.width + x + R.x;
      if (hole.data[i] === 255) type[j] = UNKNOWN;
      else {
        type[j] = KNOWN;
        known++;
        const a = img.data[i * 4 + 3];
        for (let c = 0; c < 3; c++) val[j * 4 + c] = (img.data[i * 4 + c] * a) / 255;
        val[j * 4 + 3] = a;
      }
    }
  if (!known) return img;
  solveMembrane(val, type, R.width, R.height, 4);
  for (let y = 0; y < R.height; y++)
    for (let x = 0; x < R.width; x++) {
      const j = y * R.width + x;
      if (type[j] !== UNKNOWN) continue;
      const o = ((y + R.y) * img.width + x + R.x) * 4,
        a = val[j * 4 + 3];
      for (let c = 0; c < 3; c++) img.data[o + c] = a > 0 ? (val[j * 4 + c] * 255) / a : 0;
      img.data[o + 3] = a;
    }
  return img;
}

// ----- Healing modes -----
export type HealMode = 'normal' | 'replace' | 'multiply' | 'screen' | 'darken' | 'lighten' | 'color' | 'luminosity';
export const HEAL_MODES: [HealMode, string][] = [
  ['normal', 'Normal'],
  ['replace', 'Replace'],
  ['multiply', 'Multiply'],
  ['screen', 'Screen'],
  ['darken', 'Darken'],
  ['lighten', 'Lighten'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];
export const isHealMode = (v: unknown): v is HealMode => HEAL_MODES.some(([m]) => m === v);
/** Apply a healing tool's Mode to its result. Normal keeps the healed pixels;
 * Replace copies the source with the stroke's soft edge (keeping its grain
 * and texture); the blend modes combine the healed pixels with what was there,
 * inside the stroke only. */
export function applyHealMode(mode: HealMode, backdrop: RGBA8, healed: RGBA8, mask: Mask8, source?: RGBA8): RGBA8 {
  if (mode === 'normal' || (mode === 'replace' && !source)) return healed;
  const out: RGBA8 = { width: healed.width, height: healed.height, data: new Uint8ClampedArray(healed.data) };
  const b = backdrop.data,
    h = healed.data,
    o = out.data;
  const bc = [0, 0, 0],
    sc = [0, 0, 0],
    rc = [0, 0, 0];
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    const k = mask.data[i] / 255;
    if (!k) {
      for (let c = 0; c < 4; c++) o[p + c] = b[p + c];
      continue;
    }
    if (mode === 'replace') {
      const s = source!.data;
      for (let c = 0; c < 4; c++) o[p + c] = b[p + c] + (s[p + c] - b[p + c]) * k;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      bc[c] = b[p + c] / 255;
      sc[c] = h[p + c] / 255;
    }
    blendColor(mode, bc, sc, rc);
    for (let c = 0; c < 3; c++) o[p + c] = b[p + c] + (rc[c] * 255 - b[p + c]) * k;
    o[p + 3] = b[p + 3] + (h[p + 3] - b[p + 3]) * k;
  }
  return out;
}
