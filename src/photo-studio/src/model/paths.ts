import { isDocumentId } from './ids';
import { validateVectorMask, type VectorMask } from './vector';

// Document paths (the Paths panel) keep editable cubic knots in document
// coordinates, in the same knot format as shape layers and PSD path records.
export type DocumentPath = { id: string; name: string; mask: VectorMask };

// A layer vector mask keeps its editable geometry here. In this version the
// renderer has one scalar mask input, so the geometry is rasterized into the
// layer's `maskGrid` whenever it changes (see features/vector/masks.ts).
// Unlinked vector masks stay in place when the layer moves.
export type LayerVectorMask = { mask: VectorMask; disabled?: boolean; unlinked?: boolean };

export function validateDocumentPaths(paths: unknown, workPath: unknown) {
  if (paths !== undefined) {
    if (!Array.isArray(paths) || paths.length > 1000) throw new Error('Invalid document paths.');
    const ids = new Set<string>();
    for (const p of paths as DocumentPath[]) {
      if (!p || !isDocumentId(p.id) || ids.has(p.id) || typeof p.name !== 'string')
        throw new Error('Invalid document path.');
      ids.add(p.id);
      validateVectorMask(p.mask);
    }
  }
  if (workPath !== undefined) validateVectorMask(workPath);
}

export function validateLayerVectorMask(value: LayerVectorMask) {
  if (!value || typeof value !== 'object' || (value.disabled !== undefined && typeof value.disabled !== 'boolean') || (value.unlinked !== undefined && typeof value.unlinked !== 'boolean'))
    throw new Error('Invalid layer vector mask.');
  validateVectorMask(value.mask);
}

/** Map every knot coordinate (document space) through `f`, in place. */
export function mapMaskPoints(mask: VectorMask, f: (x: number, y: number) => [number, number]) {
  for (const path of mask.paths)
    for (const knot of path.knots)
      for (let i = 0; i < 6; i += 2) [knot.points[i], knot.points[i + 1]] = f(knot.points[i], knot.points[i + 1]);
}
