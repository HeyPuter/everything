import { el, uid, safeURL } from '../../../ui/dom.js';
import { button, iconButton } from '../../../ui/bits.js';
import { markdown } from '../../../ui/md.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatMoney, formatNumber, formatDate } from '../../../lib/format.js';
import { icon } from './icons.js';
import { categoryOf } from '../../../lib/categories.js';
import { swatch } from './catmanager.js';
import { averageRating, coordText as coords, hasLocation, isVisited, myRating, myTags, plannedDays } from './filter.js';
import { starRating, tagEditor } from './controls.js';
import { mapLinks } from './links.js';
import { hasFileLink } from '../../../shared/file-links.js';
import { cachedFileUrl, fileUrl } from '../../../lib/files/index.js';

const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('places.copied')); } catch { toast(t('places.copyFailed')); }
}

/** A figure for an uploaded photo (a space file); it removes itself when the file cannot be loaded. */
export function photoFigure(space, fileId, tag) {
  const img = el('img', { alt: '', decoding: 'async' });
  const figure = el(tag, {}, img);
  const known = cachedFileUrl(space, fileId);
  if (known) img.src = known;
  else fileUrl(space, fileId).then((url) => { if (url) img.src = url; else figure.remove(); }, () => figure.remove());
  return figure;
}

function section(title, ...children) {
  const id = uid('pl-section');
  return el('section.pl-detail-section', { 'aria-labelledby': id }, el('h3.pl-eyebrow', { id }, title), ...children);
}

/**
 * The place detail view inside the pane. `on` holds the actions: back, edit, remove, locate, addToDay(anchor),
 * rate(value), tags(list), visited(bool), openDay(dayId), and attach() and expense() when allowed (else null). `details` is
 * the enrichment section's element, kept across renders.
 */
export function renderDetail({ place, space, uid: me, canEdit, dayLabels, visitsByPlace, tagSuggestions, details, on }) {
  const category = categoryOf(space, place.cat);
  const located = hasLocation(place);
  const { avg, count } = averageRating(place);
  const visited = isVisited(place, me);
  const days = [...plannedDays(place.id, visitsByPlace)].filter((id) => dayLabels.has(id));
  const heading = el('h2.pl-detail-title', { tabIndex: -1 }, place.name);
  const more = canEdit && iconButton('more', t('places.moreFor', { name: place.name }), { onclick: (event) => openMenu(event.currentTarget, [
    { label: t('places.edit'), icon: 'pencil', onSelect: on.edit },
    { label: t('places.copyCoordinates'), icon: 'copy', disabled: !located, onSelect: () => copy(coords(place)) },
    { separator: true },
    { label: t('places.delete'), icon: 'trash', danger: true, onSelect: on.remove },
  ]) });
  const image = place.img?.url && safeURL(place.img.url);
  const web = place.web && safeURL(place.web);
  const files = (space.select.file?.all() ?? []).filter((file) => !file.trashed && hasFileLink(file, { t: 'place', id: place.id }));
  const expenses = (space.select.exp?.all() ?? []).filter((exp) => exp.links?.some((link) => link.t === 'place' && link.id === place.id));
  const editor = place.upd ? space.members?.().find((member) => member.uid === place.by) : null;
  const edited = place.upd ? formatDate(new Date(place.upd).toISOString().slice(0, 10)) : '';

  const rating = starRating({ value: myRating(place, me), label: t('places.ratingYours'), onChange: on.rate });
  const tags = tagEditor({ tags: myTags(place, me), suggestions: tagSuggestions, label: t('places.tagsYours'), onChange: on.tags });
  const visitedButton = button(t('places.visited'), { icon: 'visited', size: 'sm', variant: visited ? 'primary' : 'outline',
    'aria-pressed': String(visited), onclick: () => on.visited(!visited) });

  const element = el('article.pl-detail', { 'aria-label': place.name },
    el('header.pl-detail-head', {}, iconButton('arrowLeft', t('places.back'), { onclick: on.back }), heading, more),
    image ? el('figure.pl-figure', {}, el('img', { src: image, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', decoding: 'async' }),
      place.img.credit && el('figcaption.pl-muted', {}, place.img.credit)) : place.img?.fileId ? photoFigure(space, place.img.fileId, 'figure.pl-figure') : null,
    el('div.pl-chips', {},
      el('span.chip.pl-cat-chip', {}, swatch(category, 14), category.name),
      visited && el('span.chip.chip-success', {}, icon('visited', 14), t('places.visited')),
      place.track && el('span.chip', {}, icon('track', 14), place.track.km ? t('places.trackKm', { km: formatNumber(place.track.km, { digits: 1 }) }) : t('places.track'))),
    (place.address || located) && el('div.pl-address', {},
      place.address && el('p', {}, place.address),
      located && el('p.pl-muted.num', {}, coords(place), ' ', iconButton('copy', t('places.copyCoordinates'), { class: 'icon-btn icon-btn-sm', onclick: () => copy(coords(place)) }))),
    el('div.pl-actions', {},
      located && button(t('places.showOnMap'), { icon: 'locate', size: 'sm', variant: 'outline', onclick: on.locate }),
      canEdit && dayLabels.size > 0 && button(t('places.addToDay'), { icon: 'addDay', size: 'sm', variant: 'outline', onclick: (event) => on.addToDay(event.currentTarget) }),
      canEdit && button(t('places.edit'), { icon: 'pencil', size: 'sm', variant: 'ghost', onclick: on.edit }),
      visitedButton),
    section(t('places.rating'), rating.element,
      el('p.pl-muted', {}, count ? t('places.ratingAverage', { avg: formatNumber(avg, { digits: 1 }), count }) : t('places.ratingNone'))),
    section(t('places.tagsYours'), tags.element, el('p.field-hint', {}, t('places.tagsPrivate'))),
    place.desc && section(t('places.fieldDesc'), markdown(place.desc)),
    place.notes && section(t('places.fieldNotes'), markdown(place.notes)),
    details,
    (web || place.phone || place.price) && section(t('places.contact'), el('dl.pl-facts', {},
      web && [el('dt', {}, icon('web', 16), t('places.fieldWeb')), el('dd', {}, el('a', { href: web, target: '_blank', rel: 'noopener noreferrer' }, hostOf(web)))],
      place.phone && [el('dt', {}, icon('phone', 16), t('places.fieldPhone')), el('dd', {}, el('span.num', {}, place.phone), iconButton('copy', t('places.copyPhone'), { class: 'icon-btn icon-btn-sm', onclick: () => copy(place.phone) }))],
      place.price && [el('dt', {}, icon('price', 16), t('places.fieldPrice')), el('dd.num', {}, formatMoney(place.price.amount, place.price.currency))])),
    section(t('places.plannedOn'), days.length
      ? el('ul.pl-day-list', {}, days.map((id) => el('li', {}, button(dayLabels.get(id), { size: 'sm', variant: 'ghost', icon: 'calendar', onclick: () => on.openDay(id) }))))
      : el('p.pl-muted', {}, t('places.notPlanned'))),
    mapLinks(place).length > 0 && section(t('places.openIn'), el('ul.pl-links', {}, mapLinks(place).map((link) => el('li', {},
      el('a.btn.btn-sm.btn-ghost', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 16), t(`places.openIn.${link.id}`)))))),
    (files.length > 0 || expenses.length > 0 || on.attach || on.expense) && section(t('places.linked'),
      files.length + expenses.length > 0 && el('ul.pl-linked', {},
        files.map((file) => el('li', {}, icon('attach', 16), el('span', {}, file.name))),
        expenses.map((exp) => el('li', {}, icon('receipt', 16), el('span', {}, exp.name), el('span.num.pl-muted', {}, formatMoney(exp.amount, exp.currency))))),
      (on.attach || on.expense) && el('div.pl-actions', {},
        on.attach && button(t('places.attachFiles'), { icon: 'attach', size: 'sm', variant: 'outline', onclick: on.attach }),
        on.expense && button(t('places.createExpense'), { icon: 'receipt', size: 'sm', variant: 'outline', onclick: on.expense }))),
    edited && el('footer.pl-muted.pl-byline', {}, editor ? t('places.editedBy', { name: editor.name, date: edited }) : t('places.editedOn', { date: edited })),
  );
  return { element, heading, rating, tags };
}
