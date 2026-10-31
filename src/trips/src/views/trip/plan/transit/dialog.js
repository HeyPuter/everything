import { el, uid, safeURL } from '../../../../ui/dom.js';
import { button, skeleton } from '../../../../ui/bits.js';
import { field, segmented } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDuration, formatTime } from '../../../../lib/format.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { resIssues } from '../../../../lib/res/index.js';
import { transitLinks } from '../../../../lib/route-plan/index.js';
import { browserTimeZone, isTimeZone } from '../../../../shared/dates.js';
import { icon } from '../icons.js';
import { connectionDraft, defaultSearch, isRide, localTime, searchInstant, stopsNeedingZones } from './model.js';

const MODE_ICONS = {
  walk: 'footprints', bike: 'bike', car: 'car', bus: 'bus', coach: 'bus', tram: 'tram-front', subway: 'train-front', rail: 'train-front',
  ferry: 'ship', cable: 'route', air: 'plane', other: 'route',
};
const LATE = 2;
const signed = (value) => new Intl.NumberFormat(displayLocale(), { signDisplay: 'always' }).format(value);
const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));
const point = (place) => [place.lng, place.lat];

/**
 * Public transport between two located visits: connections from the transit service when one is configured,
 * with "Add to bookings" for editors, and maps-app links either way.
 */
export function openTransitDialog({ space, services, from, to, fromPlace, toPlace, entry, info, signal }) {
  let zone = isTimeZone(fromPlace.tz) ? fromPlace.tz : browserTimeZone();
  const initial = defaultSearch({ from, to, day: entry.day, info, now: Date.now(), zone });
  let controller = null;
  let dialog;

  const mode = segmented({
    label: t('transit.when'), value: initial.arriveBy ? 'arrive' : 'depart',
    items: [{ value: 'depart', label: t('transit.depart') }, { value: 'arrive', label: t('transit.arrive') }],
  });
  const date = field({ label: t('transit.date'), type: 'date', value: initial.date });
  const time = field({ label: t('transit.time'), type: 'time', value: initial.time });
  const searchButton = button(t('transit.search'), { variant: 'primary', icon: 'search', onclick: () => { void search(); } });
  const form = el('form.transit-form', { onsubmit: (event) => { event.preventDefault(); void search(); } },
    mode.element, el('div.transit-when', {}, date.element, time.element), searchButton);
  form.hidden = true;
  const results = el('div.transit-results', { 'aria-live': 'polite', 'aria-busy': 'false' });
  const credit = el('p.transit-credit');
  const links = transitLinks(point(fromPlace), point(toPlace));
  const external = el('div.transit-links', {}, el('span.transit-muted', {}, t('transit.openIn')),
    ...[['google', 'transit.google'], ['apple', 'transit.apple']].map(([id, key]) => {
      const href = safeURL(links?.[id]);
      return href ? el('a.transit-link', { href, target: '_blank', rel: 'noopener noreferrer', title: new URL(href).host }, t(key)) : null;
    }));
  const content = el('div.transit-dialog', {}, el('p.transit-route', {}, t('transit.route', { from: fromPlace.name, to: toPlace.name })), form, results, credit, external);
  dialog = openModal({ title: t('transit.title'), content, wide: true, onClose: () => controller?.abort() });
  signal?.addEventListener('abort', () => dialog.close('navigation'), { once: true });

  const zoneReady = isTimeZone(fromPlace.tz) ? Promise.resolve() : services.tz?.zoneAt(fromPlace.lat, fromPlace.lng).then((found) => { if (isTimeZone(found)) zone = found; }, () => {});
  void (async () => {
    let available = false;
    try { available = await services.transit.available(); } catch { /* Treated as unavailable. */ }
    if (!available) { results.replaceChildren(el('p.transit-message', {}, t('transit.unavailable'))); return; }
    form.hidden = false;
    await zoneReady;
    void search();
  })();

  async function search() {
    controller?.abort();
    controller = new AbortController();
    const current = controller;
    const at = searchInstant({ date: date.input.value, time: time.input.value }, zone);
    if (at === null) { time.setError(t('transit.invalidTime')); return; }
    time.setError('');
    results.setAttribute('aria-busy', 'true');
    results.replaceChildren(el('p.sr-only', {}, t('transit.searching')), skeleton(), skeleton('80%'), skeleton('90%'));
    credit.replaceChildren();
    let result;
    try {
      result = await services.transit.plan({ from: fromPlace, to: toPlace, at, arriveBy: mode.value === 'arrive' }, { signal: current.signal });
    } catch (error) {
      if (current.signal.aborted || error?.name === 'AbortError') return;
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren(el('div.transit-message', {}, el('p', {}, t('transit.failed')), button(t('transit.retry'), { size: 'sm', variant: 'outline', onclick: () => { void search(); } })));
      return;
    }
    if (current.signal.aborted) return;
    results.setAttribute('aria-busy', 'false');
    if (!result) {
      const offline = globalThis.navigator?.onLine === false;
      results.replaceChildren(el('div.transit-message', {}, el('p', {}, t(offline ? 'transit.offline' : 'transit.failed')),
        offline ? null : button(t('transit.retry'), { size: 'sm', variant: 'outline', onclick: () => { void search(); } })));
      return;
    }
    render(result);
  }

  function render(result) {
    const { itineraries, direct } = result.data;
    const parts = [];
    if (!itineraries.length) parts.push(el('p.transit-message', {}, t('transit.none')));
    else {
      parts.push(el('p.transit-count', {}, itineraries.length === 1 ? t('transit.countOne') : t('transit.count', { count: itineraries.length })),
        el('ol.transit-list', {}, itineraries.map((itinerary, index) => option(itinerary, index))));
    }
    if (direct) parts.push(el('p.transit-muted', {}, t('transit.walkDirect', { duration: formatDuration(minutes(direct.duration)) })));
    if (result.stale) parts.unshift(el('p.transit-muted', {}, t('transit.saved')));
    results.replaceChildren(...parts);
    credit.replaceChildren(...(result.attribution ?? []).flatMap((item, index) => {
      const href = safeURL(item.url);
      return [index ? ' · ' : t('transit.sourcePrefix'), href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, item.text) : item.text];
    }));
  }

  // Stop times read in the stop's zone when the provider gives one, else in the departure's.
  function timeAt(epoch, base, stop) {
    const local = localTime(epoch, isTimeZone(stop?.tz) ? stop.tz : zone, base);
    return [formatTime(local.time), local.offset ? signed(local.offset) : ''].filter(Boolean).join(' ');
  }

  function badge(leg) {
    const name = isRide(leg) ? leg.route ?? t(`transit.mode.${leg.mode}`) : t('transit.legWalk', { duration: formatDuration(minutes(leg.duration)) });
    return el('span.transit-badge', { dataset: { mode: leg.mode } }, icon(MODE_ICONS[leg.mode] ?? 'route', 14),
      leg.color && isRide(leg) ? el('span.transit-swatch', { 'aria-hidden': 'true', style: { background: leg.color } }) : null,
      el('span', {}, name), isRide(leg) ? el('span.sr-only', {}, ` (${t(`transit.mode.${leg.mode}`)})`) : null);
  }

  function legRow(leg, base) {
    const late = Math.round((leg.start - leg.scheduledStart) / 60_000);
    const status = leg.cancelled ? el('span.transit-late', {}, t('transit.cancelled'))
      : late >= LATE ? el('span.transit-late', {}, t('transit.late', { duration: formatDuration(late) }))
        : leg.realTime ? el('span.transit-live', {}, t('transit.live')) : null;
    if (!isRide(leg)) {
      return el('li.transit-leg.is-walk', {}, el('span.transit-leg-time.num', {}, timeAt(leg.start, base, leg.from)), badge(leg),
        el('span.transit-muted', {}, leg.to.name ? t('transit.walkTo', { name: leg.to.name }) : ''));
    }
    return el('li.transit-leg', {},
      el('span.transit-leg-time.num', {}, timeAt(leg.start, base, leg.from)),
      el('div.transit-leg-body', {},
        el('div.transit-leg-line', {}, badge(leg), leg.headsign ? el('span', {}, t('transit.towards', { headsign: leg.headsign })) : null, status),
        el('p.transit-stop', {}, leg.from.name ?? t('transit.unnamed'), leg.from.track ? ` · ${t('transit.platform', { track: leg.from.track })}` : ''),
        el('p.transit-muted', {}, [leg.stops ? (leg.stops === 1 ? t('transit.stopsOne') : t('transit.stops', { count: leg.stops })) : '', formatDuration(minutes(leg.duration)), leg.agency ?? ''].filter(Boolean).join(' · ')),
        el('p.transit-stop', {}, el('span.num', {}, timeAt(leg.end, base, leg.to)), ' ', leg.to.name ?? t('transit.unnamed'), leg.to.track ? ` · ${t('transit.platform', { track: leg.to.track })}` : '')));
  }

  function option(itinerary, index) {
    const base = date.input.value;
    const detailId = uid('transit-detail');
    const changes = itinerary.transfers === 0 ? t('transit.direct') : itinerary.transfers === 1 ? t('transit.transfersOne') : t('transit.transfers', { count: itinerary.transfers });
    const detail = el('div.transit-detail', { id: detailId, hidden: true },
      el('ol.transit-legs', {}, itinerary.legs.map((leg) => legRow(leg, base))),
      el('div.transit-actions', {}, saveButton(itinerary)));
    const toggle = el('button.transit-summary', { type: 'button', 'aria-expanded': 'false', 'aria-controls': detailId, dataset: { focus: `transit-option:${index}` }, onclick: () => {
      detail.hidden = !detail.hidden;
      toggle.setAttribute('aria-expanded', String(!detail.hidden));
    } },
    el('span.transit-times.num', {}, t('transit.timeRange', { start: timeAt(itinerary.start, base, itinerary.legs[0].from), end: timeAt(itinerary.end, base, itinerary.legs.at(-1).to) })),
    el('span.transit-meta', {}, [formatDuration(minutes(itinerary.duration)), changes, itinerary.walk >= 60 ? t('transit.walkTotal', { duration: formatDuration(minutes(itinerary.walk)) }) : ''].filter(Boolean).join(' · ')),
    el('span.transit-strip', {}, itinerary.legs.filter((leg) => isRide(leg) || leg.duration >= 120).map(badge)));
    return el('li.transit-option', {}, toggle, detail);
  }

  function saveButton(itinerary) {
    if (!space.can('res.edit')) return el('p.transit-muted', {}, t('transit.readOnly'));
    const node = button(t('transit.save'), { size: 'sm', variant: 'primary', icon: 'plus', onclick: async () => {
      node.setAttribute('aria-busy', 'true');
      try {
        const zones = new Map();
        await Promise.all(stopsNeedingZones(itinerary).map(async (stop) => {
          try { zones.set(`${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`, await services.tz.zoneAt(stop.lat, stop.lng)); } catch { /* Falls back to the search zone. */ }
        }));
        const fields = connectionDraft(itinerary, {
          title: t('transit.bookingTitle', { from: fromPlace.name, to: toPlace.name }), zones, zone,
          dayId: entry.day.id, fromOrder: from.order, toOrder: to.dayId === from.dayId ? to.order : null,
        });
        if (resIssues(fields).length) throw new Error('invalid_connection');
        await space.apply([space.ops.create('res', fields)], { history: t('transit.history') });
        dialog.close('saved');
        toast(t('transit.added'), { action: { label: t('transit.undo'), onClick: () => { space.history.undo().catch(() => toast(t('transit.saveFailed'))); } } });
      } catch {
        node.setAttribute('aria-busy', 'false');
        toast(t('transit.saveFailed'));
      }
    } });
    return node;
  }

  return dialog;
}
