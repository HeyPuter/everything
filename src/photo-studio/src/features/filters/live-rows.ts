// Live Filter rows under a layer in the Layers panel and their buttons.
import type { Editor } from '../../editor';
import { findLayer, blendLabel, type Layer } from '../../model/document';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { lazy } from '../../app/lazy';
import { gridThumbnail } from '../panels/thumbnails';
import { filterLabel } from './menu';
import { isLiveLayer } from './state';

const liveFilters = lazy(() => import('./live'));
const updateLive: typeof import('./live').updateLive = async (...args) => (await liveFilters()).updateLive(...args);

/** Rows shown under a live layer in the Layers panel. */
export function liveRows(e: Editor, l: Layer, depth: number): string {
  if (!isLiveLayer(l)) return '';
  const any = l.liveFilters.some((f) => f.enabled);
  const mask = l.liveMask ? `<img class="live-mask-thumb ${l.liveMaskDisabled ? 'disabled' : ''}" src="${gridThumbnail(e.assets.tiles, l.liveMask, e.doc.width, e.doc.height, 28, true)}" alt="Live Filter mask${l.liveMaskDisabled ? ' (disabled)' : ''}" title="Live Filter mask${l.liveMaskDisabled ? ' (disabled)' : ''}">` : '';
  const head = `<div class="live-filter-row live-head" style="--depth:${depth}" data-live-layer="${escapeXML(l.id)}"><button class="eye" data-live-all="${escapeXML(l.id)}" aria-label="${any ? 'Hide' : 'Show'} all Live Filters" title="${any ? 'Hide' : 'Show'} all Live Filters">${any ? svg('eye', 14) : ''}</button>${mask}<span class="live-title">Live Filters</span></div>`;
  const rows = l.liveFilters
    .map((f, i) => ({ f, i }))
    .reverse()
    .map(({ f, i }) => {
      const name = filterLabel(f.id);
      const blend = f.opacity < 1 || f.blend !== 'normal' ? `<small>${Math.round(f.opacity * 100)}% ${escapeXML(blendLabel(f.blend))}</small>` : '';
      return `<div class="live-filter-row ${f.enabled ? '' : 'disabled'}" style="--depth:${depth}" data-live-filter="${l.id}:${i}" title="Double-click to edit settings"><button class="eye" data-live-eye="${l.id}:${i}" aria-label="${f.enabled ? 'Hide' : 'Show'} ${escapeXML(name)}" aria-pressed="${f.enabled}">${f.enabled ? svg('eye', 14) : ''}</button><span class="live-name">${escapeXML(name)}</span>${blend}<button class="icon-button live-edit" data-live-edit="${l.id}:${i}" aria-label="Edit ${escapeXML(name)} settings" title="Edit settings and blending">${svg('sliders-horizontal', 13)}</button><button class="icon-button live-delete" data-live-delete="${l.id}:${i}" aria-label="Delete ${escapeXML(name)}" title="Delete Live Filter">${svg('x', 13)}</button></div>`;
    })
    .join('');
  return head + rows;
}
/** Panel interactions, delegated from the editor root. */
export function bindLiveRows(e: Editor, edit: (layerId: string, index: number, id: string) => void) {
  const parse = (v: string) => {
    const i = v.lastIndexOf(':');
    return { layerId: v.slice(0, i), index: Number(v.slice(i + 1)) };
  };
  e.root.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest('.live-filter-row') || e.busy) return;
    const all = t.closest<HTMLElement>('[data-live-all]')?.dataset.liveAll;
    if (all) {
      const l = findLayer(e.doc.layers, all);
      if (!isLiveLayer(l)) return;
      const on = !l.liveFilters.some((f) => f.enabled);
      void e.run(() => updateLive(e, all, on ? 'Show Live Filters' : 'Hide Live Filters', (fs) => fs.map((f) => ({ ...f, enabled: on }))));
      return;
    }
    const eye = t.closest<HTMLElement>('[data-live-eye]')?.dataset.liveEye;
    if (eye) {
      const { layerId, index } = parse(eye);
      void e.run(() => updateLive(e, layerId, 'Toggle Live Filter', (fs) => fs.map((f, i) => (i === index ? { ...f, enabled: !f.enabled } : f))));
      return;
    }
    const del = t.closest<HTMLElement>('[data-live-delete]')?.dataset.liveDelete;
    if (del) {
      const { layerId, index } = parse(del);
      void e.run(() => updateLive(e, layerId, 'Delete Live Filter', (fs) => fs.filter((_, i) => i !== index)));
      return;
    }
    const ed = t.closest<HTMLElement>('[data-live-edit]')?.dataset.liveEdit;
    if (ed) {
      const { layerId, index } = parse(ed);
      const l = findLayer(e.doc.layers, layerId);
      if (isLiveLayer(l) && l.liveFilters[index]) edit(layerId, index, l.liveFilters[index].id);
      return;
    }
    const row = t.closest<HTMLElement>('[data-live-filter],[data-live-layer]');
    const id = row?.dataset.liveLayer ?? (row?.dataset.liveFilter && parse(row.dataset.liveFilter).layerId);
    if (id && !e.selectedIds.has(id)) e.selectLayer(id);
  });
  e.root.addEventListener('dblclick', (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-live-filter]');
    if (!row || (ev.target as HTMLElement).closest('button') || e.busy) return;
    const { layerId, index } = parse(row.dataset.liveFilter!);
    const l = findLayer(e.doc.layers, layerId);
    if (isLiveLayer(l) && l.liveFilters[index]) edit(layerId, index, l.liveFilters[index].id);
  });
}
