import './status.css';
import { el, safeURL } from '../../../../ui/dom.js';
import { button } from '../../../../ui/bits.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate, formatDuration, formatTime } from '../../../../lib/format.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { pointZoneLabel } from '../../../../lib/res/index.js';
import { createServices } from '../../../../services/index.js';
import { createFlightKeyStore } from '../../../../services/flights.js';
import { describeFlight, pickFlight, statusQuery, statusWindow, visibleChanges } from './model.js';
import { createStatusStore } from './store.js';

const SETTINGS = '#/settings/flight-status';
const ERRORS = {
  key_rejected: 'flightStatus.keyRejected', quota: 'flightStatus.quota', invalid: 'flightStatus.invalid', no_key: 'flightStatus.noKey',
  offline: 'flightStatus.offline', unavailable: 'flightStatus.unavailable',
};

const titled = (res, leg) => res.legs.length > 1 || Boolean(leg.number);
const labelText = ({ key, values = {} }) => t(key, Number.isFinite(values.duration) ? { ...values, duration: formatDuration(values.duration) } : values);
const signed = (value) => new Intl.NumberFormat(displayLocale(), { signDisplay: 'always' }).format(value);

function services(context) {
  if (context.session?.services) return context.session.services;
  try { return context.account?.uuid ? createServices({ userId: context.account.uuid }) : null; } catch { return null; }
}

/**
 * Live status for flight legs in the bookings tab: `chip(res, legIndex)` for list rows and `details(res)` for the
 * details dialog. Nodes update in place as answers arrive; disconnected ones are dropped on the next update.
 */
export function createFlightStatus(context) {
  const flights = services(context)?.flights;
  if (!flights || !context.puter?.kv) return { chip: () => null, details: () => null, destroy() {} };
  const now = () => Date.now();
  const keys = createFlightKeyStore(context.puter);
  const store = createStatusStore({ flights, keys, account: context.account?.uuid ?? '' });
  const nodes = new Set();
  const repaint = () => {
    for (const item of [...nodes]) {
      if (!item.node.isConnected) { nodes.delete(item); continue; }
      item.paint();
    }
  };
  const off = store.subscribe(repaint);

  function track(node, paint) {
    const item = { node, paint };
    nodes.add(item);
    paint();
    return node;
  }

  function current(res, index) {
    const leg = res.legs?.[index];
    const query = statusQuery(leg);
    if (!query) return { leg, query: null, entry: null, flight: null, view: null };
    const entry = store.get(query);
    const list = entry?.result?.data?.flights ?? null;
    const flight = list ? pickFlight(list, leg) : null;
    return { leg, query, entry, list, flight, view: flight ? describeFlight(flight, leg) : null };
  }

  function chipContent(res, index) {
    const { query, flight, view } = current(res, index);
    if (!view) return [];
    const changes = visibleChanges(store.seen(query, flight), view);
    const gate = changes.depGate?.to;
    const text = [labelText(view.label), gate && t('flightStatus.gateChanged', { gate })].filter(Boolean).join(' · ');
    const tone = gate && !view.tone ? 'warn' : view.tone;
    return [el(`span.chip.fstatus-chip${tone ? `.is-${tone}` : ''}`, {}, el('span.sr-only', {}, t('flightStatus.srPrefix')), text)];
  }

  function timeText(point) {
    if (!point) return '';
    return [formatTime(point.time), pointZoneLabel(point, displayLocale())].filter(Boolean).join(' ');
  }

  function sideRows(side, prefix, changes) {
    if (!side) return [];
    const rows = [];
    const add = (label, ...value) => { if (value.some((part) => part)) rows.push(el('dt', {}, label), el('dd', {}, ...value)); };
    const kindKey = { actual: 'flightStatus.actualTime', revised: 'flightStatus.revisedTime', predicted: 'flightStatus.predictedTime' }[side.kind];
    const moved = side.current && side.scheduled && (side.current.time !== side.scheduled.time || side.current.date !== side.scheduled.date);
    add(t('flightStatus.scheduledTime'), el(moved ? 's.fstatus-old' : 'span', {}, timeText(side.scheduled)),
      side.scheduled && side.retimed ? el('span.fstatus-note', {}, t('flightStatus.retimed', { booked: formatTime(side.retimed.booked.time) })) : null);
    if (kindKey && side.current) {
      const late = side.delay !== null && side.delay !== 0 ? t(side.delay > 0 ? 'flightStatus.lateBy' : 'flightStatus.ahead', { duration: formatDuration(Math.abs(side.delay)) }) : '';
      add(t(kindKey), el('strong', {}, timeText(side.current)), side.shift ? el('span.fstatus-shift', {}, signed(side.shift)) : null, late ? el('span.fstatus-note', {}, late) : null);
    }
    const field = (name, value) => {
      const change = changes[`${prefix}${name[0].toUpperCase()}${name.slice(1)}`] ?? (prefix === 'arr' && name === 'belt' ? changes.belt : null);
      if (!value) return null;
      return change ? el('span', {}, el('strong', {}, value), ' ', el('span.fstatus-note', {}, t('flightStatus.was', { previous: change.from }))) : value;
    };
    add(t('flightStatus.terminal'), field('terminal', side.terminal));
    add(t('flightStatus.gate'), field('gate', side.gate));
    if (prefix === 'dep') add(t('flightStatus.checkInDesk'), side.checkIn);
    if (prefix === 'arr') add(t('flightStatus.belt'), field('belt', side.belt));
    return rows;
  }

  function message(key, values, ...extra) { return el('div.fstatus-message', {}, el('p', {}, t(key, values)), ...extra); }
  function retry(query, labelKey = 'flightStatus.retry') {
    return button(t(labelKey), { size: 'sm', variant: 'outline', onclick: () => store.ensure(query, { force: true }) });
  }
  const settingsLink = () => el('a.fstatus-link', { href: SETTINGS }, t('flightStatus.openSettings'));

  function legBody(res, index) {
    const { leg, query, entry, list, flight, view } = current(res, index);
    if (!leg) return [];
    if (!query) return [message(leg.dep?.date ? 'flightStatus.noDesignator' : 'flightStatus.noDate')];
    const timing = statusWindow(leg, now());
    if (!entry || entry.state === 'idle') {
      if (timing === 'early') return [message('flightStatus.notYet', {}, retry(query, 'flightStatus.checkNow'))];
      if (timing === 'past') return [message('flightStatus.past', {}, retry(query, 'flightStatus.checkNow'))];
      return [message('flightStatus.loading')];
    }
    if (entry.state === 'loading') return [el('p.fstatus-message', { role: 'status' }, t('flightStatus.loading'))];
    if (entry.state === 'nokey') return [message('flightStatus.noKey', {}, settingsLink())];
    if (entry.state === 'unconfigured') return [message('flightStatus.unconfigured')];
    if (entry.state === 'offline') return [message('flightStatus.offline', {}, retry(query))];
    if (entry.state === 'unavailable' || entry.state === 'error') {
      const key = ERRORS[entry.code] ?? 'flightStatus.unavailable';
      return [message(key, {}, entry.code === 'key_rejected' || entry.code === 'no_key' ? settingsLink() : retry(query))];
    }
    if (!list?.length) return [message('flightStatus.notFound', { flight: query.number, date: formatDate(query.date) })];
    if (!flight) return [message('flightStatus.ambiguous', { flight: query.number })];
    const changes = visibleChanges(store.seen(query, flight), view);
    const result = entry.result;
    const updated = Number.isFinite(flight.updatedAt) ? flight.updatedAt : result.data.fetchedAt;
    const ago = Number.isFinite(updated) ? relative(updated) : '';
    const notes = [
      result.stale || entry.offline ? t('flightStatus.saved') : null,
      entry.code && entry.code !== 'offline' ? t(ERRORS[entry.code] ?? 'flightStatus.unavailable') : null,
    ].filter(Boolean);
    const source = result.attribution?.[0];
    const href = safeURL(source?.url);
    // Under the dialog's h2: leg titles are h3, so side headings are h4, or h3 when the leg has no title.
    const sideHeading = titled(res, leg) ? 'h4' : 'h3';
    return [
      el('div.fstatus-head', {}, ...chipContent(res, index), flight.aircraft ? el('span.fstatus-note', {}, t('flightStatus.aircraftValue', { model: flight.aircraft })) : null),
      el('div.fstatus-sides', {},
        el('section.fstatus-side', {}, el(`${sideHeading}.fstatus-side-title`, {}, t('flightStatus.departure'), view.dep?.airport ? ` · ${view.dep.airport}` : ''), el('dl.fstatus-dl', {}, sideRows(view.dep, 'dep', changes))),
        el('section.fstatus-side', {}, el(`${sideHeading}.fstatus-side-title`, {}, t('flightStatus.arrival'), view.arr?.airport ? ` · ${view.arr.airport}` : ''), el('dl.fstatus-dl', {}, sideRows(view.arr, 'arr', changes)))),
      ...notes.map((note) => el('p.fstatus-note', {}, note)),
      el('p.fstatus-foot', {}, ago ? t('flightStatus.updated', { when: ago }) : '', ago && source ? ' · ' : '',
        source ? (href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t('flightStatus.source', { source: source.text })) : t('flightStatus.source', { source: source.text })) : ''),
    ];
  }

  function relative(epoch) {
    const minutes = Math.round((epoch - now()) / 60_000);
    const format = new Intl.RelativeTimeFormat(displayLocale(), { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    if (Math.abs(minutes) < 48 * 60) return format.format(Math.round(minutes / 60), 'hour');
    return format.format(Math.round(minutes / 1440), 'day');
  }

  return {
    chip(res, index) {
      if (res?.type !== 'flight' || res.status === 'cancelled') return null;
      const query = statusQuery(res.legs?.[index]);
      if (!query) return null;
      const node = el('span.fstatus', { dataset: { flightStatus: `${res.id}:${index}` } });
      track(node, () => node.replaceChildren(...chipContent(res, index)));
      // Rows are attached after this returns; a load started now would notify first and drop the detached chip.
      queueMicrotask(() => store.ensure(query, { auto: statusWindow(res.legs[index], now()) === 'live' }));
      return node;
    },
    details(res) {
      if (res?.type !== 'flight' || !res.legs?.length || res.status === 'cancelled') return null;
      const node = el('div.fstatus-details');
      res.legs.forEach((leg) => { const query = statusQuery(leg); if (query) store.ensure(query, { auto: statusWindow(leg, now()) === 'live' }); });
      return track(node, () => node.replaceChildren(...res.legs.map((leg, index) => el('section.fstatus-leg', {},
        titled(res, leg) ? el('h3.fstatus-title', {}, t('flightStatus.legHeading', {
          flight: (/[a-z]/i.test(leg.number ?? '') ? leg.number : [leg.carrier, leg.number].filter(Boolean).join(' ')) || t('flightStatus.flight'),
          route: t('bookings.routeArrow', { from: leg.from?.code || leg.from?.name || '?', to: leg.to?.code || leg.to?.name || '?' }),
        })) : null,
        ...legBody(res, index)))));
    },
    destroy() { off(); nodes.clear(); store.destroy(); },
  };
}
