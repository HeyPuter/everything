import { el, uid } from '../../ui/dom.js';
import { chip } from '../../ui/bits.js';
import { markdown } from '../../ui/md.js';
import { t } from '../../lib/i18n/index.js';
import { compareRes, isTransport } from '../../lib/res/index.js';
import { legDetails, legDurationText, legRoute, legTimes, showZones, statusLabel, typeLabel, whenText } from '../trip/bookings/display.js';
import { icon, RES_ICONS } from '../trip/plan/icons.js';
import { attachments } from './files.js';
import { webLink } from './itinerary.js';

function resCard(res, ctx) {
  const meta = [el('span.public-sub', {}, typeLabel(res.type))];
  const when = whenText(res);
  if (when) meta.push(el('span.public-time.num', {}, when));
  if (res.status !== 'confirmed') meta.push(chip(statusLabel(res.status), { status: res.status === 'cancelled' ? '' : 'warn' }));
  const details = [];
  if (isTransport(res.type) && res.legs?.length) {
    const zone = showZones(res);
    details.push(el('ol.public-legs', {}, res.legs.map((leg) => el('li', {},
      el('span.public-leg-route', {}, legRoute(leg)),
      el('span.public-sub.num', {}, [legTimes(leg, { zone }), legDurationText(leg)].filter(Boolean).join(' · ')),
      legDetails(leg, res.type).length > 0 && el('span.public-sub', {}, legDetails(leg, res.type).join(' · '))))));
  }
  const place = res.location?.name || res.location?.address;
  if (place) details.push(el('p.public-sub', {}, [res.location.name, res.location.address].filter(Boolean).join(' · ')));
  if (res.code) details.push(el('p.public-code', {}, t('bookings.labelValue', { label: t('bookings.field.code'), value: res.code })));
  const who = (res.people ?? []).map(ctx.people).filter(Boolean);
  if (who.length) details.push(el('p.public-sub', {}, t('public.travelersList', { names: who.join(', ') })));
  if (res.notes) details.push(el('div.public-notes', {}, markdown(res.notes)));
  const link = webLink(res.url);
  if (link) details.push(el('p', {}, link));
  details.push(attachments(ctx.files, ctx.filesFor(`res:${res.id}`)));
  const node = el('li.public-row', { dataset: { kind: 'res' } }, el('span.public-bullet', { 'aria-hidden': 'true' }, icon(RES_ICONS[res.type] ?? 'bookmark', 15)),
    el('div.public-row-body', {}, el('span.public-row-title', {}, res.title), el('span.public-row-meta', {}, meta), details));
  if (res.status === 'cancelled') node.classList.add('is-cancelled');
  return node;
}

/** Transport, then stays and bookings, each sorted by start. */
export function renderBookings(ctx) {
  const all = [...ctx.space.select.res.all()].sort(compareRes);
  if (!all.length) return el('p.public-empty', {}, t('public.bookingsEmpty'));
  const groups = [
    ['bookings.groupTransport', all.filter((res) => isTransport(res.type))],
    ['bookings.groupBooking', all.filter((res) => !isTransport(res.type))],
  ].filter(([, list]) => list.length);
  return el('div.public-bookings', {}, groups.map(([key, list]) => {
    const headingId = uid('public-res');
    return el('section.public-card', { 'aria-labelledby': headingId }, el('h3.public-card-title', { id: headingId }, t(key)),
      el('ul.public-rows', {}, list.map((res) => resCard(res, ctx))));
  }));
}
