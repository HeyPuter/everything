import type { Layer } from '../../model/document';
import type { LiveShape } from '../../model/live-shape';
import { vectorBounds, type VectorMask } from '../../model/vector';
import { closedPath, liveKnots, scaleLive, transformMask } from './geometry';
import { docLive, setShapeMask, shapeDocMask } from './state';
export { docLive };

/** Rebuild a live shape's knots from (document-space) parameters. */
export function setLive(l: Layer, live: LiveShape) {
  const first = l.vector!.mask.paths[0];
  const path = closedPath(liveKnots(live), first?.operation ?? 'combine', first?.fillRule ?? 'non-zero');
  setShapeMask(l, { paths: [path] }, true);
  l.vector!.live = live;
}
export function shapeBounds(l: Layer) {
  return vectorBounds(shapeDocMask(l));
}
/** Move and/or resize a shape layer's geometry to a document-space box.
 * Live shapes keep their corner radii and line weight while resizing. */
export function reshape(l: Layer, box: { x?: number; y?: number; width?: number; height?: number }) {
  const mask = shapeDocMask(l);
  const b = vectorBounds(mask);
  if (!b) return;
  // A zero size would flatten the shape for good (a flat side cannot be scaled back).
  const w = box.width !== undefined && box.width > 0 ? box.width : b.width;
  const h = box.height !== undefined && box.height > 0 ? box.height : b.height;
  const x = box.x ?? b.x, y = box.y ?? b.y;
  const sx = b.width ? w / b.width : 1, sy = b.height ? h / b.height : 1;
  const live = docLive(l);
  if (live) {
    setLive(l, scaleLive(live, sx, sy, x - b.x * sx, y - b.y * sy));
    return;
  }
  const copy: VectorMask = structuredClone(mask);
  transformMask(copy, sx, 0, 0, sy, x - b.x * sx, y - b.y * sy);
  setShapeMask(l, copy);
}
