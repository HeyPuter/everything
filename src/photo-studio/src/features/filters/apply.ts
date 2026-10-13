// Filter sessions: what a filter edits (layer pixels, a mask, Quick Mask or a
// Live Filter stack), the region it reads, and committing the worker's tiles
// as one history step named after the filter.
import type { Editor } from '../../editor';
import { findLayer, type Blend, type LiveFilter } from '../../model/document';
import { setLayerPixels, syncPixelTransform } from '../../model/pixel-layer';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { intersectRect, type TileGrid } from '../../model/tiles';
import type { BlendMode } from '../../imaging/blend';
import type { IRect, ParamValues } from '../../imaging/types';
import { hexRgb, pixelTarget, previewTarget, type PixelTarget } from '../pixels';
import { GALLERY_ID, filterOp, normalizeFor, stackMargin } from './catalog';
import { filterLabel } from './menu';
import { Lane, isCancel, registerSource, releaseSource } from './client';
import type { StackContext, StackEntry } from './stack';
import { gridPayload, mergeTiles, type TileResult } from './tilepack';
import { progressHud } from './hud';

export type Session = {
  e: Editor;
  target: PixelTarget;
  // Grid results merge into: the target grid, or the Live Filter source.
  base: TileGrid;
  rect: IRect;
  key: string;
  selection: TileGrid | null;
  selBounds: IRect | null;
  seed: number;
  live?: { layerId: string; filters: LiveFilter[]; index: number; mask?: TileGrid; newMask?: TileGrid };
};
export { filterState, isLiveLayer, type FadeInfo } from './state';
import { filterState, isLiveLayer } from './state';

let keys = 0;
export const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;
export const toMode = (b: Blend) => (b === 'pass through' ? 'normal' : b.replace(/ /g, '-')) as BlendMode;
export const fromMode = (m: BlendMode) => m.replace(/-/g, ' ') as Blend;
export function opLabel(opId: string) {
  return opId === GALLERY_ID ? 'Filter Gallery' : (filterOp(opId)?.label ?? filterLabel(opId));
}
export function filterContext(e: Editor, s: Session): StackContext {
  return { foreground: hexRgb(e.color), background: hexRgb(e.background), seed: s.seed };
}

function grow(r: IRect, m: number): IRect {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}
function contains(a: IRect, b: IRect) {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}
function load(s: Session) {
  const store = s.e.assets.tiles;
  s.key = `src${++keys}`;
  const live = s.live;
  registerSource({
    type: 'load',
    key: s.key,
    rect: s.rect,
    image: gridPayload(store, s.base, s.rect),
    selection: !live && s.selection ? gridPayload(store, s.selection, s.rect) : undefined,
    mask: live?.mask ? gridPayload(store, live.mask, s.rect) : undefined,
  });
}
/** Region a destructive filter needs: the canvas, or with a selection its
 * bounds grown by the filter's reach (with slack so slider drags rarely reload). */
function regionFor(s: Session, entries: StackEntry[], slack: boolean): IRect {
  const canvas = canvasRect(s.e.doc);
  if (s.live || !s.selBounds) return canvas;
  const m = stackMargin(entries);
  if (m === undefined) return canvas;
  return intersectRect(grow(s.selBounds, slack ? Math.ceil(m * 1.5) + 32 : m), canvas) ?? canvas;
}
/** Use a different region (Liquify works on the selection bounds). */
export function setRegion(s: Session, rect: IRect) {
  releaseSource(s.key);
  s.rect = rect;
  load(s);
}
/** Reload the source when a larger reach needs more context; true if it did. */
export function ensureRect(s: Session, entries: StackEntry[]) {
  if (contains(s.rect, regionFor(s, entries, false))) return false;
  releaseSource(s.key);
  s.rect = regionFor(s, entries, true);
  load(s);
  return true;
}

/** Start a session for applying `opId` (or re-editing Live Filter `edit`). */
export async function openSession(e: Editor, opId: string, params: ParamValues, edit?: { layerId: string; index: number }): Promise<Session | undefined> {
  const doc = e.doc;
  const quick = !!e.settings.quickMask;
  const layer = edit ? findLayer(doc.layers, edit.layerId) : e.layer;
  if (edit || (isLiveLayer(layer) && !e.editingMask && !quick && e.selectedIds.size === 1)) {
    if (!isLiveLayer(layer)) return;
    if (!layer.visible) {
      e.message('The target layer is hidden. Show it to filter it.');
      return;
    }
    const filters = layer.liveFilters.map((f) => ({ ...f, params: { ...f.params } }));
    const index = edit ? edit.index : filters.length;
    if (!edit) filters.push({ id: opId, params: { ...params }, enabled: true, opacity: 1, blend: 'normal', seed: randomSeed() });
    // A disabled filter mask is kept but not applied.
    let mask = layer.liveMaskDisabled ? undefined : layer.liveMask;
    let newMask: TileGrid | undefined;
    // A selection made before the first masked filter becomes the filter mask.
    const sel = selectionGrid(doc, e.assets.tiles);
    if (!edit && !layer.liveMask && sel && selectionBounds(doc, sel)) mask = newMask = sel;
    const s: Session = { e, target: { kind: 'pixels', layer, grid: layer.pixels! }, base: layer.liveSource, rect: canvasRect(doc), key: '', selection: null, selBounds: null, seed: filters[index].seed, live: { layerId: layer.id, filters, index, mask, newMask } };
    load(s);
    return s;
  }
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const selection = selectionGrid(e.doc, e.assets.tiles);
  const selBounds = selection ? selectionBounds(e.doc, selection) : null;
  if (selection && !selBounds) {
    e.message('No pixels are selected.');
    return;
  }
  const s: Session = { e, target, base: target.grid, rect: canvasRect(e.doc), key: '', selection, selBounds, seed: randomSeed() };
  s.rect = regionFor(s, [{ id: opId, params }], true);
  load(s);
  return s;
}
/** Worker stack for the session with `params` for the filter being applied. */
export function sessionEntries(s: Session, opId: string, params: ParamValues, blending?: { opacity: number; blend: Blend }): StackEntry[] {
  if (!s.live) return [{ id: opId, params, seed: s.seed }];
  return s.live.filters.map((f, i) => {
    const cur = i === s.live!.index;
    const b = cur && blending ? blending : f;
    return { id: f.id, params: cur ? params : normalizeFor(f.id, f.params), enabled: f.enabled, opacity: b.opacity, blend: toMode(b.blend), seed: f.seed };
  });
}
export const runFlags = (s: Session) => ({ useSelection: !s.live && !!s.selection, useMask: !!s.live?.mask });
export function sessionDoc(s: Session, grid: TileGrid) {
  return previewTarget(s.e, s.target, grid);
}
export function resultGrid(s: Session, tiles: TileResult) {
  return mergeTiles(s.e.assets.tiles, s.base, tiles);
}
/** Store the result as one history step and remember it for Last Filter / Fade. */
export function commitSession(s: Session, grid: TileGrid, opId: string, params: ParamValues, label = opLabel(opId), blending?: { opacity: number; blend: Blend }) {
  const e = s.e;
  delete e.settings.quickMaskPreview;
  if (s.live) {
    const live = s.live;
    const filters = live.filters.map((f, i) => (i === live.index ? { ...f, params: { ...params }, ...(blending ?? {}) } : f));
    e.command(label, (d) => {
      const l = findLayer(d.layers, live.layerId);
      if (!l) return;
      l.liveFilters = filters;
      if (live.newMask) l.liveMask = live.newMask;
      l.pixels = grid;
      syncPixelTransform(l, d);
    });
    filterState.fade = undefined;
  } else {
    const before = s.base;
    if (s.target.kind === 'quick-mask') e.settings.quickMask = grid;
    commitTargetGrid(e, s.target, grid, label);
    filterState.fade = { doc: e.doc, quick: s.target.kind === 'quick-mask' ? grid : undefined, label, target: s.target, before, after: grid, rect: s.rect };
  }
  if (opId !== 'liquify') filterState.last = { opId, params };
}
function commitTargetGrid(e: Editor, target: PixelTarget, grid: TileGrid, label: string) {
  if (target.kind === 'quick-mask') {
    e.update();
    return;
  }
  const id = target.layer.id;
  e.command(label, (d) => {
    const l = findLayer(d.layers, id);
    if (!l) return;
    if (target.kind === 'mask') l.maskGrid = grid;
    else setLayerPixels(l, grid, d);
  });
  if (target.kind === 'mask') e.maskTarget = id;
}
export function closeSession(s: Session) {
  releaseSource(s.key);
  delete s.e.settings.quickMaskPreview;
}

const applyLane = new Lane('apply');
/** Apply without a dialog (immediate filters, recorded actions, Last Filter). */
export async function applyDirect(e: Editor, opId: string, params: ParamValues, edit?: { layerId: string; index: number }) {
  const s = await openSession(e, opId, params, edit);
  if (!s) return false;
  const label = opLabel(opId);
  const hud = progressHud(e, `${label}…`, () => applyLane.cancel());
  try {
    const entries = sessionEntries(s, opId, params);
    ensureRect(s, entries);
    const res = await applyLane.run({ type: 'run', job: 0, key: s.key, filters: entries, ctx: filterContext(e, s), ...runFlags(s), output: 'tiles' }, [s.key], (f) => hud.set(f));
    commitSession(s, resultGrid(s, res.tiles!), opId, params, label);
    return true;
  } catch (error) {
    if (!isCancel(error)) throw error;
    e.message(`${label} was cancelled.`);
    return false;
  } finally {
    hud.close();
    closeSession(s);
  }
}
