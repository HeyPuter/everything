import { allLayers, type Layer, type PhotoDocument } from './document';
import { mapMaskPoints } from './paths';
import type { TileGrid, TileStore } from './tiles';
import { carryMask } from './pixel-layer';
import { inverseMaskMatrix, multiplyMaskMatrix, transformMatrix } from './pixel-mask';
import { transformBounds } from './transform';
import { textMatrix } from './text-layer';
import { vectorMatrix, type VectorMatrix } from './vector';
import { applyMat3, transformImage, transformedBounds, type Mat3 } from '../imaging/filters/warp';
import { compose, translate } from '../features/transform/math';

// Layer linking: layers sharing a `linkGroup` ID move and transform together.
// Links survive regrouping and reordering; a group left with a single member
// is dissolved, so a lone layer never shows a link badge.

/** IDs of the given layers plus every layer linked to any of them. */
export function expandLinked(layers: Layer[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const all = allLayers(layers);
  const groups = new Set(all.filter((l) => out.has(l.id) && l.linkGroup).map((l) => l.linkGroup!));
  if (!groups.size) return out;
  for (const l of all) if (l.linkGroup && groups.has(l.linkGroup)) out.add(l.id);
  return out;
}
/** Layers linked to `id`, excluding itself. */
export function linkedPartners(layers: Layer[], id: string): Layer[] {
  const all = allLayers(layers);
  const group = all.find((l) => l.id === id)?.linkGroup;
  return group ? all.filter((l) => l.id !== id && l.linkGroup === group) : [];
}
/** True when every given layer belongs to one shared link group. */
export function allLinked(layers: Layer[], ids: Iterable<string>): boolean {
  const list = [...ids];
  if (list.length < 2) return false;
  const all = allLayers(layers);
  const groups = new Set(list.map((id) => all.find((l) => l.id === id)?.linkGroup));
  return groups.size === 1 && !groups.has(undefined);
}
/** Link the layers (and the layers already linked to them) into one group. */
export function linkLayers(layers: Layer[], ids: Iterable<string>, group: string = crypto.randomUUID()) {
  const members = expandLinked(layers, ids);
  if (members.size < 2) return;
  for (const l of allLayers(layers)) if (members.has(l.id)) l.linkGroup = group;
}
/** Remove the layers from their link groups. */
export function unlinkLayers(layers: Layer[], ids: Iterable<string>) {
  const set = new Set(ids);
  for (const l of allLayers(layers)) if (set.has(l.id)) delete l.linkGroup;
  cleanLinks(layers);
}
/** Give layers brought in from elsewhere (imported, copied from another
 * document) link groups of their own: layers linked together stay linked to
 * each other, never to layers already in the document or to another copy. */
export function renewLinkGroups(layers: Layer[]) {
  const renamed = new Map<string, string>();
  for (const l of allLayers(layers))
    if (l.linkGroup) {
      if (!renamed.has(l.linkGroup)) renamed.set(l.linkGroup, crypto.randomUUID());
      l.linkGroup = renamed.get(l.linkGroup);
    }
}
/** Dissolve link groups with fewer than two members. */
export function cleanLinks(layers: Layer[]) {
  const all = allLayers(layers);
  const count = new Map<string, number>();
  for (const l of all) if (l.linkGroup) count.set(l.linkGroup, (count.get(l.linkGroup) ?? 0) + 1);
  for (const l of all) if (l.linkGroup && (count.get(l.linkGroup) ?? 0) < 2) delete l.linkGroup;
}

// ----- Mask links -----
// A layer mask is linked by default and follows the layer when it moves.
// Unlinked masks stay in place in the document. Pixel layers move their mask
// grid when a pending translation is baked (commitPixelTranslation); other
// layer kinds keep document-space mask grids that follow pure translations
// here, comparing each layer with its previous state.
// Imported pixel masks keep the PSD flag (see setPixelMaskLinked).
export const maskLinked = (l: Layer) => (l.pixelMask ? !l.pixelMask.positionRelativeToLayer : !l.maskUnlinked);
export const vectorMaskLinked = (l: Layer) => !!l.vectorMask && !l.vectorMask.unlinked;

const shiftGrid = (g: TileGrid, dx: number, dy: number): TileGrid => ({ ...g, x: g.x + dx, y: g.y + dy });

/** Move linked masks of non-pixel layers along with pure layer translations
 * made between `before` and `after`. Masks that the edit already moved itself
 * (crops, transforms that resample the mask) are left alone. With `store`,
 * linked masks also follow scaling and rotation (resampled). */
export function followLinkedMasks(before: PhotoDocument, after: PhotoDocument, store?: TileStore) {
  if (before.width !== after.width || before.height !== after.height) return;
  const previous = new Map(allLayers(before.layers).map((l) => [l.id, l]));
  for (const l of allLayers(after.layers)) {
    if (l.kind === 'group' || l.kind === 'pixel') continue;
    const old = previous.get(l.id);
    if (!old) continue;
    const a = old.transform,
      b = l.transform;
    if (a.width !== b.width || a.height !== b.height || a.rotation !== b.rotation) {
      if (store) followTransform(old, l, store);
      continue;
    }
    const dx = b.x - a.x,
      dy = b.y - a.y;
    if (!dx && !dy) continue;
    if (l.maskGrid && old.maskGrid && !l.maskUnlinked && JSON.stringify(l.maskGrid) === JSON.stringify(old.maskGrid)) {
      // Grids live on the pixel grid; fractional moves are tracked through the
      // rounded positions so repeated small moves do not drift.
      const gx = Math.round(b.x) - Math.round(a.x),
        gy = Math.round(b.y) - Math.round(a.y);
      if (gx || gy) l.maskGrid = shiftGrid(l.maskGrid, gx, gy);
    }
    translateVectorMask(old, l, dx, dy);
  }
}
// Where a layer's content sits: type through its local-to-document mapping
// (text edits refit the box without moving the type), shapes through their
// paint matrix, other kinds through the transform of their content.
function placement(l: Layer): VectorMatrix {
  if (l.textData) return textMatrix(l);
  if (l.kind === 'vector' && l.vector) return vectorMatrix(l);
  return transformMatrix(l.transform);
}
/** Carry linked masks through a scale or rotation of the layer's content.
 * New content (embedded contents replaced) and a new frame of an embedded
 * object (skew, distort, warp) are not such changes; their masks stay. */
function followTransform(old: Layer, l: Layer, store: TileStore) {
  if (JSON.stringify(old.embed?.frame?.quad) !== JSON.stringify(l.embed?.frame?.quad)) return;
  if (!l.textData && (old.sourceWidth !== l.sourceWidth || old.sourceHeight !== l.sourceHeight || old.asset !== l.asset)) return;
  const f = multiplyMaskMatrix(placement(l), inverseMaskMatrix(placement(old)));
  if (f.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-9)) return;
  const m: Mat3 = [f[0], f[2], f[4], f[1], f[3], f[5], 0, 0, 1];
  if (l.maskGrid && old.maskGrid && !l.maskUnlinked && JSON.stringify(l.maskGrid) === JSON.stringify(old.maskGrid)) {
    const box = transformBounds(old.transform);
    const x = Math.floor(box.x),
      y = Math.floor(box.y);
    const rect = { x, y, width: Math.max(1, Math.ceil(box.x + box.width) - x), height: Math.max(1, Math.ceil(box.y + box.height) - y) };
    l.maskGrid = carryMask(store, l.maskGrid, rect, (img) => {
      const mm = compose(m, translate(rect.x, rect.y));
      const out = transformedBounds(mm, img.width, img.height);
      return { image: transformImage(img, mm, out, 'bilinear'), x: out.x, y: out.y };
    });
  }
  if (l.vectorMask && !l.vectorMask.unlinked && JSON.stringify(old.vectorMask?.mask) === JSON.stringify(l.vectorMask.mask)) {
    const mask = structuredClone(l.vectorMask.mask);
    mapMaskPoints(mask, (x, y) => {
      const p = applyMat3(m, x, y);
      return [p.x, p.y];
    });
    l.vectorMask = { ...l.vectorMask, mask };
  }
}
/** Shift a linked vector mask with its layer unless the edit already changed it. */
export function translateVectorMask(old: Layer | undefined, l: Layer, dx: number, dy: number) {
  if (!l.vectorMask || l.vectorMask.unlinked || (!dx && !dy)) return;
  if (old && JSON.stringify(old.vectorMask?.mask) !== JSON.stringify(l.vectorMask.mask)) return;
  const mask = structuredClone(l.vectorMask.mask);
  mapMaskPoints(mask, (x, y) => [x + dx, y + dy]);
  l.vectorMask = { ...l.vectorMask, mask };
}
