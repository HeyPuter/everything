// Viewer Region: a rectangle of the viewer image (normalized, y up) outside which the Viewer
// node's result is left empty. Stored on the compositing node tree.
import type { NodeTreeData } from '../data/types';

export type Region = [x0: number, y0: number, x1: number, y1: number];

interface RegionTree {
  use_viewer_border?: boolean;
  viewer_border?: Region;
}

/** The active region of a tree, or null when none is set. */
export function viewerRegion(tree: NodeTreeData): Region | null {
  const t = tree as NodeTreeData & RegionTree;
  if (!t.use_viewer_border || !t.viewer_border) return null;
  const [x0, y0, x1, y1] = t.viewer_border;
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

export function setViewerRegion(tree: NodeTreeData, r: Region | null) {
  const t = tree as NodeTreeData & RegionTree;
  if (!r) {
    t.use_viewer_border = false;
    return;
  }
  const c = (v: number) => Math.max(0, Math.min(1, v));
  t.viewer_border = [c(Math.min(r[0], r[2])), c(Math.min(r[1], r[3])), c(Math.max(r[0], r[2])), c(Math.max(r[1], r[3]))];
  t.use_viewer_border = true;
}

/** Pixel bounds [x0, y0, x1, y1) of a region in an image (rows counted from the top). */
export function regionPixels(r: Region, w: number, h: number): [number, number, number, number] {
  return [Math.floor(r[0] * w), Math.floor((1 - r[3]) * h), Math.ceil(r[2] * w), Math.ceil((1 - r[1]) * h)];
}

/** Clear the pixels outside the region (top-down RGBA rows, and the matching display canvas). */
export function maskToRegion(img: { data: Float32Array; width: number; height: number; display?: HTMLCanvasElement | null }, r: Region) {
  const { width: w, height: h, data } = img;
  const [px0, py0, px1, py1] = regionPixels(r, w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x >= px0 && x < px1 && y >= py0 && y < py1) continue;
      data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  const g = img.display?.getContext('2d');
  if (g) {
    g.clearRect(0, 0, w, py0);
    g.clearRect(0, py1, w, h - py1);
    g.clearRect(0, py0, px0, py1 - py0);
    g.clearRect(px1, py0, w - px1, py1 - py0);
  }
}
