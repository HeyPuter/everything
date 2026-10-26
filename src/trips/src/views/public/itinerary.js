import { el, safeURL, uid } from '../../ui/dom.js';
import { chip } from '../../ui/bits.js';
import { markdown } from '../../ui/md.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../lib/format.js';
import { buildTimeline, phaseLabelKey } from '../../lib/timeline/index.js';
import { icon, RES_ICONS } from '../trip/plan/icons.js';
import { attachments } from './files.js';

function timeText(row) {
  const start = formatTime(row.time);
  const end = formatTime(row.end);
  if (start && end) return t('plan.timeRange', { start, end });
  return start || (end ? t('plan.until', { time: end }) : '');
}

/** An external link that shows its host; http(s) only. */
export function webLink(value) {
  const href = safeURL(value);
  if (!href) return null;
  return el('a.public-web', { href, target: '_blank', rel: 'noopener noreferrer' }, icon('compass', 14), el('span', { dir: 'ltr' }, new URL(href).host));
}

/**
 * Days with their merged timelines (visits, day notes, bookings and stays), then places not on any day.
 * `ctx` is `{space, people, filesFor, files, onLocate}`.
 */
export function renderItinerary(ctx) {
  const { space } = ctx;
  const days = space.select.day.all();
  const timeline = buildTimeline({ days, visits: space.select.visit.all(), notes: space.select.dayNote.all(), reservations: space.select.res.all() });
  const scheduled = new Set(space.select.visit.all().map((visit) => visit.placeId).filter(Boolean));
  const root = el('div.public-itinerary');
  if (!timeline.days.length) root.append(el('p.public-empty', {}, t('public.daysEmpty')));
  for (const entry of timeline.days) root.append(dayCard(entry, ctx));
  const loose = space.select.place.all().filter((place) => !scheduled.has(place.id));
  if (loose.length) {
    const headingId = uid('public-places');
    root.append(el('section.public-card', { 'aria-labelledby': headingId },
      el('h3.public-card-title', { id: headingId }, t('public.otherPlaces')),
      el('ul.public-rows', {}, loose.map((place) => el('li.public-row', { dataset: { place: place.id } }, el('span.public-bullet', { 'aria-hidden': 'true' }, icon('map-pin', 15)),
        el('div.public-row-body', {}, el('span.public-row-title', {}, place.name), placeDetails(place, ctx)))))));
  }
  return root;
}

function placeDetails(place, ctx) {
  const parts = [];
  if (place.address) parts.push(el('span.public-sub', {}, place.address));
  const category = place.cat ? ctx.space.get('cat', place.cat)?.name : null;
  if (category) parts.push(el('span.public-sub', {}, category));
  const link = webLink(place.web);
  if (link) parts.push(link);
  if (ctx.onLocate && Number.isFinite(place.lat)) {
    parts.push(el('button.public-link', { type: 'button', onclick: () => ctx.onLocate({ t: 'place', id: place.id }) }, t('public.showOnMap')));
  }
  const body = [parts.length ? el('span.public-row-meta', {}, parts) : null];
  if (place.desc) body.push(el('p.public-notes', {}, place.desc.slice(0, 400)));
  body.push(attachments(ctx.files, ctx.filesFor(`place:${place.id}`)));
  return body;
}

function dayCard(entry, ctx) {
  const { day } = entry;
  const headingId = uid('public-day');
  const label = t('plan.dayNumber', { number: entry.number });
  const stays = entry.stays.filter((stay) => stay.res.status !== 'cancelled').map((stay) => el('p.public-stay', {}, icon('bed-double', 14),
    el('span', {}, t(phaseLabelKey('stay', stay.phase))), el('strong', {}, stay.res.title),
    stay.phase === 'checkin' && stay.res.stay?.checkInFrom && el('span.num', {}, formatTime(stay.res.stay.checkInFrom)),
    stay.phase === 'checkout' && stay.res.stay?.checkOut && el('span.num', {}, formatTime(stay.res.stay.checkOut))));
  const list = el('ol.public-rows', { 'aria-label': t('plan.dayItems', { day: label }) }, entry.rows.map((row) => rowNode(row, ctx)));
  if (!entry.rows.length) list.append(el('li.public-row-empty', {}, t('plan.dayEmpty')));
  return el('section.public-card.public-day', { style: { '--day-color': `var(--day-${entry.color})` }, 'aria-labelledby': headingId },
    el('h3.public-day-head', { id: headingId }, el('span.public-day-num', {}, label),
      entry.date && el('span.public-day-date', {}, formatDate(entry.date, { weekday: true, year: false })),
      day.title && el('span.public-day-name', {}, day.title)),
    day.notes && el('div.public-day-notes', {}, markdown(day.notes)),
    stays, list);
}

function rowNode(row, ctx) {
  const { space } = ctx;
  const meta = [];
  const time = timeText(row);
  if (time) meta.push(el('span.public-time.num', {}, time));
  if (row.phase && row.family) meta.push(el('span.public-phase', {}, t(row.kind === 'visit' ? phaseLabelKey('visit', row.phase) : phaseLabelKey(row.family, row.phase))));
  let lead; let title; let body = [];
  if (row.kind === 'visit') {
    const place = row.entity.placeId ? space.get('place', row.entity.placeId) : null;
    title = place?.name ?? row.entity.title ?? t('plan.untitled');
    lead = el('span.public-bullet', { 'aria-hidden': 'true' }, icon(place ? 'map-pin' : 'list-plus', 15));
    const who = (row.entity.people ?? []).map(ctx.people).filter(Boolean);
    if (who.length && row.primary) meta.push(el('span.public-sub', {}, who.join(', ')));
    if (row.primary) {
      if (place) body = placeDetails(place, ctx);
      if (row.entity.notes) body.push(el('p.public-notes', {}, row.entity.notes.slice(0, 400)));
      body.push(attachments(ctx.files, ctx.filesFor(`visit:${row.id}`)));
    }
  } else if (row.kind === 'note') {
    title = row.entity.title;
    const color = Number.isInteger(row.entity.color) ? `var(--day-${row.entity.color})` : null;
    lead = el('span.public-bullet', { 'aria-hidden': 'true', style: color ? { color } : {} }, icon(row.entity.icon ?? 'sticky-note', 15));
    if (row.entity.text) body.push(el('div.public-notes', {}, markdown(row.entity.text)));
  } else {
    const res = row.entity;
    title = res.title;
    lead = el('span.public-bullet', { 'aria-hidden': 'true' }, icon(RES_ICONS[res.type] ?? 'bookmark', 15));
    if (row.leg !== null) {
      const leg = res.legs?.[row.leg];
      const route = [leg?.from?.code || leg?.from?.name, leg?.to?.code || leg?.to?.name].filter(Boolean).join(' → ');
      if (route) meta.push(el('span.public-sub', {}, route));
    }
    if (res.status !== 'confirmed') meta.push(chip(t(`plan.status.${res.status}`), { status: res.status === 'cancelled' ? '' : 'warn' }));
  }
  const placeId = row.kind === 'visit' && row.primary ? row.entity.placeId : null;
  const node = el('li.public-row', { dataset: { kind: row.kind, ...(placeId ? { place: placeId } : {}) } }, lead,
    el('div.public-row-body', {}, el('span.public-row-title', {}, title), meta.length && el('span.public-row-meta', {}, meta), body));
  if (row.kind === 'res' && row.entity.status === 'cancelled') node.classList.add('is-cancelled');
  return node;
}
