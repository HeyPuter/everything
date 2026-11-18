import { allLayers, type Layer } from './document';
import { gridDocBounds } from './tiles';
import { cleanLinks } from './links';
import type { Mask8, RGBA8 } from '../imaging/types';

// Whole-document layer housekeeping: removing empty or hidden layers and
// turning transparency into masks. Pure functions on layer trees and pixels.

/** True when a layer has no content of its own (Delete All Empty Layers).
 * Adjustment, fill and shape layers always count as content. */
export function isEmptyLayer(l: Layer): boolean {
  if (l.kind === 'group') return l.children.length === 0;
  if (l.kind === 'pixel') return !l.pixels || !gridDocBounds(l.pixels);
  if (l.kind === 'text') return !l.text.trim();
  return false;
}
/** Remove matching layers anywhere in the tree (a removed group takes its
 * children along); returns how many layers were removed. */
export function removeLayers(layers: Layer[], match: (l: Layer) => boolean): number {
  const removed = removeMatching(layers, match);
  // Links are counted over the whole tree: a layer in a group may be linked
  // to one outside it.
  if (removed) cleanLinks(layers);
  return removed;
}
function removeMatching(layers: Layer[], match: (l: Layer) => boolean): number {
  let removed = 0;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (match(l)) {
      layers.splice(i, 1);
      removed += 1 + allLayers(l.children).length;
    } else removed += removeMatching(l.children, match);
  }
  return removed;
}
/** Remove empty layers repeatedly, so groups emptied by the pass go too.
 * The Background layer is kept even when it is blank. */
export function removeEmptyLayers(layers: Layer[]): number {
  let total = 0;
  for (;;) {
    const n = removeLayers(layers, (l) => !l.background && isEmptyLayer(l));
    total += n;
    if (!n) return total;
  }
}
/** Remove hidden layers (Delete → Hidden Layers). */
export function removeHiddenLayers(layers: Layer[]): number {
  return removeLayers(layers, (l) => !l.visible);
}

/** Split an image's alpha into a mask and an opaque image, so masking the
 * opaque image by the mask reproduces the original (Layer Mask → From
 * Transparency). Fully transparent pixels keep their stored color. */
export function transparencyToMask(img: RGBA8): { mask: Mask8; opaque: RGBA8 } {
  const n = img.width * img.height;
  const mask = new Uint8Array(n);
  const data = new Uint8ClampedArray(img.data);
  for (let i = 0; i < n; i++) {
    mask[i] = img.data[i * 4 + 3];
    data[i * 4 + 3] = 255;
  }
  return { mask: { width: img.width, height: img.height, data: mask }, opaque: { width: img.width, height: img.height, data } };
}
/** The layer mask for Paste Into (the selection) or Paste Outside (its inverse). */
export function pasteMask(selection: Mask8, outside: boolean): Mask8 {
  if (!outside) return { width: selection.width, height: selection.height, data: new Uint8Array(selection.data) };
  const data = new Uint8Array(selection.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - selection.data[i];
  return { width: selection.width, height: selection.height, data };
}

// ----- Background layer -----
/** Mark a layer as the document's Background: locked transparency and position. */
export function makeBackground(l: Layer) {
  l.background = true;
  l.locked = false;
  l.protection = { transparency: true, composite: !!l.protection?.composite, position: true };
  delete l.linkGroup;
}
export function releaseBackground(l: Layer) {
  delete l.background;
  l.locked = false;
  l.protection = { transparency: false, composite: !!l.protection?.composite, position: false };
  delete l.transparencyProtected;
}
