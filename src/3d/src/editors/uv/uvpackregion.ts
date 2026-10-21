// Pack Islands targets (pure): UDIM tile numbers and the rectangle each pack source fills.
import type { ImageData } from '../../data/types';
import { isTiled, tileCell } from '../../render/udim';

export type PackSource = 'CLOSEST_UDIM' | 'ACTIVE_UDIM' | 'ORIGINAL_AABB' | 'CUSTOM_REGION';

/** A [xmin, ymin, xmax, ymax] region as [x, y, width, height] (the 0–1 square when unset). */
export function normRegion(r: number[] | undefined): [number, number, number, number] {
  if (!r || r.length < 4) return [0, 0, 1, 1];
  const x0 = Math.min(r[0], r[2]),
    y0 = Math.min(r[1], r[3]);
  return [x0, y0, Math.max(1e-6, Math.abs(r[2] - r[0])), Math.max(1e-6, Math.abs(r[3] - r[1]))];
}

/** UDIM tile number of a UV square (column u ≥ 0 < 10, row v ≥ 0). */
export const tileNumber = (u: number, v: number) => 1001 + u + 10 * v;

/**
 * Target rectangle [x, y, w, h] of Pack Islands: the UDIM tile nearest the selection's centre, the
 * active tile of the shown image, the selection's own bounds, or the user region.
 */
export function packRegion(source: PackSource, bounds: [number, number, number, number] | null, image: ImageData | null, custom: number[] | undefined = undefined): [number, number, number, number] {
  if (source === 'CUSTOM_REGION') return normRegion(custom);
  if (source === 'ORIGINAL_AABB' && bounds) return [bounds[0], bounds[1], Math.max(1e-6, bounds[2] - bounds[0]), Math.max(1e-6, bounds[3] - bounds[1])];
  if (source === 'ACTIVE_UDIM' && isTiled(image)) {
    const t = image!.tiles![image!.active_tile_index ?? 0] ?? image!.tiles![0];
    const [u, v] = tileCell(t.number);
    return [u, v, 1, 1];
  }
  if (source === 'CLOSEST_UDIM' && bounds) {
    const cu = (bounds[0] + bounds[2]) / 2,
      cv = (bounds[1] + bounds[3]) / 2;
    return [Math.max(0, Math.min(9, Math.floor(cu))), Math.max(0, Math.floor(cv)), 1, 1];
  }
  return [0, 0, 1, 1];
}

