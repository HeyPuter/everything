import { el } from '../../../ui/dom.js';
import { iconButton } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../../lib/format.js';
import { icon } from './icons.js';
import { swatch } from './catmanager.js';
import { averageRating, isVisited, myTags } from './filter.js';

/** Day id → short label ("Tue, 4 May" or "Day 3"), in day order. */
export function dayLabels(space) {
  return new Map((space.select.day?.all() ?? []).map((day, index) => [day.id,
    day.date ? formatDate(day.date, { weekday: true, year: false }) : t('places.dayN', { n: index + 1 })]));
}

/** Rows are rebuilt only when this changes; selection and hover are class toggles. */
export function rowKey(place, { category, days, selecting, checked, canEdit, draggable, uid }) {
  // Local edits (offline, or before the worker answers) keep `v` and `upd`, so shown fields are part of the key.
  return [place.v, place.upd, place.name, place.address ?? '', place.track ? 1 : 0, category.name, category.color, category.icon, [...days].join(','), selecting, checked, canEdit, draggable,
    JSON.stringify(place.rating ?? null), JSON.stringify(myTags(place, uid)), isVisited(place, uid)].join('|');
}

export function placeRow(place, { category, days, dayLabels: labels, selecting, checked, canEdit, draggable, uid, on }) {
  const { avg, count } = averageRating(place);
  const planned = [...days].filter((id) => labels.has(id)).map((id) => labels.get(id));
  const tags = myTags(place, uid);
  const meta = [
    el('span', {}, category.name),
    planned.length > 0 && el('span.pl-planned', {}, icon('calendar', 13), planned.length > 2 ? t('places.plannedDays', { count: planned.length }) : planned.join(', ')),
    count > 0 && el('span.pl-score', { 'aria-label': t('places.ratingAverageShort', { avg: formatNumber(avg, { digits: 1 }), count }) }, icon('star', 13, { fill: true }), formatNumber(avg, { digits: 1 })),
    isVisited(place, uid) && el('span.pl-visited', { 'aria-label': t('places.visited'), title: t('places.visited') }, icon('visited', 13)),
    place.track && el('span', { 'aria-label': t('places.track'), title: t('places.track') }, icon('track', 13)),
  ].filter(Boolean);
  const main = el('button.pl-main', { type: 'button', 'aria-pressed': selecting ? String(checked) : null,
    onclick: () => (selecting ? on.check(place.id, !checked) : on.open(place.id)) },
  swatch(category),
  el('span.pl-text', {},
    el('span.pl-name', {}, place.name),
    el('span.pl-meta', {}, meta),
    (place.address || tags.length > 0) && el('span.pl-sub', {}, tags.length ? tags.map((tag) => el('span.pl-tag-mini', {}, tag)) : place.address)));
  const row = el('li.pl-row', { dataset: { placeId: place.id } },
    draggable && el('button.pl-grip', { type: 'button', 'data-drag-handle': '', 'aria-label': t('places.dragToDay', { name: place.name }), title: t('places.dragToDay', { name: place.name }),
      onclick: (event) => on.menu(place.id, event.currentTarget, true) }, icon('grip', 16)),
    selecting && el('input.pl-check', { type: 'checkbox', checked, 'aria-label': t('places.selectNamed', { name: place.name }), onchange: (event) => on.check(place.id, event.target.checked) }),
    main,
    iconButton('more', t('places.moreFor', { name: place.name }), { class: 'icon-btn icon-btn-sm pl-row-menu', onclick: (event) => on.menu(place.id, event.currentTarget) }));
  row.addEventListener('pointerenter', () => on.hover(place.id));
  row.addEventListener('pointerleave', () => on.hover(null));
  return row;
}
