// Floating selections: Free Transform and Transform Again with an active
// selection lift the selected pixels of a pixel layer, transform them and put
// them back over what remains of the layer. Pure functions on tiles, shared by
// transform sessions and Transform Again.
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import type { Layer, PhotoDocument } from '../../model/document';
import { gridDocBounds, intersectRect, readMask, readRGBA, writeRect, type TileGrid, type TileStore } from '../../model/tiles';
import { selectionBounds, selectionGrid } from '../../model/selection';

export type FloatingPixels = {
  // Tight bounds of the lifted pixels (document space).
  rect: IRect;
  // The lifted pixels, weighted by the selection, covering `rect`.
  image: RGBA8;
  // Selection coverage over `rect`, transformed into the new selection.
  selection: Mask8;
  // The layer with the lifted pixels removed (or, with locked
  // transparency, replaced by the background color).
  remaining: TileGrid;
  preserveAlpha: boolean;
};

/** Lift the selected pixels of a pixel layer. Undefined without a selection
 * or when the whole layer can be transformed instead (see coversContent);
 * null when the selection covers none of the layer's pixels. */
export function liftSelection(doc: PhotoDocument, store: TileStore, layer: Layer, opts: { preserveAlpha: boolean; background: [number, number, number] }): FloatingPixels | null | undefined {
  const sel = selectionGrid(doc, store);
  const sb = selectionBounds(doc, sel);
  if (!sel || !sb) return undefined;
  const lb = layer.pixels ? gridDocBounds(layer.pixels) : null;
  const r = lb && intersectRect(sb, lb);
  if (!r) return null;
  if (!opts.preserveAlpha && coversContent(doc, store, sel, lb!)) return undefined;
  const src = readRGBA(store, layer.pixels!, r),
    m = readMask(store, sel, r);
  const n = r.width * r.height;
  const lifted = new Uint8ClampedArray(n * 4),
    rest = new Uint8ClampedArray(src.data);
  const [br, bg, bb] = opts.background;
  let x0 = r.width,
    y0 = r.height,
    x1 = -1,
    y1 = -1;
  for (let i = 0; i < n; i++) {
    const s = m.data[i];
    if (!s) continue;
    const o = i * 4,
      a = src.data[o + 3];
    if (!a) continue;
    const fa = Math.round((a * s) / 255);
    if (!fa) continue;
    lifted[o] = src.data[o];
    lifted[o + 1] = src.data[o + 1];
    lifted[o + 2] = src.data[o + 2];
    lifted[o + 3] = fa;
    if (opts.preserveAlpha) {
      // The hole shows the background color; transparency stays as it was.
      const t = s / 255;
      rest[o] = src.data[o] + (br - src.data[o]) * t;
      rest[o + 1] = src.data[o + 1] + (bg - src.data[o + 1]) * t;
      rest[o + 2] = src.data[o + 2] + (bb - src.data[o + 2]) * t;
    } else rest[o + 3] = a - fa;
    const x = i % r.width,
      y = (i - x) / r.width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const rect = { x: r.x + x0, y: r.y + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const image = crop({ width: r.width, height: r.height, data: lifted }, x0, y0, rect.width, rect.height, 4) as RGBA8;
  const selection = crop(m, x0, y0, rect.width, rect.height, 1) as Mask8;
  const remaining = writeRect(store, layer.pixels!, r.x, r.y, { width: r.width, height: r.height, data: rest });
  return { rect, image, selection, remaining, preserveAlpha: opts.preserveAlpha };
}

/** A hard-edged selection holding all of the layer's content (Select All,
 * or any selection around it) lifts everything and leaves nothing behind:
 * transforming the whole layer gives the same pixels without the copies. */
function coversContent(doc: Pick<PhotoDocument, 'width' | 'height'>, store: TileStore, sel: TileGrid, lb: IRect) {
  // Selections end at the canvas edge; content beyond it is not selected.
  if (lb.x < 0 || lb.y < 0 || lb.x + lb.width > doc.width || lb.y + lb.height > doc.height) return false;
  if (sel.fill === 255 && !Object.keys(sel.tiles).length) return true;
  const m = readMask(store, sel, lb).data;
  for (let i = 0; i < m.length; i++) if (m[i] !== 255) return false;
  return true;
}

function crop(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, x: number, y: number, w: number, h: number, c: 1 | 4) {
  const data = c === 4 ? new Uint8ClampedArray(w * h * 4) : new Uint8Array(w * h);
  for (let j = 0; j < h; j++) data.set(img.data.subarray(((y + j) * img.width + x) * c, ((y + j) * img.width + x + w) * c), j * w * c);
  return { width: w, height: h, data };
}

/** Put transformed floating pixels (placed at `x`, `y`) back over the rest of
 * the layer. With locked transparency they paint inside the existing alpha. */
export function dropFloat(store: TileStore, f: Pick<FloatingPixels, 'remaining' | 'preserveAlpha'>, image: RGBA8 | undefined, x: number, y: number): TileGrid {
  if (!image || !image.width || !image.height) return f.remaining;
  const rect = { x, y, width: image.width, height: image.height };
  const under = readRGBA(store, f.remaining, rect);
  const d = under.data,
    s = image.data;
  for (let o = 0; o < d.length; o += 4) {
    const sa = s[o + 3];
    if (!sa) continue;
    const da = d[o + 3];
    if (f.preserveAlpha) {
      // Source-atop: the layer's alpha is kept.
      const t = sa / 255;
      d[o] = d[o] + (s[o] - d[o]) * t;
      d[o + 1] = d[o + 1] + (s[o + 1] - d[o + 1]) * t;
      d[o + 2] = d[o + 2] + (s[o + 2] - d[o + 2]) * t;
      continue;
    }
    if (sa === 255 || !da) {
      d[o] = s[o];
      d[o + 1] = s[o + 1];
      d[o + 2] = s[o + 2];
      d[o + 3] = sa;
      continue;
    }
    // Source-over in straight alpha.
    const fa = sa / 255,
      ba = (da / 255) * (1 - fa),
      oa = fa + ba;
    d[o] = (s[o] * fa + d[o] * ba) / oa;
    d[o + 1] = (s[o + 1] * fa + d[o + 1] * ba) / oa;
    d[o + 2] = (s[o + 2] * fa + d[o + 2] * ba) / oa;
    d[o + 3] = oa * 255;
  }
  return writeRect(store, f.remaining, x, y, under);
}
