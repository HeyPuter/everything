// Week overview (`#/week`): the trips running each day of a week with their timed stops, bookings and the member's
// to-dos due, read from this device's replicas, plus upcoming reminders and the browser-notification switch.
import './week.css';
import '../../lib/notify/notify.css';
import { el } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button, emptyState, iconButton, skeleton } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { formatDate, formatDateRange, formatTime, weekStart } from '../../lib/format.js';
import { openDatabase } from '../../lib/idb.js';
import { routeHash } from '../../lib/router.js';
import { loadTrips } from '../../lib/notify/replica.js';
import { activeReminders } from '../../lib/notify/notifier.js';
import { allReminders, todayIn, upcoming } from '../../lib/notify/schedule.js';
import { reminderLabels } from '../../lib/notify/text.js';
import { browserSwitch, reminderList } from '../../lib/notify/settings.js';
import { addDays } from '../../shared/dates.js';
import { weekDates, weekPlan } from './model.js';

const ITEM_ICONS = Object.freeze({ visit: 'pin', booking: 'calendar', todo: 'check' });
const TRANSPORT = new Set(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const plural = (count, one, other, values = {}) => t(new Intl.PluralRules(displayLocale()).select(count) === 'one' ? one : other, { ...values, count: new Intl.NumberFormat(displayLocale()).format(count) });
const hashFor = (ref, tab) => { try { return routeHash({ name: 'space', ref, tab }); } catch { return null; } };
const labels = { visit: () => t('week.stop'), type: (type) => t(`bookings.type.${type}`), todo: () => t('week.todo') };

export async function mount(container, context) {
  const { personal, signal } = context;
  const session = context.session ?? null;
  const uid = context.account?.uuid ?? session?.account?.uuid;
  if (!personal?.spaces?.list || !uid) {
    container.replaceChildren(emptyState({ icon: 'calendar', title: t('week.unavailableTitle'), body: t('week.unavailableBody'), level: 2 }));
    return undefined;
  }
  const zone = zoneNow();
  let db = session?.db ?? null;
  let ownDb = null;
  let anchor = todayIn(Date.now(), zone);
  let trips = null;
  let destroyed = false;
  let loading = null;
  const offs = [];

  const heading = el('h2.week-title', { tabIndex: -1 });
  const live = el('p.sr-only', { 'aria-live': 'polite' });
  const prev = iconButton('chevronLeft', t('week.prev'), { onclick: () => move(-7) });
  const next = iconButton('chevronRight', t('week.next'), { onclick: () => move(7) });
  const todayButton = button(t('week.thisWeek'), { size: 'sm', variant: 'outline', onclick: () => { anchor = todayIn(Date.now(), zone); render(); heading.focus({ preventScroll: true }); } });
  const notes = el('div.week-notes');
  const grid = el('ol.week-days');
  const empty = el('div.week-empty', { hidden: true });
  const status = el('div.week-status');
  const reminders = el('div.week-reminder-list');
  const browser = browserSwitch();
  offs.push(browser.destroy);
  const root = el('section.week-view', { 'aria-labelledby': 'week-title' },
    el('header.week-head', {}, heading, el('div.week-nav', {}, prev, todayButton, next)),
    live, status, notes, grid, empty,
    el('section.week-reminders', { 'aria-labelledby': 'week-reminders-title' },
      el('h3.week-section-title', { id: 'week-reminders-title' }, t('week.reminders')), reminders, browser.node, el('p.pref-hint', {}, t('notify.openOnly'))));
  heading.id = 'week-title';
  container.replaceChildren(root);
  status.replaceChildren(el('div.week-skeleton', { 'aria-hidden': 'true' }, skeleton('40%'), skeleton('70%'), skeleton('55%')));

  function move(days) { anchor = addDays(anchor, days); render(); live.textContent = heading.textContent; }

  function itemNode(item, trip) {
    const href = hashFor(trip.ref, item.tab);
    const glyph = icon(item.kind === 'booking' && TRANSPORT.has(item.type) ? 'plane' : ITEM_ICONS[item.kind], 14);
    const text = [
      el('span.week-item-time', {}, item.time ? formatTime(item.time) : item.kind === 'todo' ? t('week.due') : t('week.allDay')),
      glyph,
      el('bdi.week-item-label', {}, item.label),
      item.kind === 'booking' && item.phase !== 'single' && el('span.week-item-detail', {}, t(`bookings.phase.${item.phase}`)),
      item.detail && el('span.week-item-detail', { dir: 'ltr' }, item.detail),
    ];
    return el('li.week-item', { dataset: { kind: item.kind } }, href ? el('a.week-item-link', { href }, text) : el('span.week-item-link', {}, text));
  }

  function dayNode(day) {
    const title = formatDate(day.date, { weekday: true, style: 'long', year: false });
    return el(`li.week-day${day.today ? '.is-today' : ''}${day.trips.length ? '' : '.is-free'}`, { 'aria-current': day.today ? 'date' : null, dataset: { date: day.date } },
      el('h3.week-day-head', {}, el('span', {}, title), day.today && el('span.week-today', {}, t('week.today'))),
      day.trips.length ? el('ul.week-trips', {}, day.trips.map((trip) => el('li.week-trip', { style: { '--trip-color': `var(--day-${trip.color})` } },
        el('a.week-trip-link', { href: hashFor(trip.ref, 'plan') }, el('bdi.week-trip-title', {}, trip.title || t('notify.untitledTrip')),
          el('span.week-trip-day', {}, t('week.dayOf', { day: trip.dayNumber, count: trip.dayCount }))),
        trip.items.length > 0 && el('ul.week-items', {}, trip.items.map((item) => itemNode(item, trip))),
        trip.untimed > 0 && el('p.week-untimed', {}, plural(trip.untimed, 'week.untimedOne', 'week.untimed')),
        trip.cached && !trip.items.length && !trip.untimed && el('p.week-untimed', {}, t('week.nothingPlanned')))))
        : el('p.week-free', {}, t('week.free')));
  }

  function renderReminders() {
    const running = activeReminders();
    const items = running ? running.list({ limit: 6 }) : trips ? upcoming(allReminders(trips, { uid, zone, labels: reminderLabels }), { limit: 6 }) : [];
    reminders.replaceChildren(reminderList(items, { zone }));
  }

  function render() {
    if (destroyed) return;
    const dates = weekDates(anchor, weekStart());
    heading.textContent = t('week.heading', { range: formatDateRange(dates[0], dates[6]) });
    if (!trips) return;
    const today = todayIn(Date.now(), zone);
    const plan = weekPlan(trips, dates, { uid, today, labels });
    todayButton.disabled = dates.includes(today);
    status.replaceChildren(el('p.week-summary', {}, plan.trips.length ? plural(plan.trips.length, 'week.summaryOne', 'week.summary') : t('week.summaryNone')));
    notes.replaceChildren(...plan.missing.map((trip) => el('p.week-note', {}, icon('warning', 16),
      el('span', {}, t('week.missing', { title: trip.title || t('notify.untitledTrip') })), el('a', { href: hashFor(trip.ref, 'plan') }, t('week.openTrip')))));
    grid.hidden = !plan.trips.length;
    grid.replaceChildren(...(plan.trips.length ? plan.days.map(dayNode) : []));
    empty.hidden = plan.trips.length > 0;
    if (!plan.trips.length) {
      empty.replaceChildren(emptyState({ icon: 'calendar', title: t('week.emptyTitle'), body: plan.next ? t('week.nextTrip', { title: plan.next.title || t('notify.untitledTrip'), date: formatDate(plan.next.start, { weekday: true }) }) : t('week.emptyBody'),
        action: plan.next && button(t('week.goTo'), { variant: 'primary', onclick: () => { anchor = plan.next.start; render(); heading.focus({ preventScroll: true }); } }) }));
    }
    renderReminders();
  }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      try {
        if (!db) { ownDb = await openDatabase(uid); db = ownDb; }
        if (destroyed) return;
        trips = await loadTrips({ personal, db });
        render();
      } catch {
        if (!destroyed && !trips) status.replaceChildren(el('p.field-error', { role: 'alert' }, t('week.loadError')), button(t('week.retry'), { size: 'sm', onclick: () => void load() }));
      } finally { loading = null; }
    })();
    return loading;
  }

  const onVisible = () => { if (globalThis.document?.visibilityState === 'visible') void load(); };
  globalThis.document?.addEventListener('visibilitychange', onVisible);
  offs.push(() => globalThis.document?.removeEventListener('visibilitychange', onVisible));
  const offSpaces = personal.subscribe?.('me:spaces', () => void load());
  if (offSpaces) offs.push(offSpaces);
  const running = activeReminders();
  if (running) offs.push(running.subscribe(() => renderReminders()));
  render();
  await load();
  const cleanup = () => {
    destroyed = true;
    for (const off of offs.splice(0)) { try { off(); } catch { /* keep tearing down */ } }
    ownDb?.close();
    ownDb = null;
  };
  signal?.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
