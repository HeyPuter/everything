// Saved place details: status, labels, the caller's rating, tags and visited flag, notes, links and actions.
import { el, uid, safeURL, append, clear } from '../../ui/dom.js';
import { button, iconButton } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { markdown } from '../../ui/md.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatMoney, formatNumber } from '../../lib/format.js';
import { spaceRoute, validateSpaceRef } from '../../shared/protocol.js';
import { categoryOf } from '../../lib/categories.js';
import { swatch } from '../trip/places/catmanager.js';
import { starRating, tagEditor } from '../trip/places/controls.js';
import { mapLinks } from '../trip/places/links.js';
import { photoFigure } from '../trip/places/detail.js';
import { icon } from './icons.js';
import { STATUSES, averageRating, isVisitedBy, myTags } from './model.js';
import { colorValue } from './metaform.js';

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const located = (item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng);

/** Per-user writes any member may make. */
export const ratingPatch = (space, id, uid, value) => space.ops.patch('saved', id, value ? { set: { [`rating.${uid}`]: value } } : { unset: [`rating.${uid}`] });
export function tagsPatch(space, id, uid, tags) {
  const seen = new Set();
  const clean = tags.map((tag) => String(tag).replace(/\s+/g, ' ').trim().slice(0, 100)).filter((tag) => tag && !seen.has(tag.toLocaleLowerCase()) && seen.add(tag.toLocaleLowerCase()));
  return space.ops.patch('saved', id, clean.length ? { set: { [`tags.${uid}`]: clean.slice(0, 100) } } : { unset: [`tags.${uid}`] });
}
export const visitedPatch = (space, id, uid, on) => space.ops.patch('saved', id, on ? { set: { [`visited.${uid}`]: true } } : { unset: [`visited.${uid}`] });

export function statusChip(status) {
  return el('span.col-status', { dataset: { status } }, icon({ idea: 'idea', want: 'heart', visited: 'visited', revisit: 'revisit' }[status] ?? 'idea', 14), t(`collections.status.${status}`));
}

function section(title, ...children) {
  const id = uid('col-section');
  return el('section.col-sheet-section', { 'aria-labelledby': id }, el('h3.col-eyebrow', { id }, title), ...children);
}

/**
 * Opens the details of one saved place. `actions` holds `edit(id)`, `addToTrip(id)`, `locate(id)` and `menu(id, anchor)`;
 * `canEdit` gates shared fields. Follows live changes and closes if the place is deleted.
 */
export function openSavedSheet({ space, id, uid: me, canEdit, tagSuggestions = [], actions, onApply }) {
  const body = el('div.col-sheet');
  let dialog = null;
  async function apply(ops) {
    try { await (onApply ? onApply(ops) : space.apply(ops)); } catch { toast(t('collections.saveFailed')); }
  }
  function render() {
    const item = space.get('saved', id);
    if (!item) { dialog?.close('gone'); return; }
    const category = categoryOf(space, item.cat);
    const labels = space.select.label.all();
    const image = item.img?.url && safeURL(item.img.url);
    const web = item.web && safeURL(item.web);
    const visited = isVisitedBy(item, me);
    const avg = averageRating(item);
    const raters = Object.keys(item.rating ?? {}).length;
    const status = canEdit
      ? segmented({ label: t('collections.statusLabel'), radio: true, value: item.status, items: STATUSES.map((value) => ({ value, label: t(`collections.status.${value}`) })),
        onChange: (value) => void apply([space.ops.patch('saved', id, { set: { status: value } })]) }).element
      : statusChip(item.status);
    const labelChips = el('div.col-chips', {}, labels.map((label) => {
      const on = item.labels?.includes(label.id) ?? false;
      return canEdit
        ? el('button.col-label-toggle', { type: 'button', 'aria-pressed': String(on), style: { '--col-color': colorValue(label.color) }, dataset: { focus: `label:${label.id}` },
          onclick: () => { const next = on ? item.labels.filter((value) => value !== label.id) : [...(item.labels ?? []), label.id]; void apply([space.ops.patch('saved', id, next.length ? { set: { labels: next } } : { unset: ['labels'] })]); } },
        el('span.col-dot', { 'aria-hidden': 'true' }), label.name)
        : on && el('span.col-label-chip', { style: { '--col-color': colorValue(label.color) } }, el('span.col-dot', { 'aria-hidden': 'true' }), label.name);
    }));
    const rating = starRating({ value: item.rating?.[me] ?? 0, label: t('collections.ratingYours'), onChange: (value) => void apply([ratingPatch(space, id, me, value)]) });
    const tags = tagEditor({ tags: myTags(item, me), suggestions: tagSuggestions, label: t('collections.tagsYours'), onChange: (list) => void apply([tagsPatch(space, id, me, list)]) });
    let source = null;
    try { if (item.src?.trip) source = `${spaceRoute(validateSpaceRef(item.src.trip))}/plan`; } catch { /* malformed source */ }
    const focusKey = body.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    append(clear(body), [
      el('div.col-sheet-top', {}, swatch(category, 18), el('span.col-sheet-cat', {}, category.name), statusChip(item.status),
        visited && el('span.chip.chip-success', {}, icon('visited', 14), t('collections.visitedByYou'))),
      image ? el('figure.col-figure', {}, el('img', { src: image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', decoding: 'async' }), item.img.credit && el('figcaption.col-hint', {}, item.img.credit))
        : item.img?.fileId ? photoFigure(space, item.img.fileId, 'figure.col-figure') : null,
      (item.address || located(item)) && el('p.col-address', {}, item.address, located(item) && el('span.col-hint.num', {}, `${formatNumber(item.lat, { digits: 5 })}, ${formatNumber(item.lng, { digits: 5 })}`)),
      el('div.col-actions', {},
        canEdit && button(t('collections.edit'), { icon: 'pencil', size: 'sm', variant: 'outline', dataset: { focus: 'edit' }, onclick: () => actions.edit(id) }),
        button(t('collections.addToTrip'), { size: 'sm', variant: 'outline', dataset: { focus: 'trip' }, onclick: () => actions.addToTrip(id) }),
        located(item) && button(t('collections.showOnMap'), { size: 'sm', variant: 'ghost', dataset: { focus: 'locate' }, onclick: () => { dialog.close('locate'); actions.locate(id); } }),
        iconButton('more', t('collections.moreFor', { name: item.name }), { dataset: { focus: 'more' }, onclick: (event) => actions.menu(id, event.currentTarget) })),
      section(t('collections.statusLabel'), status),
      (labels.length > 0 || canEdit) && section(t('collections.labels'), labels.length ? labelChips : el('p.col-hint', {}, t('collections.labelsNone'))),
      section(t('collections.ratingYours'), rating.element, el('p.col-hint', {}, raters ? t('collections.ratingAverage', { avg: formatNumber(avg, { digits: 1 }), count: formatNumber(raters) }) : t('collections.ratingNone'))),
      section(t('collections.tagsYours'), tags.element, el('p.field-hint', {}, t('collections.tagsPrivate'))),
      section(t('collections.visitedTitle'), button(t(visited ? 'collections.visitedYes' : 'collections.visitedNo'), { icon: 'check', size: 'sm', variant: visited ? 'primary' : 'outline', 'aria-pressed': String(visited), dataset: { focus: 'visited' },
        onclick: () => void apply([visitedPatch(space, id, me, !visited)]) })),
      item.desc && section(t('collections.fieldPlaceDesc'), markdown(item.desc)),
      item.notes && section(t('collections.fieldNotes'), markdown(item.notes)),
      (web || item.phone || item.price) && section(t('collections.contact'), el('dl.col-facts', {},
        web && [el('dt', {}, icon('web', 16), t('collections.fieldWeb')), el('dd', {}, el('a', { href: web, target: '_blank', rel: 'noopener noreferrer' }, hostOf(web)))],
        item.phone && [el('dt', {}, t('collections.fieldPhone')), el('dd.num', {}, item.phone)],
        item.price && [el('dt', {}, t('collections.fieldPrice')), el('dd.num', {}, formatMoney(item.price.amount, item.price.currency))])),
      mapLinks(item).length > 0 && section(t('collections.openIn'), el('ul.col-links', {}, mapLinks(item).map((link) => el('li', {},
        el('a.btn.btn-sm.btn-ghost', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), t(`places.openIn.${link.id}`)))))),
      source && el('p.col-hint', {}, el('a', { href: source }, t('collections.fromTrip'))),
    ]);
    if (focusKey) body.querySelector(`[data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
    if (dialog) dialog.panel.querySelector('.modal-title').textContent = item.name;
  }
  render();
  const off = space.subscribe({ type: 'saved', id }, render);
  const offLabels = space.subscribe('label', render);
  dialog = openModal({ title: space.get('saved', id)?.name ?? '', content: body, wide: true, onClose: () => { off(); offLabels(); } });
  return dialog;
}
