// Generative layout edits (AI Recompose, Remove Reflections, Rotate Object):
// prompts, object transforms, seam masks, blending and placement. No DOM, so
// it runs in the assist worker and in unit tests.
import { boundingBox, contract, expand } from '../../imaging/segment/mask-ops';
import { mask8, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';

// ---------------------------------------------------------------------------
// Which documents these commands work on.

/** Why a document cannot be edited generatively, or null when it can. The
 * models take 8-bit RGB pictures; 16-bit documents are edited through their
 * 8-bit working pixels like the other AI commands, 32-bit and non-RGB modes
 * are refused with the conversion that makes them work. */
export function genaiUnsupported(
  doc: { mode?: string; bitsPerChannel?: number },
  what: string,
): string | null {
  if (doc.mode && doc.mode !== 'rgb')
    return `${what} works on RGB images. Convert this one with Image › Mode › RGB Color first.`;
  if ((doc.bitsPerChannel ?? 8) === 32)
    return `${what} works on 8- and 16-bit images. Convert this one with Image › Mode › 16 Bits/Channel first.`;
  return null;
}

// ---------------------------------------------------------------------------
// Prompts (original wording). Each is a complete instruction; the variation
// requests share it.

const clean = (s: string | undefined) =>
  (s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');

/** The fill instruction for AI Recompose's blending pass. It is sent with a
 * mask (white = may change) through `aiFill`, which adds the framing about
 * the mask and keeping the rest unchanged. */
export function recomposePrompt(o: { removed: boolean; extra?: string }): string {
  const what = o.removed
    ? 'the background continued seamlessly where an object was taken out, with no trace, outline, shadow or duplicate of it left behind'
    : 'the background continued seamlessly where the object used to be, with no trace or duplicate of it left at its old place, and a natural contact shadow and lighting around the object at its new place so it sits in the scene';
  const extra = clean(o.extra);
  return extra ? `${what}. Also: ${extra}` : what;
}

/** Instruction for Remove Reflections. `strength` 'strong' also asks to
 * remove glare and haze from the glass. */
export function reflectionPrompt(
  o: { strength?: 'standard' | 'strong'; extra?: string } = {},
): string {
  const extra = clean(o.extra);
  return (
    'Remove every reflection on the glass, window or shiny surface in this photo: the mirrored images of the room, the photographer, lights, sky and objects that lie on top of the scene. ' +
    'Show only what is actually behind or on the surface, as if the photo had been taken with a perfect polarizing filter. ' +
    (o.strength === 'strong'
      ? 'Also remove glare, bright hot spots and the hazy, washed-out veil they cause, restoring the true contrast and colors behind the glass. '
      : '') +
    'Do not change anything else: keep the framing, perspective, every object, text, colors, lighting and sharpness exactly as they are, and do not add anything new. ' +
    (extra ? `Also: ${extra}. ` : '') +
    'Return the full photo with the same framing and aspect ratio.'
  );
}

/** Words for a turn: positive yaw turns the object's front toward the
 * viewer's right; positive tilt shows more of its top (seen from higher). */
export function turnWords(yaw: number, tilt: number): string {
  const y = Math.round(normAngle(yaw)),
    t = Math.round(tilt);
  const parts: string[] = [];
  if (Math.abs(y) === 180) parts.push('turned around 180° so its back faces the viewer');
  else if (y)
    parts.push(
      `turned ${Math.abs(y)}° to the ${y > 0 ? 'right' : 'left'} around its vertical axis`,
    );
  if (t)
    parts.push(
      `seen ${Math.abs(t)}° from ${t > 0 ? 'above' : 'below'} (tilted to show more of its ${t > 0 ? 'top' : 'underside'})`,
    );
  return parts.length ? parts.join(' and ') : 'shown from the same angle';
}
/** Instruction for Rotate Object: the isolated object on a plain backdrop. */
export function rotatePrompt(yaw: number, tilt: number, extra?: string): string {
  const x = clean(extra);
  return (
    `This image shows one object on a plain background. Show the exact same object ${turnWords(yaw, tilt)}, as if it were rotated on a turntable in front of the camera. ` +
    'Keep its identity, shape, proportions, materials, colors, printed text, logos and lighting direction exactly the same, and reveal the sides that become visible in a way consistent with the visible ones. ' +
    'Show the whole object, centered, at about the same size, on a plain uniform light gray background with no shadow, no floor and no other objects. ' +
    (x ? `Also: ${x}. ` : '') +
    'Return one image with the same aspect ratio.'
  );
}
/** Short label for a layer name ("Rotated 45° right, 15° from above"). */
export function turnLabel(yaw: number, tilt: number): string {
  const y = Math.round(normAngle(yaw)),
    t = Math.round(tilt);
  const parts: string[] = [];
  if (Math.abs(y) === 180) parts.push('180°');
  else if (y) parts.push(`${Math.abs(y)}° ${y > 0 ? 'right' : 'left'}`);
  if (t) parts.push(`${Math.abs(t)}° from ${t > 0 ? 'above' : 'below'}`);
  return parts.length ? `Rotated ${parts.join(', ')}` : 'Rotated';
}
/** An angle in -180..180. */
export function normAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = ((((a + 180) % 360) + 360) % 360) - 180;
  if (r === -180 && a > 0) r = 180;
  return r;
}

// ---------------------------------------------------------------------------
// Objects: cutting them out, transforming them, finding them.

export type CutObject = { rect: IRect; img: RGBA8 };

/** The pixels of `img` covered by `mask` (both canvas-sized), cropped to the
 * mask's bounds, with the coverage multiplied into alpha. */
export function cutObject(img: RGBA8, mask: Mask8, threshold = 1): CutObject | null {
  const { width: W, height: H } = img;
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (mask.data[y * W + x] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      const si = (y + y0) * W + x + x0,
        o = (y * rect.width + x) * 4,
        m = mask.data[si];
      if (!m) continue;
      out[o] = img.data[si * 4];
      out[o + 1] = img.data[si * 4 + 1];
      out[o + 2] = img.data[si * 4 + 2];
      out[o + 3] = Math.round((img.data[si * 4 + 3] * m) / 255);
    }
  return { rect, img: { width: rect.width, height: rect.height, data: out } };
}

export type ObjectTransform = {
  dx: number;
  dy: number;
  scale: number;
  rotate: number;
  flipH: boolean;
  flipV: boolean;
};
export const IDENTITY: ObjectTransform = {
  dx: 0,
  dy: 0,
  scale: 1,
  rotate: 0,
  flipH: false,
  flipV: false,
};
export const isIdentity = (t: ObjectTransform) =>
  !t.dx && !t.dy && t.scale === 1 && !normAngle(t.rotate) && !t.flipH && !t.flipV;

/** Affine matrix [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f)
 * taking document points of the object to their new place: flip and scale
 * and rotate about the object's center, then move by (dx, dy). */
export function objectMatrix(rect: IRect, t: ObjectTransform): number[] {
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  const r = (normAngle(t.rotate) * Math.PI) / 180,
    cos = Math.cos(r),
    sin = Math.sin(r);
  const sx = t.scale * (t.flipH ? -1 : 1),
    sy = t.scale * (t.flipV ? -1 : 1);
  const a = cos * sx,
    b = sin * sx,
    c = -sin * sy,
    d = cos * sy;
  return [a, b, c, d, cx + t.dx - a * cx - c * cy, cy + t.dy - b * cx - d * cy];
}
const applyM = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
function invertM(m: number[]): number[] {
  const [a, b, c, d, e, f] = m,
    det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
/** Bounds (whole pixels) of the transformed object, before clipping. */
export function transformedBounds(rect: IRect, t: ObjectTransform): IRect {
  const m = objectMatrix(rect, t);
  const pts = [
    applyM(m, rect.x, rect.y),
    applyM(m, rect.x + rect.width, rect.y),
    applyM(m, rect.x, rect.y + rect.height),
    applyM(m, rect.x + rect.width, rect.y + rect.height),
  ];
  // Snap rounding noise (cos 90° is not exactly 0) before taking whole pixels.
  const snap = (v: number) => Math.round(v * 1e6) / 1e6;
  const x0 = Math.floor(snap(Math.min(...pts.map((p) => p[0])))),
    y0 = Math.floor(snap(Math.min(...pts.map((p) => p[1])))),
    x1 = Math.ceil(snap(Math.max(...pts.map((p) => p[0])))),
    y1 = Math.ceil(snap(Math.max(...pts.map((p) => p[1]))));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** The object drawn at its new place, clipped to a W x H canvas (bilinear,
 * premultiplied). Null when it lands entirely outside. */
export function renderTransformed(
  obj: CutObject,
  t: ObjectTransform,
  W: number,
  H: number,
): CutObject | null {
  const b = transformedBounds(obj.rect, t);
  const x0 = Math.max(0, b.x),
    y0 = Math.max(0, b.y),
    x1 = Math.min(W, b.x + b.width),
    y1 = Math.min(H, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const inv = invertM(objectMatrix(obj.rect, t));
  const src = obj.img,
    sw = src.width,
    sh = src.height,
    s = src.data;
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      // Pixel centers map back into the object's crop.
      const [px, py] = applyM(inv, x + x0 + 0.5, y + y0 + 0.5);
      const fx = px - obj.rect.x - 0.5,
        fy = py - obj.rect.y - 0.5;
      if (fx <= -1 || fy <= -1 || fx >= sw || fy >= sh) continue;
      const ix = Math.floor(fx),
        iy = Math.floor(fy),
        tx = fx - ix,
        ty = fy - iy;
      let r = 0,
        g = 0,
        bl = 0,
        a = 0;
      for (let k = 0; k < 4; k++) {
        const qx = ix + (k & 1),
          qy = iy + (k >> 1);
        if (qx < 0 || qy < 0 || qx >= sw || qy >= sh) continue;
        const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty);
        const i = (qy * sw + qx) * 4,
          al = s[i + 3] * w;
        r += s[i] * al;
        g += s[i + 1] * al;
        bl += s[i + 2] * al;
        a += al;
      }
      if (a <= 0) continue;
      const o = (y * rect.width + x) * 4;
      out[o] = r / a;
      out[o + 1] = g / a;
      out[o + 2] = bl / a;
      out[o + 3] = a;
    }
  return { rect, img: { width: rect.width, height: rect.height, data: out } };
}

/** Canvas-sized coverage of a placed object (its alpha). */
export function footprint(obj: CutObject | null, W: number, H: number): Mask8 {
  const m = mask8(W, H);
  if (!obj) return m;
  const { rect, img } = obj;
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      const dx = x + rect.x,
        dy = y + rect.y;
      if (dx >= 0 && dy >= 0 && dx < W && dy < H)
        m.data[dy * W + dx] = img.data[(y * rect.width + x) * 4 + 3];
    }
  return m;
}

/** The area to fill once the object leaves: its coverage, slightly grown so
 * no fringe of it stays behind. */
export function vacatedMask(mask: Mask8, grow: number): Mask8 {
  const W = mask.width,
    H = mask.height;
  const out = mask8(W, H);
  const b = boundingBox(mask, 16);
  if (!b) return out;
  // Morphology only around the object, so large canvases stay quick.
  const R = padRect(b, grow + 2, W, H);
  const bin = mask8(R.width, R.height);
  for (let y = 0; y < R.height; y++)
    for (let x = 0; x < R.width; x++)
      bin.data[y * R.width + x] = mask.data[(y + R.y) * W + x + R.x] >= 16 ? 255 : 0;
  const grown = grow > 0 ? expand(bin, grow) : bin;
  for (let y = 0; y < R.height; y++)
    out.data.set(grown.data.subarray(y * R.width, (y + 1) * R.width), (y + R.y) * W + R.x);
  return out;
}
/** `r` grown by `m` on every side, clipped to W x H. */
export function padRect(r: IRect, m: number, W: number, H: number): IRect {
  const x = Math.max(0, r.x - m),
    y = Math.max(0, r.y - m);
  return {
    x,
    y,
    width: Math.min(W, r.x + r.width + m) - x,
    height: Math.min(H, r.y + r.height + m) - y,
  };
}
/** Grow amount for the vacated area: about 1% of the object, 2..12 px. */
export function vacatedGrow(rect: IRect): number {
  return Math.max(2, Math.min(12, Math.round(Math.max(rect.width, rect.height) * 0.01)));
}

/** Where the blending pass may change pixels: the filled hole and a ring
 * around the object's new outline (shadows, edges), but not the object
 * itself, which stays on its own layer above. */
export function seamMask(vacated: Mask8, placed: Mask8, ring: number): Mask8 {
  const W = vacated.width,
    H = vacated.height;
  const out = mask8(W, H);
  const vb = boundingBox(vacated),
    pb = boundingBox(placed, 128);
  if (vb)
    for (let y = vb.y; y < vb.y + vb.height; y++)
      for (let x = vb.x; x < vb.x + vb.width; x++)
        if (vacated.data[y * W + x]) out.data[y * W + x] = 255;
  if (!pb) return out;
  // The ring and the object's inside, worked out around the object only.
  const R = padRect(pb, ring + 2, W, H);
  const bin = mask8(R.width, R.height);
  for (let y = 0; y < R.height; y++)
    for (let x = 0; x < R.width; x++)
      bin.data[y * R.width + x] = placed.data[(y + R.y) * W + x + R.x] >= 128 ? 255 : 0;
  const around = expand(bin, ring),
    inside = contract(bin, Math.max(1, Math.round(ring / 4)));
  for (let y = 0; y < R.height; y++)
    for (let x = 0; x < R.width; x++) {
      const i = y * R.width + x,
        o = (y + R.y) * W + x + R.x;
      if (inside.data[i]) out.data[o] = 0;
      else if (around.data[i]) out.data[o] = 255;
    }
  return out;
}

/** Index of the object under (x, y): the smallest whose coverage there is at
 * least half, or -1. Objects carry soft masks inside their bounds. */
export function objectAt(objects: { rect: IRect; mask: Mask8 }[], x: number, y: number): number {
  let best = -1,
    area = Infinity;
  objects.forEach((o, k) => {
    const lx = Math.floor(x) - o.rect.x,
      ly = Math.floor(y) - o.rect.y;
    if (lx < 0 || ly < 0 || lx >= o.rect.width || ly >= o.rect.height) return;
    if (o.mask.data[ly * o.mask.width + lx] < 128) return;
    const a = o.rect.width * o.rect.height;
    if (a < area) {
      area = a;
      best = k;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Blending.

/** base · (1 − t) + top · t per channel (alpha too); `t` in 0..1. */
export function blendAmount(base: RGBA8, top: RGBA8, t: number): RGBA8 {
  const k = Math.max(0, Math.min(1, t));
  const out = new Uint8ClampedArray(base.data.length);
  for (let i = 0; i < out.length; i++) out[i] = base.data[i] + (top.data[i] - base.data[i]) * k;
  return { width: base.width, height: base.height, data: out };
}
/** Restore fine detail a model lost to downscaling: the generated image
 * (enlarged to full size) plus the original's high frequencies (original
 * minus its own reduced-and-enlarged copy), scaled by `k`. */
export function detailTransfer(gen: RGBA8, orig: RGBA8, origLow: RGBA8, k = 1): RGBA8 {
  const out = new Uint8ClampedArray(gen.data.length);
  for (let i = 0; i < out.length; i++)
    out[i] = (i & 3) === 3 ? gen.data[i] : gen.data[i] + (orig.data[i] - origLow.data[i]) * k;
  return { width: gen.width, height: gen.height, data: out };
}
/** Keep the source's transparency: alpha = min(result, source). */
export function keepAlpha(img: RGBA8, src: RGBA8): RGBA8 {
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = Math.min(img.data[i], src.data[i]);
  return img;
}
/** A placed object composited over a copy of `base` (source-over). */
export function overObject(base: RGBA8, obj: CutObject): RGBA8 {
  const out = new Uint8ClampedArray(base.data),
    W = base.width;
  const { rect, img } = obj;
  for (let y = 0; y < rect.height; y++)
    for (let x = 0; x < rect.width; x++) {
      const s = (y * rect.width + x) * 4,
        d = ((y + rect.y) * W + x + rect.x) * 4,
        a = img.data[s + 3] / 255;
      if (!a) continue;
      const da = out[d + 3] / 255,
        oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++)
        out[d + c] = (img.data[s + c] * a + out[d + c] * da * (1 - a)) / oa;
      out[d + 3] = oa * 255;
    }
  return { width: base.width, height: base.height, data: out };
}
/** Composite `patch` into `dst` (same size) where `mask` covers, softly. */
export function compositeMasked(dst: RGBA8, patch: RGBA8, mask: Mask8): RGBA8 {
  const out = new Uint8ClampedArray(dst.data);
  for (let i = 0; i < mask.data.length; i++) {
    const k = mask.data[i] / 255;
    if (!k) continue;
    for (let c = 0; c < 4; c++)
      out[i * 4 + c] = dst.data[i * 4 + c] + (patch.data[i * 4 + c] - dst.data[i * 4 + c]) * k;
  }
  return { width: dst.width, height: dst.height, data: out };
}

// ---------------------------------------------------------------------------
// Rotate Object: isolating and placing.

/** The object on a plain light gray backdrop with a margin, as sent to the
 * model (so its background removal has a clean edge to find). */
export function onBackdrop(obj: CutObject, margin = 0.12, gray = 230): RGBA8 {
  const m = Math.round(Math.max(obj.rect.width, obj.rect.height) * margin);
  const w = obj.rect.width + 2 * m,
    h = obj.rect.height + 2 * m;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = gray;
    out[i + 3] = 255;
  }
  const s = obj.img.data;
  for (let y = 0; y < obj.rect.height; y++)
    for (let x = 0; x < obj.rect.width; x++) {
      const i = (y * obj.rect.width + x) * 4,
        o = ((y + m) * w + x + m) * 4,
        a = s[i + 3] / 255;
      for (let c = 0; c < 3; c++) out[o + c] = s[i + c] * a + gray * (1 - a);
    }
  return { width: w, height: h, data: out };
}

/** Where a turned object goes: the same height as the original (a turn
 * about the vertical axis keeps it), its width following the result's
 * proportions (at most twice the original's height-scaled width), standing
 * on the original's bottom edge and centered on its middle. With a strong
 * tilt the height changes too, so the area is matched instead. */
export function alignToOriginal(
  orig: IRect,
  res: { width: number; height: number },
  tilt = 0,
): IRect {
  let s = orig.height / res.height;
  if (Math.abs(tilt) > 30) s = Math.sqrt((orig.width * orig.height) / (res.width * res.height));
  // Never wider than twice the original (a side view of a long object).
  s = Math.min(s, (2 * Math.max(orig.width, orig.height)) / res.width);
  const width = Math.max(1, Math.round(res.width * s)),
    height = Math.max(1, Math.round(res.height * s));
  const cx = orig.x + orig.width / 2;
  return { x: Math.round(cx - width / 2), y: orig.y + orig.height - height, width, height };
}

/** Crop to the coverage of `mask` (same size as `img`), alpha multiplied. */
export function trimToMask(img: RGBA8, mask: Mask8, threshold = 8): CutObject | null {
  return cutObject(img, mask, threshold);
}
