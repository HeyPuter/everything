/**
 * Filters tab: color looks. Clicking applies the look to the selected clip;
 * with no clip selected (or by dragging) it adds a filter clip that grades
 * everything below it.
 */
import { h } from '../../lib/dom.js';
import { FILTERS, FILTER_CATEGORIES } from '../../model/catalog.js';
import { tabLayout, tileGrid, tile, emptyState } from './common.js';
import { lookPreview, hoverAnimate, matchesLook } from './previews.js';

export function filtersTab(ctx) {
  const { store, actions } = ctx;
  const selectedVisual = () => {
    const s = store.selected;
    return s && (s.clip.type === 'video' || s.clip.type === 'image') ? s.clip : null;
  };
  const hint = h('p.asset-hint', { role: 'status' });
  let shown = null; // the selected clip's filter the tiles show
  const layout = tabLayout({
    title: 'Filters',
    categories: [{ id: 'all', label: 'All' }, ...FILTER_CATEGORIES],
    render(cat, q) {
      const clip = selectedVisual();
      shown = clip?.filter?.id ?? null;
      hint.textContent = clip ? 'Click a filter to apply it to the selected clip.' : 'Click a filter to add it to the timeline. Select a clip first to apply it to that clip only.';
      const list = FILTERS.filter((f) => (cat === 'all' || f.cat === cat) && matchesLook(f, q, FILTER_CATEGORIES));
      if (!list.length) return emptyState('search', 'No filters found', 'Try another word.');
      const tiles = list.map((f) => {
        const t = tile({
          label: f.label,
          preview: lookPreview('filter', f.id),
          active: clip?.filter?.id === f.id,
          onAdd: () => actions.addFilter(f.id),
          drag: { kind: 'filter', id: f.id },
          addLabel: clip ? `Apply ${f.label} filter to clip` : `Add ${f.label} filter`,
        });
        hoverAnimate(t, 'filter', f.id);
        return t;
      });
      if (clip?.filter) {
        tiles.unshift(tile({ label: 'None', preview: lookPreview('none', 'none'), onAdd: () => actions.addFilter(null), addLabel: 'Remove filter from clip' }));
      }
      return h('div', hint, tileGrid(tiles, { label: 'Filters' }));
    },
  });
  // An applied, removed or undone filter shows on the tiles; focus stays on the same tile.
  const onChange = () => {
    if (!layout.el.isConnected || (selectedVisual()?.filter?.id ?? null) === shown) return;
    const had = layout.el.contains(document.activeElement) ? document.activeElement : null;
    layout.refresh();
    if (had && !had.isConnected) (layout.el.querySelector(`.tile[aria-label="${CSS.escape(had.getAttribute('aria-label') || '')}"]`) || layout.el.querySelector('.tile'))?.focus();
  };
  const offs = [store.on('select', () => layout.refresh()), store.on('change', onChange)];
  return { el: layout.el, shown: () => layout.refresh(), dispose: () => offs.forEach((f) => f()) };
}
