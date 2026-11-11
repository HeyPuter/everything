// Filter state read by menus at any time (Last Filter, Fade, Live Filter
// layers), kept apart from the filter implementations that load on demand.
import type { Editor } from '../../editor';
import type { Layer, LiveFilter } from '../../model/document';
import { gridDocBounds, unionRect, type TileGrid } from '../../model/tiles';
import type { IRect, ParamValues } from '../../imaging/types';
import type { PixelTarget } from '../pixels';

export type FadeInfo = { doc: unknown; quick?: TileGrid; label: string; target: PixelTarget; before: TileGrid; after: TileGrid; rect: IRect };
export const filterState: { last?: { opId: string; params: ParamValues }; fade?: FadeInfo } = {};

export const isLiveLayer = (l: Layer | undefined): l is Layer & { liveSource: TileGrid; liveFilters: LiveFilter[] } =>
  !!l && l.kind === 'pixel' && !!l.liveSource && Array.isArray(l.liveFilters);

export function canFade(e: Editor) {
  const f = filterState.fade;
  if (!f) return false;
  return f.quick ? e.settings.quickMask === f.quick : e.doc === f.doc;
}
export function fadeLabel() {
  return filterState.fade ? `Fade ${filterState.fade.label}…` : 'Fade…';
}

/** Region a Live Filter stack renders: the canvas and all of the layer's
 * source, so content outside the canvas is filtered too and shows filtered
 * when the layer is moved into view. */
export function liveRect(doc: { width: number; height: number }, source: TileGrid): IRect {
  const canvas = { x: 0, y: 0, width: doc.width, height: doc.height };
  return unionRect(canvas, gridDocBounds(source)) ?? canvas;
}
