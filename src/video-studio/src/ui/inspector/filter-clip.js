/**
 * Filters: the filter applied to a video or image clip (picked in the
 * Filters tab, tuned here) and filter clips on their own track.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { FILTERS, FILTER_CATEGORIES } from '../../model/catalog.js';
import { slider, propSection, row, uidFor, keepFocus } from './common.js';

const filterLabel = (id) => FILTERS.find((f) => f.id === id)?.label || 'Filter';

/** Section in Video > Basic showing the clip's own filter. */
export function appliedFilterSection(view) {
  const body = h('div.applied-filter');
  const name = h('span.applied-filter-name');
  const remove = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Remove filter', 'data-tip': 'Remove filter' }, icon('trash', 14));
  // The row hides once the filter is gone; focus goes to Browse filters.
  remove.addEventListener('click', () => keepFocus(() => view.actions.addFilter(null, { toClip: view.clip }), () => browse));
  const browse = h('button.btn.small', { type: 'button' }, icon('filters', 14), 'Browse filters');
  browse.addEventListener('click', () => {
    view.ctx.assets?.show?.('filters');
    announce('Filters tab opened. Pick a filter to apply it to the selected clip.');
  });
  const intensity = slider(view, {
    label: 'Intensity',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => Math.round(c.filter?.intensity ?? 100),
    set: (v, final) => view.edit('Filter intensity', (c) => {
      if (!c.filter) return false;
      c.filter.intensity = v;
    }, { key: 'filter-intensity', final }),
  });
  const headRow = h('div.applied-filter-head', icon('filters', 14), name, remove);
  const none = h('div.applied-filter-none', h('span.muted', 'No filter'), browse);
  const render = () => {
    const f = view.clip?.filter;
    headRow.hidden = !f;
    intensity.el.hidden = !f;
    none.hidden = Boolean(f);
    if (f) name.textContent = filterLabel(f.id);
  };
  body.append(headRow, intensity.el, none);
  render();
  view.bind(render);
  return propSection('Filter', body);
}

/** Native select with category groups. */
export function groupedSelect({ label, groups, items, value, onChange }) {
  const id = uidFor('sel');
  const sel = h('select.select', { id },
    groups.map((g) => h('optgroup', { label: g.label }, items.filter((i) => i.cat === g.id).map((i) => h('option', { value: i.id, selected: i.id === value }, i.label)))),
  );
  sel.addEventListener('change', () => onChange(sel.value));
  return { el: row(label, sel, { id }), select: sel };
}

/** Details for a filter clip (a filter on its own track). */
export function filterClipTab(view) {
  const pick = groupedSelect({
    label: 'Filter',
    groups: FILTER_CATEGORIES,
    items: FILTERS,
    value: view.clip.filter,
    onChange: (v) => view.edit('Change filter', (c) => {
      // Keep a custom name; follow the filter when the name is the old label.
      if (!c.name || c.name === filterLabel(c.filter)) c.name = filterLabel(v);
      c.filter = v;
    }),
  });
  const intensity = slider(view, {
    label: 'Intensity',
    min: 0,
    max: 100,
    unit: '%',
    get: (c) => Math.round(c.intensity),
    set: (v, final) => view.edit('Filter intensity', (c) => {
      c.intensity = v;
    }, { key: 'intensity', final }),
  });
  view.bind(() => {
    const c = view.clip;
    if (c && pick.select.value !== c.filter && document.activeElement !== pick.select) pick.select.value = c.filter;
  });
  return h('div', propSection('Filter', [pick.el, intensity.el], {
    onReset: () => view.edit('Reset filter', (c) => {
      c.intensity = 100;
    }),
  }));
}
