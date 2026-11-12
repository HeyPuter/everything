// Shared helpers for the type tools: layout in a layer's local text space,
// hit testing, placement and rasterization of text coverage.

import type { Editor } from '../../editor';
import { allLayers, findLayer, insertLayerAt, localPoint, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import { layerLock } from '../../model/locks';
import { applyAffine, documentPpi, invertAffine, legacyTextData, placeTextRect, textMatrix, textScale, type Affine } from '../../model/text-layer';
import { layoutText, measurementGeneration, type TextLayout } from '../../imaging/text/layout';
import { canvasMeasure } from '../../imaging/text/render';
import { isIdentityWarp, warpPoint } from '../../imaging/text/warp';
import type { TextLayerData } from '../../imaging/text/model';
import { renderTextLayer } from '../../renderer/text-source';

export const ppiOf = (e: Editor | PhotoDocument) => documentPpi('doc' in e ? e.doc : e);

// Recent layouts by text data (which is never mutated): hovering with a type
// tool hit-tests every text layer on each move, so one entry is not enough.
// Bounded by count and by characters (typing makes a new entry per key).
const layouts = new Map<TextLayerData, { ppi: number; gen: number; layout: TextLayout }>();
const LAYOUT_CACHE = 64, LAYOUT_CHARS = 50_000;
let cachedChars = 0;
export function layoutOf(data: TextLayerData, ppi: number): TextLayout {
  const gen = measurementGeneration();
  const hit = layouts.get(data);
  if (hit && hit.ppi === ppi && hit.gen === gen) {
    // Most recently used last.
    layouts.delete(data);
    layouts.set(data, hit);
    return hit.layout;
  }
  const layout = layoutText(data, { measure: canvasMeasure(), resolution: ppi });
  if (hit) {
    layouts.delete(data);
    cachedChars -= hit.layout.length;
  }
  layouts.set(data, { ppi, gen, layout });
  cachedChars += layout.length;
  // The newest entry always stays.
  while (layouts.size > 1 && (layouts.size > LAYOUT_CACHE || cachedChars > LAYOUT_CHARS)) {
    const [k, v] = layouts.entries().next().value!;
    layouts.delete(k);
    cachedChars -= v.layout.length;
  }
  return layout;
}
// Font loads change measurements; forget the cached layouts.
export function forgetLayout() {
  layouts.clear();
  cachedChars = 0;
}

export const warpRect = (layout: TextLayout): Rect => layout.bounds;
// Straight layout coordinates -> local space (path text bends, warps distort).
export function warpLocal(data: TextLayerData, layout: TextLayout, x: number, y: number): [number, number] {
  if (layout.map) return layout.map(x, y);
  return isIdentityWarp(data.warp) ? [x, y] : warpPoint(data.warp, warpRect(layout), x, y);
}
// Inverse of the warp by fixed-point iteration; good for the moderate
// distortions text warps produce, which is all hit testing needs.
export function unwarpLocal(data: TextLayerData, layout: TextLayout, x: number, y: number): [number, number] {
  if (layout.unmap) return layout.unmap(x, y);
  if (isIdentityWarp(data.warp)) return [x, y];
  let px = x,
    py = y;
  for (let i = 0; i < 24; i++) {
    const [wx, wy] = warpPoint(data.warp, warpRect(layout), px, py);
    const dx = x - wx,
      dy = y - wy;
    px += dx * 0.8;
    py += dy * 0.8;
    if (dx * dx + dy * dy < 1e-4) break;
  }
  return [px, py];
}

// Polygon (local space) of a rectangle after the warp.
export function warpedRect(data: TextLayerData, layout: TextLayout, r: Rect, steps = 8): [number, number][] {
  const pts: [number, number][] = [];
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    for (let i = 0; i < steps; i++) pts.push(warpLocal(data, layout, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps));
  };
  const { x, y, width: w, height: h } = r;
  if (isIdentityWarp(data.warp) && !layout.map) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  // Along a path, long edges need more points to follow the curve.
  if (layout.map) steps = Math.max(steps, Math.ceil(w / 4));
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  return pts;
}

// Local rectangle the transform box should follow: the paragraph frame, or
// the line boxes of point text (warped when a warp is set).
export function localBounds(data: TextLayerData, layout: TextLayout): Rect {
  // Path text: the placed glyphs; area text: the shape.
  if (data.path?.kind === 'path') return layout.bounds.width > 0 ? layout.bounds : { ...layout.bounds, width: 1, height: Math.max(1, layout.bounds.height) };
  if (data.path?.kind === 'area' && layout.box) return layout.box;
  if (data.mode === 'paragraph' && data.box) return { x: data.origin.x, y: data.origin.y, ...data.box };
  let b = layout.bounds;
  if (!(b.width > 0) || !(b.height > 0)) {
    const c = layout.caretRect(0);
    b = data.orientation === 'vertical' ? { x: c.x, y: c.y, width: Math.max(1, c.width), height: 1 } : { x: c.x, y: c.y, width: 1, height: Math.max(1, c.height) };
  }
  if (isIdentityWarp(data.warp)) return b;
  const pts = warpedRect(data, layout, b, 12);
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// A text layer as the editor sees it: legacy layers get engine data in their
// own source space, so their placement is unchanged.
export function editable(l: Layer, ppi: number): Layer & { textData: TextLayerData } {
  if (l.textData) return l as Layer & { textData: TextLayerData };
  const { data, frame } = legacyTextData(l, ppi);
  return { ...l, textData: data, textFrame: frame };
}

export function layerMatrix(l: Layer): Affine {
  return textMatrix(l);
}
export function toLocal(l: Layer, x: number, y: number): [number, number] {
  return applyAffine(invertAffine(textMatrix(l)), x, y);
}
export function toDoc(l: Layer, x: number, y: number): [number, number] {
  return applyAffine(textMatrix(l), x, y);
}
// Document pixels per local unit (for screen-constant overlay sizes).
export function localScale(l: Layer): number {
  const [sx, sy] = textScale(l);
  return Math.max(1e-6, Math.sqrt(Math.abs(sx * sy)));
}

function visibleChain(doc: PhotoDocument, id: string): boolean {
  const walk = (layers: Layer[]): boolean | undefined => {
    for (const l of layers) {
      if (l.id === id) return l.visible;
      const r = walk(l.children);
      if (r !== undefined) return r && l.visible;
    }
  };
  return walk(doc.layers) ?? false;
}

// Top-most editable text layer under a document point.
export function textLayerAt(e: Editor, x: number, y: number): Layer | undefined {
  const ppi = ppiOf(e);
  const doc = e.doc;
  const layers = allLayers(doc.layers).filter((l) => l.kind === 'text');
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!visibleChain(doc, l.id) || layerLock(doc.layers, l.id, 'all', false)) continue;
    const t = editable(l, ppi);
    const layout = layoutOf(t.textData, ppi);
    const [lx, ly] = toLocal(t, x, y);
    const pad = 4 / (e.zoom * localScale(t));
    const b = localBounds(t.textData, layout);
    if (lx >= b.x - pad && lx <= b.x + b.width + pad && ly >= b.y - pad && ly <= b.y + b.height + pad) return l;
  }
  return undefined;
}

// Shallow copy of a document with one layer replaced (containers along the
// path are copied, everything else is shared, as history snapshots allow).
export function replaceLayer(doc: PhotoDocument, id: string, fn: (l: Layer) => Layer | null): PhotoDocument {
  const walk = (layers: Layer[]): Layer[] | undefined => {
    const i = layers.findIndex((l) => l.id === id);
    if (i >= 0) {
      const out = layers.slice();
      const next = fn(layers[i]);
      if (next) out[i] = next;
      else out.splice(i, 1);
      return out;
    }
    for (let k = 0; k < layers.length; k++) {
      const children = walk(layers[k].children);
      if (children) {
        const out = layers.slice();
        out[k] = { ...layers[k], children };
        return out;
      }
    }
  };
  const layers = walk(doc.layers);
  return layers ? { ...doc, layers } : doc;
}
// Inserts a layer above `anchor` (or on top) in a shallow copy.
export function insertLayer(doc: PhotoDocument, l: Layer, anchor?: string): PhotoDocument {
  if (anchor && findLayer(doc.layers, anchor)) {
    let done = false;
    const walk = (layers: Layer[]): Layer[] => {
      const i = layers.findIndex((x) => x.id === anchor);
      if (i >= 0) {
        done = true;
        const out = layers.slice();
        insertLayerAt(out, i + 1, l);
        return out;
      }
      return layers.map((x) => {
        if (done) return x;
        const children = walk(x.children);
        return children === x.children ? x : { ...x, children };
      });
    };
    const layers = walk(doc.layers);
    if (done) return { ...doc, layers };
  }
  return { ...doc, layers: [...doc.layers, l] };
}

// Document-sized coverage (0-255) of a text layer, for type masks.
export async function textCoverage(l: Layer & { textData: TextLayerData }, doc: PhotoDocument): Promise<{ width: number; height: number; data: Uint8Array }> {
  const W = doc.width,
    H = doc.height;
  const out = new Uint8Array(W * H);
  const [sx, sy] = textScale(l);
  const scale = Math.max(0.25, Math.min(4, Math.max(sx, sy)));
  const r = await renderTextLayer(l.textData, ppiOf(doc), scale);
  const place = placeTextRect(l, r.rect);
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([u, v]) => {
    const a = (place.rotation * Math.PI) / 180;
    const dx = (u - 0.5) * place.width,
      dy = (v - 0.5) * place.height;
    return [place.x + place.width / 2 + Math.cos(a) * dx - Math.sin(a) * dy, place.y + place.height / 2 + Math.sin(a) * dx + Math.cos(a) * dy];
  });
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])))),
    x1 = Math.min(W, Math.ceil(Math.max(...corners.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])))),
    y1 = Math.min(H, Math.ceil(Math.max(...corners.map((c) => c[1]))));
  const img = r.image,
    iw = img.width,
    ih = img.height,
    d = img.data;
  const alpha = (ix: number, iy: number) => (ix < 0 || iy < 0 || ix >= iw || iy >= ih ? 0 : d[(iy * iw + ix) * 4 + 3]);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const [u, v] = localPoint(place, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u > 1 || v > 1) continue;
      const fx = u * iw - 0.5,
        fy = v * ih - 0.5;
      const ix = Math.floor(fx),
        iy = Math.floor(fy);
      const tx = fx - ix,
        ty = fy - iy;
      const a = alpha(ix, iy) * (1 - tx) * (1 - ty) + alpha(ix + 1, iy) * tx * (1 - ty) + alpha(ix, iy + 1) * (1 - tx) * ty + alpha(ix + 1, iy + 1) * tx * ty;
      out[y * W + x] = Math.round(a);
    }
  return { width: W, height: H, data: out };
}
