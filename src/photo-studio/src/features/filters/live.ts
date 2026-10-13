// Live Filters: a pixel layer keeps its original tiles (`liveSource`) and a
// list of filter settings; `pixels` caches the rendered stack so the renderer,
// thumbnails and exports see the result. Edits re-render in the worker and
// store the new cache with the new list as one history step.
import type { Editor } from '../../editor';
import { findLayer, type Layer, type LiveFilter } from '../../model/document';
import { syncPixelTransform } from '../../model/pixel-layer';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import type { TileGrid } from '../../model/tiles';
import { rasterizeLayer, hexRgb } from '../pixels';
import { filterOp, isStackOp, normalizeFor } from './catalog';
import { Lane, isCancel, registerSource, releaseSource } from './client';
import { isLiveLayer, toMode } from './apply';
import { gridPayload, mergeTiles } from './tilepack';
import { progressHud } from './hud';

const lane = new Lane('live');
let keys = 0;

/** Render `filters` over the layer's source; returns the cached result grid. */
export async function renderLive(e: Editor, l: Layer & { liveSource: TileGrid }, filters: LiveFilter[], mask: TileGrid | undefined, label: string): Promise<TileGrid | undefined> {
  const store = e.assets.tiles;
  const rect = canvasRect(e.doc);
  const key = `live${++keys}`;
  registerSource({ type: 'load', key, rect, image: gridPayload(store, l.liveSource, rect), mask: mask ? gridPayload(store, mask, rect) : undefined });
  const hud = progressHud(e, `${label}…`, () => lane.cancel());
  try {
    const res = await lane.run(
      {
        type: 'run',
        job: 0,
        key,
        filters: filters.map((f) => ({ id: f.id, params: normalizeFor(f.id, f.params), enabled: f.enabled, opacity: f.opacity, blend: toMode(f.blend), seed: f.seed })),
        ctx: { foreground: hexRgb(e.color), background: hexRgb(e.background) },
        useSelection: false,
        useMask: !!mask,
        output: 'tiles',
      },
      [key],
      (f) => hud.set(f),
    );
    return mergeTiles(store, l.liveSource, res.tiles!);
  } catch (error) {
    if (isCancel(error)) {
      e.message(`${label} was cancelled.`);
      return undefined;
    }
    throw error;
  } finally {
    hud.close();
    releaseSource(key);
  }
}
/** Change a live layer's filter list (and mask) as one undoable step.
 * `maskDisabled` keeps the filter mask but renders without it. */
export async function updateLive(e: Editor, layerId: string, label: string, change: (filters: LiveFilter[]) => LiveFilter[], mask?: TileGrid | null, maskDisabled?: boolean) {
  const l = findLayer(e.doc.layers, layerId);
  if (!isLiveLayer(l)) return;
  const filters = change(l.liveFilters.map((f) => ({ ...f })));
  const nextMask = mask === null ? undefined : (mask ?? l.liveMask);
  const disabled = !!nextMask && (maskDisabled ?? !!l.liveMaskDisabled);
  for (const f of filters)
    if (!isStackOp(f.id) && !filterOp(f.id)) {
      e.message(`The filter “${f.id}” is not available in this version.`);
      return;
    }
  const grid = await renderLive(e, l, filters, disabled ? undefined : nextMask, label);
  if (!grid) return;
  e.command(label, (d) => {
    const t = findLayer(d.layers, layerId);
    if (!t) return;
    t.liveFilters = filters;
    if (nextMask) t.liveMask = nextMask;
    else delete t.liveMask;
    if (disabled) t.liveMaskDisabled = true;
    else delete t.liveMaskDisabled;
    t.pixels = grid;
    syncPixelTransform(t, d);
  });
}

export async function convertForLiveFilters(e: Editor) {
  let l = e.layer;
  if (!l || e.selectedIds.size !== 1) {
    e.message('Select one layer to convert it for Live Filters.');
    return;
  }
  if (isLiveLayer(l)) {
    e.message('This layer already uses Live Filters.');
    return;
  }
  if (l.kind === 'group' || l.kind === 'adjustment') {
    e.message('Groups and adjustment layers cannot hold Live Filters.');
    return;
  }
  if (l.kind !== 'pixel') {
    await rasterizeLayer(e, l.id);
    l = e.layer!;
  }
  const id = l.id;
  e.command('Convert for Live Filters', (d) => {
    const t = findLayer(d.layers, id);
    if (!t?.pixels) return;
    t.liveSource = t.pixels;
    t.liveFilters = [];
  });
  e.message('Filters applied to this layer are now Live Filters you can edit or hide.');
}
export async function toggleLiveMask(e: Editor) {
  const l = e.layer;
  if (!isLiveLayer(l)) return;
  if (l.liveMask) {
    await updateLive(e, l.id, 'Delete Live Filter Mask', (f) => f, null);
    return;
  }
  const sel = selectionGrid(e.doc, e.assets.tiles);
  if (!sel || !selectionBounds(e.doc, sel)) {
    e.message('Make a selection to use as the Live Filter mask.');
    return;
  }
  await updateLive(e, l.id, 'Add Live Filter Mask', (f) => f, sel);
}

export { liveRows, bindLiveRows } from './live-rows';
