import type { Layer, PhotoDocument, Rect } from './document';
import { mapArtboardGuides } from './guides';

// Document-space layout geometry (artboard and frame rectangles, user slices,
// the positions stored in layer comps and the placement bounds of pixel
// variables) follows canvas crops, resizes and rotations. Only type imports here: the document model calls this module.
export type PointMap = (x: number, y: number) => [number, number];

/** Axis-aligned bounds of a rectangle mapped through `f`, on whole pixels. */
export function mapRect(r: Rect, f: PointMap): Rect {
  const corners = [f(r.x, r.y), f(r.x + r.width, r.y), f(r.x, r.y + r.height), f(r.x + r.width, r.y + r.height)];
  const xs = corners.map((c) => c[0]),
    ys = corners.map((c) => c[1]);
  const x = Math.round(Math.min(...xs)),
    y = Math.round(Math.min(...ys));
  return {
    x,
    y,
    width: Math.max(1, Math.round(Math.max(...xs)) - x),
    height: Math.max(1, Math.round(Math.max(...ys)) - y),
  };
}

function walk(layers: Layer[], visit: (l: Layer) => void) {
  for (const l of layers) {
    visit(l);
    walk(l.children, visit);
  }
}

/** Map every piece of layout geometry in place. */
export function mapLayoutGeometry(doc: PhotoDocument, f: PointMap) {
  walk(doc.layers, (l) => {
    if (l.artboard) {
      const before = l.artboard.rect;
      l.artboard.rect = mapRect(before, f);
      // Artboard guides are offsets from the rectangle; keep them on the same image lines.
      if (l.artboard.guides) {
        const guides = mapArtboardGuides(l.artboard.guides, before, l.artboard.rect, f);
        if (guides.length) l.artboard.guides = guides;
        else delete l.artboard.guides;
      }
    }
    if (l.frame) l.frame.rect = mapRect(l.frame.rect, f);
  });
  for (const s of doc.slices ?? []) s.rect = mapRect(s.rect, f);
  for (const comp of doc.layerComps ?? [])
    for (const state of Object.values(comp.layers)) {
      if (state.x === undefined || state.y === undefined) continue;
      const [x, y] = f(state.x, state.y);
      state.x = Math.round(x * 1000) / 1000;
      state.y = Math.round(y * 1000) / 1000;
    }
  for (const v of Object.values(doc.variables?.layers ?? {})) if (v.pixel) v.pixel.bounds = mapRect(v.pixel.bounds, f);
}
