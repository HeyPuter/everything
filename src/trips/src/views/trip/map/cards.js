import { el, safeURL } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { t } from '../../../lib/i18n/index.js';
import { formatNumber } from '../../../lib/format.js';
import { icon } from './icons.js';

const closeButton = (onClose) => el('button.icon-btn.icon-btn-sm', { type: 'button', 'aria-label': t('planMap.closeCard'), title: t('planMap.closeCard'), onclick: onClose }, icon('dismiss', 16));
const rating = (value) => value && el('span.planmap-rating', { 'aria-label': t('planMap.ratingLabel', { value: formatNumber(value.average, { digits: 1 }), count: value.count }) },
  icon('star', 14), formatNumber(value.average, { digits: 1 }), el('span.planmap-muted', {}, `(${formatNumber(value.count, { digits: 0 })})`));

/** External links row; `links` are `{label, url}` built by route-plan (https, or the CoMaps app scheme). */
export function linkRow(links) {
  const items = links.filter((link) => link?.url);
  if (!items.length) return null;
  return el('div.planmap-links', { role: 'group', 'aria-label': t('planMap.openIn') }, el('span.planmap-muted', {}, t('planMap.openIn')),
    ...items.map((link) => el('a.planmap-link', { href: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.label, icon('external', 13))));
}

/** Card for a trip place. */
export function placeCard({ place, category, ratingValue, stop, actions = [], links = [], transit = [], onClose }) {
  const photo = place.img?.url ? safeURL(place.img.url) : null;
  return el('section.planmap-card', { 'aria-label': place.name ?? t('planMap.unnamedPlace') },
    photo && el('img.planmap-card-photo', { src: photo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' }),
    el('div.planmap-card-head', {},
      el('div.planmap-card-title', {},
        el('h2', {}, place.name || t('planMap.unnamedPlace')),
        el('div.planmap-card-meta', {},
          stop && el('span.chip.chip-accent', {}, t('planMap.stopN', { n: stop })),
          category?.label && el('span.chip', {}, category.label),
          rating(ratingValue))),
      closeButton(onClose)),
    place.address && el('p.planmap-card-address', {}, place.address),
    actions.length > 0 && el('div.planmap-card-actions', {}, ...actions.map((action) => button(action.label, { size: 'sm', variant: action.primary ? 'primary' : '', icon: action.icon, onclick: action.onClick }))),
    linkRow(links),
    transit.length > 0 && el('div.planmap-transit', {}, el('span.planmap-muted', {}, t('planMap.transitFromPrevious')), linkRow(transit)));
}

/** Card for a searched, explored or clicked location. `loading` shows while the address is looked up. */
export function locationCard({ title, address, source, loading = false, canAdd, onAdd, links = [], onClose }) {
  return el('section.planmap-card', { 'aria-label': title || t('planMap.droppedPin'), 'aria-busy': loading ? 'true' : 'false' },
    el('div.planmap-card-head', {},
      el('div.planmap-card-title', {},
        el('h2', {}, title || t('planMap.droppedPin')),
        source && el('div.planmap-card-meta', {}, el('span.planmap-muted', {}, source))),
      closeButton(onClose)),
    loading ? el('p.planmap-card-address.planmap-muted', {}, t('planMap.lookingUp')) : address && el('p.planmap-card-address', {}, address),
    canAdd && el('div.planmap-card-actions', {}, button(t('planMap.addPlace'), { size: 'sm', variant: 'primary', icon: 'plus', onclick: onAdd })),
    linkRow(links));
}

/** Pointer tooltip for a hovered marker. */
export function tooltip({ title, subtitle, ratingValue }) {
  return el('div.planmap-tip', { role: 'tooltip' }, el('strong', {}, title || t('planMap.unnamedPlace')), subtitle && el('span', {}, subtitle), rating(ratingValue));
}

/** Optimize proposal with Apply and Cancel. */
export function proposalPanel({ saved, before, after, onApply, onCancel, busy = false }) {
  return el('section.planmap-card.planmap-proposal', { 'aria-label': t('planMap.optimizeTitle') },
    el('div.planmap-card-head', {}, el('div.planmap-card-title', {}, el('h2', {}, t('planMap.optimizeTitle')),
      el('p.planmap-card-address', {}, t('planMap.optimizeSaves', { saved, before, after })),
      el('p.planmap-muted.planmap-small', {}, t('planMap.optimizeNote'))), closeButton(onCancel)),
    el('div.planmap-card-actions', {},
      button(t('planMap.applyOrder'), { size: 'sm', variant: 'primary', busy, onclick: onApply }),
      button(t('planMap.cancel'), { size: 'sm', onclick: onCancel })));
}
