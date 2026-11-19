// Relight layers as pixels: Layer › Rasterize turns one into a pixel layer
// and PSD export writes each as one (PSD has no relight record). The pixels
// are the relit image beneath the layer, rendered by the compositor exactly
// as the canvas shows it; the layer keeps its name, mask, opacity, blend
// mode and clipping, so the rasterized stack looks the same.
import type { Editor } from '../../editor';
import { allLayers, type Layer, type PhotoDocument } from '../../model/document';
import { clearToPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { gridFromImage, type TileGrid } from '../../model/tiles';
import { compositeRGBA } from '../pixels';
import { isRelightLayer } from './state';

// A group composites its children by themselves unless it passes through.
const isolates = (l: Layer) =>
  l.kind === 'group' && (l.blend !== 'pass through' || !!l.artboard || !!l.frame);

/** The document drawn up to and including relight layer `id`: the layer is
 * drawn plainly (full opacity, no mask, not clipped), later layers are
 * hidden, enclosing groups are shown without their opacity and masks, and
 * inside a group that composites by itself only that group's layers count. */
export function relightSnapshot(doc: PhotoDocument, id: string): PhotoDocument | undefined {
  // The groups enclosing the layer, outermost first.
  const find = (layers: Layer[], trail: Layer[]): Layer[] | undefined => {
    for (const l of layers) {
      if (l.id === id) return trail;
      const inner = l.children.length ? find(l.children, [...trail, l]) : undefined;
      if (inner) return inner;
    }
  };
  const path = find(doc.layers, []);
  if (!path) return;
  let scope = doc.layers;
  let inner = path;
  for (let i = path.length - 1; i >= 0; i--)
    if (isolates(path[i])) {
      scope = path[i].children;
      inner = path.slice(i + 1);
      break;
    }
  const ancestors = new Set(inner.map((l) => l.id));
  let found = false;
  const plain = {
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    mask: null,
    maskAsset: undefined,
    pixelMask: undefined,
    maskStrokes: undefined,
    maskGrid: undefined,
    maskInverted: false,
    maskDisabled: false,
    blending: undefined,
  };
  const walk = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      if (found) return { ...l, visible: false };
      if (l.id === id) {
        found = true;
        return { ...l, ...plain, blend: 'normal', clipped: false };
      }
      if (ancestors.has(l.id))
        return { ...l, ...plain, style: undefined, children: walk(l.children) };
      return l;
    });
  return { ...doc, layers: walk(scope), selection: null, selectionMask: null };
}

/** The pixels of a relight layer as a document-sized tile grid. */
export async function relightGrid(
  e: Editor,
  doc: PhotoDocument,
  id: string,
): Promise<TileGrid | undefined> {
  const snapshot = relightSnapshot(doc, id);
  if (!snapshot) return;
  return gridFromImage(e.assets.tiles, await compositeRGBA(e, snapshot));
}

/** Turn a relight layer (in a draft) into a pixel layer holding `grid`. */
export function relightToPixels(
  target: Layer,
  grid: TileGrid,
  doc: Pick<PhotoDocument, 'width' | 'height'>,
) {
  const name = target.name;
  delete target.adjustment;
  clearToPixelLayer(target);
  setLayerPixels(target, grid, doc);
  target.name = name;
}

/** Layer › Rasterize for a relight layer: the edit to commit. */
export async function prepareRelightRaster(
  e: Editor,
  id: string,
): Promise<((d: PhotoDocument) => void) | undefined> {
  const grid = await relightGrid(e, e.doc, id);
  if (!grid) return;
  return (d) => {
    const target = allLayers(d.layers).find((l) => l.id === id);
    if (isRelightLayer(target)) relightToPixels(target, grid, d);
  };
}

/** Replace every relight layer of `doc` (a copy being exported) by its
 * pixels. All are rendered from the document as it is before any changes. */
export async function rasterizeRelightLayers(e: Editor, doc: PhotoDocument) {
  const targets = allLayers(doc.layers).filter(isRelightLayer);
  if (!targets.length) return;
  const source = structuredClone(doc);
  const grids = new Map<string, TileGrid>();
  for (const l of targets) {
    const grid = await relightGrid(e, source, l.id);
    if (grid) grids.set(l.id, grid);
  }
  for (const l of targets) {
    const grid = grids.get(l.id);
    if (grid) relightToPixels(l, grid, doc);
  }
}
