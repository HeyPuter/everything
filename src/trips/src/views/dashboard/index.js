// The trips dashboard: spotlight, grid or list of trips with filters and card menus, and per-device widgets.
import './dashboard.css';
import { el } from '../../ui/dom.js';
import { avatarStack } from '../../ui/avatar.js';
import { button, chip, emptyState, skeleton } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { openMenu } from '../../ui/menu.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale, currentDevice, dashboardWidgets, onPrefs, prefs, setPrefs } from '../../lib/prefs.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { routeHash } from '../../lib/router.js';
import { can } from '../../shared/perms.js';
import { daysBetween } from '../../shared/dates.js';
import { coverURL } from '../trip/settings/cover.js';
import { confirmDelete, confirmLeave, openCopyDialog, openTripForm } from '../trip/settings/dialogs.js';
import { deleteTrip, errorKey, leaveTrip, setArchived } from '../trip/settings/actions.js';
import { compareTrips, countText, dayTotal, isDated, today, tripDates, tripStatus } from '../trip/settings/meta.js';
import { loadTrips, nextTransport, refreshHeads } from './data.js';
import { bookingIcon, icon, iconBtn } from './icons.js';
import { clocksWidget, fxWidget, upcomingWidget } from './widgets.js';
import { openTripImport } from '../io/entry.js';

const FILTERS = ['all', 'planned', 'completed', 'archived'];
const STATUS_KEY = { ongoing: 'dashboard.statusOngoing', upcoming: 'dashboard.statusUpcoming', past: 'dashboard.statusPast', undated: 'dashboard.statusUndated' };
const HEADS_EVERY = 60_000;
function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, value) { try { localStorage.setItem(key, value); } catch { /* Per-device convenience only. */ } }
const tripHash = (trip, tab = 'plan') => routeHash({ name: 'space', ref: trip.ref, tab });

export function matchesFilter(trip, filter, day) {
  if (filter === 'archived') return trip.archived;
  if (trip.archived) return false;
  const status = tripStatus(trip, day);
  if (filter === 'planned') return status !== 'past';
  if (filter === 'completed') return status === 'past';
  return true;
}

/** The ongoing trip, else the next dated one. */
export function spotlightTrip(trips, day) {
  const live = trips.filter((trip) => !trip.archived && !trip.unavailable);
  return live.filter((trip) => tripStatus(trip, day) === 'ongoing').sort((a, b) => compareTrips(a, b, day))[0]
    ?? live.filter((trip) => tripStatus(trip, day) === 'upcoming' && trip.start).sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
}

export function mount(container, context) {
  const { session, puter, app, route, signal } = context;
  const me = session.account.uuid;
  const state = {
    filter: FILTERS.includes(readLocal('trips:dash-filter')) ? readLocal('trips:dash-filter') : 'all',
    view: readLocal('trips:dash-view') === 'list' ? 'list' : 'grid', tag: null,
  };
  let trips = [];
  let loaded = false;
  let failure = null;
  let headsAt = 0;
  let version = 0;
  const root = el('div.dashboard');
  container.replaceChildren(root);

  const go = (hash) => app.navigate(hash);
  async function load({ heads = true } = {}) {
    const current = ++version;
    try {
      const next = await loadTrips(session);
      if (signal.aborted || current !== version) return;
      trips = next; loaded = true; failure = null; render();
      if (!heads || !navigator.onLine) return;
      headsAt = Date.now();
      const fresh = await refreshHeads(trips, { api: session.api, personal: session.personal, signal });
      if (signal.aborted || current !== version) return;
      trips = fresh; render();
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError' || current !== version) return;
      if (!loaded) { failure = error; render(); }
    }
  }
  async function act(action, { success, reload = true } = {}) {
    try {
      const result = await action();
      if (result?.status === 'queued') toast(t('dashboard.savedOffline'));
      else if (['rejected', 'conflict'].includes(result?.status)) toast(t('trip.errorForbidden'));
      else if (success) toast(t(success));
    } catch (error) { toast(t(errorKey(error))); }
    if (reload && !signal.aborted) void load({ heads: false });
  }
  function createTrip() {
    return openTripForm({ session, puter, signal, onCreated: (ref) => go(routeHash({ name: 'space', ref, tab: 'plan' })) });
  }
  function edit(trip) {
    return act(() => session.withSpace(trip.ref, (space) => openTripForm({ session, puter, space, signal }), { pull: true }).then((result) => result.flush));
  }
  function menuItems(trip) {
    if (trip.unavailable) return [{ label: t('trip.removeFromList'), icon: 'trash', onSelect: () => act(() => session.personal.spaces.remove(trip.ref)) }];
    const items = [];
    if (can(trip.role, 'trip.edit', trip.perms)) items.push({ label: t('trip.edit'), icon: 'pencil', onSelect: () => edit(trip) });
    items.push({ label: t('trip.copy'), icon: 'copy', onSelect: () => openCopyDialog({ session, ref: trip.ref, meta: trip, signal, onCopied: (ref) => go(routeHash({ name: 'space', ref, tab: 'plan' })) }) });
    if (can(trip.role, 'trip.archive', trip.perms)) {
      items.push({ label: t(trip.archived ? 'trip.unarchive' : 'trip.archive'), onSelect: () => act(() => setArchived(session, trip.ref, !trip.archived), { success: trip.archived ? 'trip.unarchived' : 'trip.archivedDone' }) });
    }
    items.push({ separator: true });
    if (trip.role === 'owner') items.push({ label: t('trip.delete'), icon: 'trash', danger: true, onSelect: async () => { if (await confirmDelete(trip)) await act(() => deleteTrip(session, trip.ref), { success: 'trip.deleted' }); } });
    else items.push({ label: t('trip.leave'), danger: true, onSelect: async () => { if (await confirmLeave(trip)) await act(() => leaveTrip(session, trip.ref)); } });
    return items;
  }
  function menuButton(trip) {
    const anchor = iconBtn('more', t('dashboard.tripMenu', { title: trip.title || t('trip.untitled') }), { class: 'icon-btn trip-card-menu', onclick: () => openMenu(anchor, menuItems(trip)) });
    return anchor;
  }
  function cover(trip, className) {
    const tone = (trip.ref.s.charCodeAt(15) % 8) + 1;
    const frame = el(`div.${className}`, { 'aria-hidden': 'true', dataset: { tone: String(tone), tone2: String((tone % 8) + 1) } });
    if (trip.cover) {
      void coverURL(trip.cover, { ref: trip.ref, thumb: true }).then((src) => {
        if (src && !signal.aborted) frame.replaceChildren(el('img', { src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', onerror: (event) => event.target.remove() }));
      });
    }
    return frame;
  }
  function statusChip(trip, day) {
    if (trip.unavailable) return chip(t('dashboard.statusUnavailable'), { status: 'warn' });
    if (trip.archived) return chip(t('trip.archived'));
    const status = tripStatus(trip, day);
    return chip(t(STATUS_KEY[status]), { status: status === 'ongoing' ? 'success' : status === 'upcoming' ? 'accent' : '' });
  }
  function people(trip) {
    const others = trip.members.filter((member) => member.id !== me);
    return others.length ? avatarStack(others.map((member) => ({ id: member.id, name: member.name })), { max: 4, size: 24 }) : null;
  }
  /** New activity: the local unread count, or a dot when heads show changes not pulled to this device yet. */
  function unreadBadge(trip) {
    if (trip.unavailable) return null;
    const count = trip.unread ?? 0;
    if (count > 0) {
      const locale = displayLocale();
      const format = new Intl.NumberFormat(locale);
      return el('span.trip-unread', {}, el('span', { 'aria-hidden': 'true' }, count > 99 ? `${format.format(99)}+` : format.format(count)),
        el('span.sr-only', {}, t(new Intl.PluralRules(locale).select(count) === 'one' ? 'dashboard.unreadOne' : 'dashboard.unread', { count: format.format(count) })));
    }
    return trip.ahead ? el('span.trip-unread.is-dot', { title: t('dashboard.updated') }, el('span.sr-only', {}, t('dashboard.updated'))) : null;
  }
  const format = () => new Intl.NumberFormat(displayLocale());
  const travelerCount = (trip) => (trip.members.length ? trip.members.length : null);
  function cardStat(value, label) {
    return el('div.trip-card-stat', {}, el('strong.num', {}, value == null ? '–' : format().format(value)), el('span.eyebrow', {}, label));
  }
  function card(trip, day) {
    const title = trip.title || t('trip.untitled');
    return el('article.trip-card', { dataset: { trip: trip.ref.s } },
      el('div.trip-card-media', {}, cover(trip, 'trip-card-cover'),
        el('div.trip-card-overlay', {}, statusChip(trip, day), el('h3.trip-card-title', {}, el('a.trip-card-link', { href: tripHash(trip) }, title), unreadBadge(trip)))),
      el('div.trip-card-body', {},
        el('p.trip-card-dates', {}, trip.start || trip.end ? tripDates(trip) : t('dashboard.heroOpenDates')),
        // Places and travelers come from the local replica, so they show once the trip has been opened on this device.
        el('div.trip-card-stats', {}, cardStat(dayTotal(trip), t('dashboard.cardDays')), trip.places == null ? null : cardStat(trip.places, t('dashboard.cardPlaces')),
          travelerCount(trip) == null ? null : cardStat(travelerCount(trip), t('dashboard.cardTravelers'))),
        trip.tags.length || people(trip) ? el('div.trip-card-meta', {}, trip.tags.length ? el('div.trip-card-tags', {}, trip.tags.slice(0, 3).map((tag) => chip(tag))) : el('span'), people(trip)) : null),
      menuButton(trip));
  }
  function row(trip, day) {
    return el('li.trip-row', { dataset: { trip: trip.ref.s } },
      cover(trip, 'trip-row-cover'),
      el('div.trip-row-text', {}, el('span.trip-row-title', {}, el('a.trip-card-link', { href: tripHash(trip) }, trip.title || t('trip.untitled')), unreadBadge(trip)),
        el('span.trip-row-dates', {}, tripDates(trip))),
      el('div.trip-row-meta', {}, people(trip), statusChip(trip, day)),
      menuButton(trip));
  }
  function countdown(trip, day) {
    if (tripStatus(trip, day) === 'ongoing') return t('dashboard.dayOf', { day: daysBetween(trip.start, day) + 1, total: dayTotal(trip) });
    const days = daysBetween(day, trip.start);
    return days === 1 ? t('dashboard.startsTomorrow') : countText('dashboard.startsIn', days);
  }
  function boardingPass(trip, day) {
    const next = nextTransport(trip, day);
    if (!next) return null;
    const { item, when } = next;
    const leg = item.legs?.[0];
    const end = (point) => point?.code || point?.name || '';
    const from = end(leg?.from) || item.location?.name || '';
    const to = end(item.legs?.at(-1)?.to);
    return el('a.boarding-pass', { href: tripHash(trip, 'bookings'), 'aria-label': t('dashboard.nextTransport', { title: item.title }) },
      el('span.boarding-icon', {}, bookingIcon(item.type, 20)),
      el('span.boarding-route', {}, from && to ? el('span.boarding-codes', {}, from, icon('arrowRight', 14), to) : el('span.boarding-codes', {}, item.title),
        el('span.boarding-meta', {}, [formatDateTime(when.date, when.time, { weekday: true }), [leg?.carrier, leg?.number].filter(Boolean).join(' '), leg?.seat && t('dashboard.seat', { seat: leg.seat })].filter(Boolean).join(' · '))));
  }
  /** Big day number with the month beneath, for the hero's date cells. */
  function dateCell(date) {
    const [y, m, d] = date.split('-').map(Number);
    const month = new Intl.DateTimeFormat(displayLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
    return el('span.hero-date', { 'aria-hidden': 'true' }, el('strong.num', {}, String(d)), el('span', {}, month));
  }
  function heroCell(label, ...body) { return el('div.hero-cell', {}, el('span.eyebrow', {}, label), el('div.hero-cell-body', {}, body)); }
  function spotlight(day) {
    const trip = spotlightTrip(trips, day);
    if (!trip) return null;
    const ongoing = tripStatus(trip, day) === 'ongoing';
    const others = trip.members.filter((member) => member.id !== me);
    const names = others.length ? new Intl.ListFormat(displayLocale(), { type: 'conjunction' }).format(others.slice(0, 3).map((member) => member.name)) : '';
    const total = dayTotal(trip);
    const big = ongoing ? daysBetween(trip.start, day) + 1 : daysBetween(day, trip.start);
    const dates = isDated(trip)
      ? heroCell(t('dashboard.heroDates'), dateCell(trip.start), icon('arrowRight', 16), dateCell(trip.end), el('span.sr-only', {}, tripDates(trip)))
      : heroCell(t('dashboard.heroDates'), el('span.hero-text', {}, tripDates(trip)));
    const travelers = !trip.members.length ? null : heroCell(t('dashboard.heroTravelers'),
      others.length ? avatarStack(others.map((member) => ({ id: member.id, name: member.name })), { max: 3, size: 30 }) : el('span.hero-you', {}, icon('users', 18)),
      el('span.hero-text', {}, others.length ? t('dashboard.with', { names: others.length > 3 ? t('dashboard.withMore', { names, count: others.length - 3 }) : names }) : t('dashboard.justYou')));
    const countdownCell = heroCell(t(ongoing ? 'dashboard.heroProgress' : 'dashboard.heroCountdown'),
      el('span.hero-big', { 'aria-hidden': 'true' }, el('strong.num', {}, format().format(big)), el('span', {}, ongoing ? t('dashboard.ofTotal', { total: format().format(total) }) : t('dashboard.daysUnit'))),
      el('span.sr-only.spotlight-countdown', {}, countdown(trip, day)));
    const places = trip.places == null ? null : heroCell(t('dashboard.heroPlaces'), el('span.hero-big', {}, el('strong.num', {}, format().format(trip.places)), el('span', {}, icon('pin', 16))));
    return el('section.spotlight', { 'aria-labelledby': 'spotlight-title' },
      cover(trip, 'spotlight-cover'),
      el('div.spotlight-body', {},
        el('div.spotlight-top', {}, el('p.spotlight-eyebrow', {}, t(ongoing ? 'dashboard.spotlightNow' : 'dashboard.spotlightNext')), menuButton(trip)),
        el('h2.spotlight-title', { id: 'spotlight-title' }, el('a.trip-card-link', { href: tripHash(trip) }, trip.title || t('trip.untitled'))),
        el('div.hero-strip', {}, travelers, dates, isDated(trip) ? countdownCell : null, places),
        boardingPass(trip, day)));
  }
  /** Totals across live trips, under the hero. */
  function statTiles(day) {
    const live = trips.filter((trip) => !trip.archived && !trip.unavailable);
    if (!live.length) return null;
    const completed = live.filter((trip) => tripStatus(trip, day) === 'past').length;
    const upcoming = live.filter((trip) => ['upcoming', 'ongoing'].includes(tripStatus(trip, day))).length;
    const days = live.reduce((sum, trip) => sum + dayTotal(trip), 0);
    const known = live.filter((trip) => trip.places != null);
    const placeSum = known.reduce((sum, trip) => sum + trip.places, 0);
    const tile = (label, value, hint) => el('div.dash-stat', {}, el('span.eyebrow', {}, label), el('strong.num', {}, value), hint ? el('span.dash-stat-hint', {}, hint) : null);
    return el('div.dash-stats', { 'aria-label': t('dashboard.widgets') },
      tile(t('dashboard.statTrips'), format().format(live.length), t('dashboard.statTripsHint', { count: format().format(completed) })),
      tile(t('dashboard.statDays'), format().format(days), t('dashboard.statDaysHint')),
      known.length ? tile(t('dashboard.statPlaces'), format().format(placeSum), t('dashboard.statPlacesHint')) : null,
      tile(t('dashboard.statUpcoming'), format().format(upcoming), t('dashboard.statUpcomingHint')));
  }
  function tip() {
    if (prefs().tips?.dashboard || trips.length > 1) return null;
    return el('aside.dash-tip', { role: 'note' }, el('div', {}, el('h2', {}, t('dashboard.tipTitle')), el('p', {}, t('dashboard.tipBody'))),
      button(t('dashboard.tipDismiss'), { size: 'sm', variant: 'ghost', dataset: { focus: 'tip' }, onclick: () => setPrefs({ tips: { ...prefs().tips, dashboard: true } }) }));
  }
  /** Re-renders replace the toolbar, so focus moves to the same control (by `data-focus`) or to the first fallback present. */
  function keepFocus(key, ...fallbacks) {
    for (const name of [key, ...fallbacks]) {
      const target = name && root.querySelector(`[data-focus="${CSS.escape(name)}"]`);
      if (target) { target.focus({ preventScroll: true }); return; }
    }
  }
  const markItems = (control, prefix, values) => [...control.element.children].forEach((node, index) => { node.dataset.focus = `${prefix}:${values[index]}`; });
  // Tiles other modules render into a slot; each returns a cleanup that runs when the widgets are rebuilt.
  const tileCleanups = new Set();
  function tile(id, load) {
    const slot = el(`div.dash-widget-slot.dash-widget-${id}`);
    let cleanup = null;
    let dropped = false;
    const drop = () => { dropped = true; tileCleanups.delete(drop); if (typeof cleanup === 'function') cleanup(); };
    tileCleanups.add(drop);
    load().then((mountTile) => { if (!dropped && !signal.aborted) cleanup = mountTile(slot, { ...context, personal: session.personal }); }).catch(() => slot.remove());
    return slot;
  }
  function widgets(day) {
    for (const drop of [...tileCleanups]) drop();
    const visible = dashboardWidgets(currentDevice()).filter((item) => item.visible);
    const build = {
      fx: () => fxWidget({ session, trips, signal }), clocks: () => clocksWidget({ trips, signal }), upcoming: () => upcomingWidget({ trips, day }),
      collections: () => tile('collections', () => import('../collections/widget.js').then((module) => module.mountCollectionsWidget)),
      atlas: () => tile('atlas', () => import('../atlas/tile.js').then((module) => module.mountAtlasTile)),
    };
    const nodes = visible.flatMap((item) => (build[item.id] ? [build[item.id]()] : []));
    return nodes.length ? el('aside.dash-widgets', { 'aria-label': t('dashboard.widgets') }, nodes) : null;
  }
  function importButton() {
    return button(t('dashboard.import'), { icon: 'upload', variant: 'outline', onclick: () => void openTripImport({ ...context, space: null }) });
  }
  let widgetSignature = '';
  let widgetNode = null;
  function render() {
    if (signal.aborted) return;
    const day = today();
    const focusKey = root.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    const newTrip = el('div.dash-create', {}, button(t('dashboard.newTrip'), { icon: 'plus', variant: 'primary', dataset: { focus: 'new' }, onclick: createTrip }), importButton());
    if (failure) {
      root.replaceChildren(el('div.dash-error', { role: 'alert' }, el('p', {}, t('dashboard.loadError')), button(t('trip.retry'), { onclick: () => { failure = null; render(); void load(); } })));
      return;
    }
    if (!loaded) {
      root.replaceChildren(el('div.dash-toolbar', {}, newTrip), el('div.trip-grid', { 'aria-busy': 'true' }, [0, 1, 2].map(() => el('div.trip-card.is-loading', {}, skeleton('100%'), skeleton('60%'), skeleton('40%')))));
      return;
    }
    if (!trips.length) {
      const empty = emptyState({ title: t('dashboard.emptyTitle'), body: t('dashboard.emptyBody'), icon: 'map', action: newTrip, level: 2 });
      root.replaceChildren(tip() ?? '', empty, widgets(day) ?? '');
      keepFocus(focusKey, focusKey === 'tip' ? 'new' : null);
      return;
    }
    const tags = [...new Set(trips.flatMap((trip) => trip.tags))].sort((a, b) => a.localeCompare(b));
    if (state.tag && !tags.includes(state.tag)) state.tag = null;
    const filter = segmented({ label: t('dashboard.filter'), value: state.filter, onChange: (value) => { state.filter = value; writeLocal('trips:dash-filter', value); render(); },
      items: FILTERS.map((value) => ({ value, label: t(`dashboard.filter_${value}`) })) });
    const view = segmented({ label: t('dashboard.viewMode'), value: state.view, onChange: (value) => { state.view = value; writeLocal('trips:dash-view', value); render(); },
      items: [{ value: 'grid', label: t('dashboard.viewGrid') }, { value: 'list', label: t('dashboard.viewList') }] });
    [...view.element.children].forEach((node, index) => node.prepend(icon(index ? 'list' : 'grid', 16)));
    markItems(filter, 'filter', FILTERS); markItems(view, 'view', ['grid', 'list']);
    const tagFilter = tags.length ? el('div.dash-tags', { role: 'group', 'aria-label': t('dashboard.tagFilter') }, tags.map((tag) => el('button.chip.dash-tag', {
      type: 'button', 'aria-pressed': String(state.tag === tag), dataset: { focus: `tag:${tag}` }, onclick: () => { state.tag = state.tag === tag ? null : tag; render(); },
    }, icon('tag', 14), tag))) : null;
    const shown = trips.filter((trip) => matchesFilter(trip, state.filter, day) && (!state.tag || trip.tags.includes(state.tag))).sort((a, b) => compareTrips(a, b, day));
    const list = shown.length
      ? (state.view === 'grid' ? el('div.trip-grid', {}, shown.map((trip) => card(trip, day))) : el('ul.trip-list.card', {}, shown.map((trip) => row(trip, day))))
      : el('div.dash-none', {}, el('p', {}, t('dashboard.noMatch')), button(t('dashboard.clearFilters'), { size: 'sm', dataset: { focus: 'clear' }, onclick: () => { state.filter = 'all'; state.tag = null; writeLocal('trips:dash-filter', 'all'); render(); } }));
    const stale = trips.some((trip) => trip.stale) ? el('p.dash-stale', { role: 'status' }, t('dashboard.stale')) : null;
    const signature = JSON.stringify([trips.map((trip) => [trip.ref.s, trip.currency, trip.res.length, trip.archived, [...trip.tz.keys()]]), dashboardWidgets(currentDevice())]);
    if (signature !== widgetSignature || !widgetNode) { widgetSignature = signature; widgetNode = widgets(day); }
    const focusTrip = document.activeElement?.closest?.('[data-trip]')?.dataset.trip;
    root.replaceChildren(
      el('div.dash-toolbar', {}, newTrip, el('div.dash-controls', {}, filter.element, view.element)),
      tip() ?? '', tagFilter ?? '', stale ?? '',
      el('div.dash-layout', {}, el('div.dash-main', {}, spotlight(day) ?? '', statTiles(day) ?? '', el('h2.sr-only', {}, t('dashboard.listHeading')), list), widgetNode ?? ''));
    if (focusTrip) root.querySelector(`[data-trip="${focusTrip}"] .trip-card-link`)?.focus({ preventScroll: true });
    else keepFocus(focusKey, focusKey === 'clear' ? 'filter:all' : focusKey === 'tip' ? 'new' : null);
  }

  const offs = [
    onPrefs((_, changed) => { if ([...changed].some((key) => ['widgetsDesktop', 'widgetsPhone', 'tips', 'dateFormat', 'timeFormat', 'currency'].includes(key))) { widgetNode = null; render(); } }),
    session.personal.subscribe('me:spaces', () => void load({ heads: false })),
  ];
  const media = globalThis.matchMedia?.('(max-width: 899px)');
  const onMedia = () => { widgetNode = null; render(); };
  media?.addEventListener?.('change', onMedia);
  const onFocus = () => { if (Date.now() - headsAt > HEADS_EVERY) void load(); };
  globalThis.addEventListener('focus', onFocus);
  signal.addEventListener('abort', () => {
    offs.forEach((off) => off()); for (const drop of [...tileCleanups]) drop(); media?.removeEventListener?.('change', onMedia); globalThis.removeEventListener('focus', onFocus);
  }, { once: true });

  render();
  // A trip left moments ago may still be sending edits; read again once they are in.
  const closing = session.idle?.();
  void load({ heads: !closing });
  closing?.then(() => { if (!signal.aborted) void load(); });
  if (route?.create) {
    void createTrip().then((saved) => { if (!saved && !signal.aborted) app.navigate('#/', { replace: true }); });
  }
  return () => { version += 1; };
}
