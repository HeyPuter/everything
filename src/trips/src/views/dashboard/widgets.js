// Dashboard widgets: currency converter, time-zone clocks and upcoming bookings. Choices are per device.
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { field } from '../../ui/fields.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { formatDateTime, formatInstant } from '../../lib/format.js';
import { routeHash } from '../../lib/router.js';
import { browserTimeZone, isTimeZone, zoneOffset } from '../../shared/dates.js';
import { isCurrency } from '../../shared/money.js';
import { crossRate } from '../../services/fx.js';
import { defaultCurrency } from '../trip/settings/dialogs.js';
import { bookingIcon, icon, iconBtn } from './icons.js';
import { tripZones, upcomingBookings } from './data.js';

const MAX_CLOCKS = 8;
function readLocal(key) { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } }
function writeLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Per-device convenience only. */ } }
const WIDGET_ICONS = { fx: 'coins', clocks: 'clock', upcoming: 'upcoming' };
const card = (id, title, ...children) => {
  const heading = uid('widget');
  return el(`section.dash-widget.dash-widget-${id}`, { 'aria-labelledby': heading }, el('h2.dash-widget-title', { id: heading }, icon(WIDGET_ICONS[id] ?? 'calendar', 14), title), ...children);
};
/** A compact day-and-month block for list rows. */
function dateBlock(date) {
  const [y, m, d] = date.split('-').map(Number);
  const month = new Intl.DateTimeFormat(displayLocale(), { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return el('span.upcoming-date', { 'aria-hidden': 'true' }, el('strong', {}, String(d)), el('span', {}, month));
}

function currencyOptions() {
  const names = new Intl.DisplayNames([displayLocale()], { type: 'currency' });
  return Intl.supportedValuesOf('currency').filter(isCurrency).map((code) => ({ value: code, label: code, title: names.of(code) ?? code }));
}

export function fxWidget({ session, trips, signal }) {
  const saved = readLocal('trips:fx') ?? {};
  const home = defaultCurrency();
  const away = trips.find((trip) => trip.currency && trip.currency !== home && !trip.archived)?.currency;
  let from = isCurrency(saved.from) ? saved.from : home;
  let to = isCurrency(saved.to) ? saved.to : away ?? (from === 'EUR' ? 'USD' : 'EUR');
  const options = currencyOptions();
  const amount = field({ label: t('dashboard.fxAmount'), value: typeof saved.amount === 'string' ? saved.amount : '100', inputMode: 'decimal', autocomplete: 'off' });
  const fromField = field({ label: t('dashboard.fxFrom'), type: 'select', options, value: from });
  const toField = field({ label: t('dashboard.fxTo'), type: 'select', options, value: to });
  const result = el('p.fx-result', { 'aria-live': 'polite' });
  const note = el('p.dash-widget-note');
  let run = 0;
  let timer;
  async function compute() {
    from = fromField.input.value; to = toField.input.value;
    writeLocal('trips:fx', { from, to, amount: amount.input.value });
    const raw = amount.input.value.trim().replace(/\s/g, '');
    const value = Number(raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(',', '.'));
    if (!raw || !Number.isFinite(value) || value < 0) { result.textContent = t('dashboard.fxInvalid'); note.textContent = ''; return; }
    const current = ++run;
    result.textContent = t('dashboard.fxLoading');
    try {
      const rates = from === to ? { data: { base: from, rates: { [from]: 1 }, date: '' } } : await session.services.fx.rates(from);
      if (current !== run || signal.aborted) return;
      const rate = crossRate(rates?.data, from, to);
      if (!rate) { result.textContent = t(rates === null ? 'dashboard.fxOffline' : 'dashboard.fxUnavailable'); note.textContent = ''; return; }
      const format = (number, code) => new Intl.NumberFormat(displayLocale(), { style: 'currency', currency: code }).format(number);
      result.textContent = t('dashboard.fxResult', { from: format(value, from), to: format(value * rate, to) });
      const attribution = (rates.attribution ?? []).map((item) => item.text).filter(Boolean).join(' · ');
      note.textContent = [rates.data.date && t('dashboard.fxDate', { date: rates.data.date }), rates.stale && t('dashboard.fxStale'), attribution].filter(Boolean).join(' · ');
    } catch {
      if (current === run) { result.textContent = t('dashboard.fxUnavailable'); note.textContent = ''; }
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(compute, 300); };
  amount.input.addEventListener('input', schedule);
  fromField.input.addEventListener('change', compute);
  toField.input.addEventListener('change', compute);
  const swap = iconBtn('swap', t('dashboard.fxSwap'), { onclick: () => { [fromField.input.value, toField.input.value] = [toField.input.value, fromField.input.value]; void compute(); } });
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  // Rates are fetched once the converter has been used on this device, not on every dashboard visit.
  if (saved.amount !== undefined) void compute(); else note.textContent = t('dashboard.fxPrompt');
  return card('fx', t('dashboard.widgetFx'), amount.element, el('div.fx-pair', {}, fromField.element, swap, toField.element), result, note);
}

function differenceText(zone, local, now) {
  const diff = zoneOffset(zone, now) - zoneOffset(local, now);
  if (!diff) return t('dashboard.clockSame');
  const hours = Math.floor(Math.abs(diff) / 60); const minutes = Math.abs(diff) % 60;
  const amount = minutes ? `${hours}:${String(minutes).padStart(2, '0')}` : String(hours);
  return t(diff > 0 ? 'dashboard.clockAhead' : 'dashboard.clockBehind', { amount });
}
const placeName = (zone) => zone.split('/').pop().replace(/_/g, ' ');

export function clocksWidget({ trips, signal }) {
  const local = browserTimeZone();
  let mine = (readLocal('trips:clocks') ?? []).filter(isTimeZone).slice(0, MAX_CLOCKS);
  const fromTrips = trips.filter((trip) => !trip.archived && !trip.unavailable).flatMap(tripZones).filter((zone) => zone !== local);
  const list = el('ul.clock-list');
  const zones = Intl.supportedValuesOf('timeZone');
  const picker = field({ label: t('dashboard.clockAdd'), type: 'select', options: [{ value: '', label: t('dashboard.clockChoose') }, ...zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))] });
  const add = button(t('dashboard.clockAddButton'), { size: 'sm', onclick: () => {
    const zone = picker.input.value;
    if (!isTimeZone(zone) || mine.includes(zone)) return;
    mine = [...mine, zone].slice(-MAX_CLOCKS); writeLocal('trips:clocks', mine); picker.input.value = ''; draw();
  } });
  function draw() {
    const now = Date.now();
    const shown = [...new Set([local, ...mine, ...fromTrips])].slice(0, MAX_CLOCKS);
    list.replaceChildren(...shown.map((zone) => el('li.clock-row', {},
      el('span.clock-place', {}, el('span.clock-name', {}, zone === local ? t('dashboard.clockLocal', { place: placeName(zone) }) : placeName(zone)),
        el('span.clock-diff', {}, zone === local ? zone.replace(/_/g, ' ') : differenceText(zone, local, now))),
      el('span.clock-time', {}, formatInstant(now, zone, { date: false })),
      mine.includes(zone) ? iconBtn('close', t('dashboard.clockRemove', { place: placeName(zone) }), { small: true, onclick: () => {
        mine = mine.filter((item) => item !== zone); writeLocal('trips:clocks', mine); draw();
      } }) : null)));
  }
  draw();
  const interval = setInterval(draw, 30_000);
  signal.addEventListener('abort', () => clearInterval(interval), { once: true });
  return card('clocks', t('dashboard.widgetClocks'), list, el('div.clock-add', {}, picker.element, add));
}

export function upcomingWidget({ trips, day }) {
  const items = upcomingBookings(trips, day);
  const body = items.length ? el('ul.upcoming-list', {}, items.map(({ trip, item, when }) => el('li', {}, el('a.upcoming-item', {
    href: routeHash({ name: 'space', ref: trip.ref, tab: 'bookings' }),
  }, dateBlock(when.date), el('span.upcoming-text', {}, el('span.upcoming-title', {}, item.title),
    el('span.upcoming-meta', {}, `${formatDateTime(when.date, when.time, { weekday: true })} · ${trip.title || t('trip.untitled')}`)),
  el('span.upcoming-kind', {}, bookingIcon(item.type, 16))))))
    : el('p.dash-widget-empty', {}, icon('upcoming', 18), t('dashboard.upcomingEmpty'));
  return card('upcoming', t('dashboard.widgetUpcoming'), body);
}
