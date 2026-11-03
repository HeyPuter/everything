import './vacay.css';
import { el } from '../../ui/dom.js';
import { button, emptyState, iconButton, spinner } from '../../ui/bits.js';
import { field, segmented } from '../../ui/fields.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { locale, t } from '../../lib/i18n/index.js';
import { formatDate } from '../../lib/format.js';
import { onPrefs } from '../../lib/prefs.js';
import { addDays, isDate, localDate } from '../../shared/dates.js';
import { spaceRoute } from '../../shared/protocol.js';
import { pool } from '../../shared/pool.js';
import { createServices } from '../../services/index.js';
import { createVacayStore } from '../../lib/vacay/store.js';
import { createVacaySharing } from '../../lib/vacay/share.js';
import { loadHolidays } from '../../lib/vacay/holidays.js';
import { COLORS, NOTE_MAX } from '../../lib/vacay/model.js';
import { errorCode } from '../../lib/vacay/errors.js';
import { balance, bookable, bookableRange, dayStatus, leaveYear, leaveYearOf, usage } from '../../lib/vacay/days.js';
import { moveFocus, renderGrid } from './grid.js';
import { openInviteDialog, renderPeople } from './people.js';
import { openAllowanceDialog, openCalendarsDialog, openSettingsDialog } from './dialogs.js';
import { daysText, errorText, nameOf, plural, yearLabel } from './text.js';

const POLL_MS = 60_000;
const REFRESH_MS = 60_000;
const NOTIFY_DELAY_MS = 1500;
const SCHOOL_COLOR = 2;
const MODES = ['full', 'half', 'comp', 'company'];
const localToday = () => localDate();

function readUi(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return { mode: MODES.includes(value?.mode) ? value.mode : 'full', hidden: new Set(Array.isArray(value?.hidden) ? value.hidden.filter((item) => typeof item === 'string').slice(0, 100) : []) };
  } catch { return { mode: 'full', hidden: new Set() }; }
}
function writeUi(key, ui) { try { localStorage.setItem(key, JSON.stringify({ mode: ui.mode, hidden: [...ui.hidden] })); } catch { /* Private mode keeps defaults. */ } }

// Runs every task; resolves the errors of those that failed.
async function settled(items, limit, task) {
  const failures = [];
  await pool(items, limit, async (item) => { try { await task(item); } catch (error) { failures.push(error); } });
  return failures;
}

/**
 * Vacay page (`#/vacay`): the user's vacation days on a leave-year grid, in their own KV, with fused people and
 * read-only overlays through direct KV shares. Uses `context.session.services` for holidays when present.
 */
export async function mount(container, context) {
  const { puter, signal } = context;
  const session = context.session ?? null;
  const personal = session?.personal ?? context.personal ?? null;
  const account = context.account ?? session?.account ?? {};
  const uiKey = `trips:vacay:${account.uuid ?? 'anon'}`;
  const ui = { ...readUi(uiKey), year: null, selected: null, anchor: null, busy: false };
  const cleanups = [];
  let destroyed = false;
  let store = null;
  let sharing = null;
  let fallbackServices = null;
  let holidays = { publicDays: new Map(), schoolDays: new Map(), bands: new Map(), missing: false };
  const holidayYears = new Map();
  let holidayKey = '';
  let holidayAbort = null;
  let trips = new Map();
  let pollTimer = null;
  let lastRefresh = 0;
  let notifyTimer = null;
  let renderQueued = false;

  const announcer = el('p.sr-only', { role: 'status' });
  const banner = el('div.vacay-banners');
  const head = el('div.vacay-head');
  const toolbar = el('div.vacay-toolbar');
  const gridBox = el('div.vacay-grid-box');
  const stats = el('div.vacay-stats-box');
  const details = el('div.vacay-details-box');
  const people = el('div.vacay-people-box');
  const legend = el('div.vacay-legend-box');
  const root = el('div.vacay', {}, announcer, el('div.vacay-state', {}, spinner(), el('p', {}, t('vacay.loading'))));
  container.replaceChildren(root);

  const services = () => session?.services ?? (fallbackServices ??= (() => { try { return createServices({ userId: account.uuid ?? 'vacay' }); } catch { return null; } })());
  const plan = () => store.state.plan;
  const range = () => leaveYear(plan(), ui.year);
  const online = () => globalThis.navigator?.onLine !== false;
  const editable = () => Boolean(store?.state.loaded) && online();
  const announce = (message) => { announcer.textContent = ''; announcer.textContent = message; };
  const fail = (error) => { if (!destroyed) toast(errorText(error)); };

  // People: fused peers count toward company days only once confirmed.
  function peerList() {
    if (!sharing) return [];
    const mine = plan().color ?? 1;
    const used = new Set([mine]);
    const peers = [...sharing.state.peers.values()].sort((a, b) => nameOf(a.name).localeCompare(nameOf(b.name)));
    return peers.map((peer, index) => {
      let color = peer.color ?? peer.plan?.color ?? null;
      if (!peer.color && (!color || used.has(color))) color = Array.from({ length: COLORS }, (_, slot) => slot + 1).find((slot) => !used.has(slot)) ?? ((index + mine) % COLORS) + 1;
      used.add(color);
      return { peer, color, hidden: ui.hidden.has(peer.h) };
    });
  }
  const confirmedFused = (list) => list.filter(({ peer }) => peer.mode === 'fused' && peer.verified === 'yes' && peer.status === 'ok');

  function companyFor(list) {
    const set = new Set(store.state.company.keys());
    for (const { peer } of confirmedFused(list)) for (const date of peer.company.keys()) set.add(date);
    return set;
  }
  function contextFor(year, list) {
    const known = holidayYears.get(year);
    return { weekendDays: plan().weekendDays, holidays: known ?? new Set(), company: companyFor(list) };
  }
  function firstYear() {
    let first = ui.year;
    for (const date of store.state.entries.keys()) first = Math.min(first, leaveYearOf(plan(), date));
    for (const year of store.state.allowances.keys()) first = Math.min(first, year);
    return first;
  }
  function summary(list) {
    const ctx = contextFor(ui.year, list);
    const current = usage(store.state.entries, { ...range(), ...ctx });
    const usedOf = (year) => (year === ui.year ? current.used : usage(store.state.entries, { ...leaveYear(plan(), year), ...contextFor(year, list) }).used);
    const totals = balance(ui.year, { allowances: store.state.allowances, carryOver: plan().carryOver ?? 0, usedOf, firstYear: firstYear() });
    const computedCarry = balance(ui.year, { allowances: new Map([...store.state.allowances].map(([year, value]) => [year, year === ui.year ? { days: value.days } : value])), carryOver: plan().carryOver ?? 0, usedOf, firstYear: firstYear() }).carried;
    return { ...totals, comp: current.comp, waived: current.waived, computedCarry };
  }

  function cellFor(date, ctx, list) {
    const status = dayStatus(date, { ...ctx, company: new Set() });
    const own = store.state.entries.get(date) ?? null;
    const publicNames = holidays.publicDays.get(date) ?? [];
    const school = holidays.schoolDays.get(date) ?? [];
    const visible = list.filter(({ hidden, peer }) => !hidden && peer.status !== 'loading');
    const offPeers = visible.filter(({ peer }) => peer.mode === 'fused' && peer.entries.has(date)).map(({ peer, color }) => ({ color, fraction: peer.entries.get(date).fraction, name: nameOf(peer.name) }));
    const rings = visible.filter(({ peer }) => peer.mode === 'view' && peer.entries.has(date)).map(({ peer, color }) => ({ color, fraction: peer.entries.get(date).fraction, name: nameOf(peer.name) }));
    const bands = [...(school.length ? [{ color: SCHOOL_COLOR, name: school.join(', ') }] : []),
      ...[...holidays.bands.values()].filter((band) => band.days.has(date)).map((band) => ({ color: band.color, name: band.days.get(date).join(', ') || band.label }))];
    const company = ctx.company.has(date);
    const dayTrips = trips.get(date) ?? [];
    const parts = [];
    if (own) parts.push(t(`vacay.cell.${own.kind === 'comp' ? 'comp' : 'vacation'}${own.fraction === 0.5 ? 'Half' : ''}`));
    if (status === 'weekend') parts.push(t('vacay.cell.weekend'));
    if (publicNames.length) parts.push(t('vacay.cell.holiday', { name: publicNames.join(', ') }));
    if (company) parts.push(t('vacay.cell.company'));
    for (const band of bands) parts.push(t('vacay.cell.calendar', { name: band.name }));
    for (const peer of offPeers) parts.push(t(peer.fraction === 0.5 ? 'vacay.cell.peerHalf' : 'vacay.cell.peerOff', { name: peer.name }));
    for (const ring of rings) parts.push(t(ring.fraction === 0.5 ? 'vacay.cell.peerHalf' : 'vacay.cell.peerOff', { name: ring.name }));
    for (const trip of dayTrips) parts.push(t('vacay.cell.trip', { name: trip.title }));
    const title = formatDate(date, { weekday: true, style: 'long' });
    return {
      status, own, ownColor: plan().color ?? 1, company, peers: offPeers, rings, bands, trips: dayTrips, publicNames, school, selected: date === ui.selected,
      label: parts.length ? `${title}: ${parts.join('; ')}` : title,
    };
  }

  // ---- rendering ----
  function renderHead() {
    const label = yearLabel(range());
    head.replaceChildren(
      el('div.vacay-year', {},
        iconButton('chevronLeft', t('vacay.prevYear'), { dataset: { focus: 'prev' }, onclick: () => setYear(ui.year - 1) }),
        el('h2.vacay-year-label', { 'aria-live': 'polite' }, t('vacay.yearTitle', { year: label })),
        iconButton('chevronRight', t('vacay.nextYear'), { dataset: { focus: 'next' }, onclick: () => setYear(ui.year + 1) }),
        button(t('vacay.today'), { size: 'sm', variant: 'ghost', dataset: { focus: 'today' }, onclick: () => { const today = localToday(); ui.selected = today; setYear(leaveYearOf(plan(), today)); } })),
      el('div.vacay-head-actions', {},
        button(t('vacay.calendars'), { size: 'sm', variant: 'outline', icon: 'calendar', dataset: { focus: 'calendars' }, onclick: openCalendars }),
        button(t('vacay.settings'), { size: 'sm', variant: 'outline', icon: 'more', dataset: { focus: 'settings' }, onclick: openSettings })));
  }
  function renderBanners(list) {
    const notes = [];
    if (!online()) notes.push(['offline', t('vacay.banner.offline')]);
    if (list.some(({ peer }) => peer.status === 'credit')) notes.push(['credit', t('vacay.banner.credit')]);
    if (holidays.missing) notes.push(['holidays', t('vacay.banner.holidays')]);
    banner.replaceChildren(...notes.map(([kind, text]) => el('p.offline-bar', { dataset: { banner: kind }, role: kind === 'offline' ? 'status' : null }, text)));
  }
  function renderToolbar() {
    const mode = segmented({ label: t('vacay.modeLabel'), value: ui.mode, items: MODES.map((value) => ({ value, label: t(`vacay.mode.${value}`) })),
      onChange: (value) => { ui.mode = value; writeUi(uiKey, ui); } });
    toolbar.replaceChildren(mode.element, el('p.vacay-hint', {}, t('vacay.rangeHint')));
  }
  function renderLegend() {
    const item = (cls, text) => el('li', {}, el(`span.vacay-key.${cls}`, { 'aria-hidden': 'true' }), text);
    legend.replaceChildren(el('ul.vacay-legend', { 'aria-label': t('vacay.legend'), style: { '--own': `var(--day-${plan().color ?? 1})` } },
      item('key-own', t('vacay.legendOwn')), item('key-half', t('vacay.legendHalf')), item('key-comp', t('vacay.legendComp')),
      item('key-company', t('vacay.legendCompany')), item('key-holiday', t('vacay.legendHoliday')), item('key-weekend', t('vacay.legendWeekend')),
      item('key-band', t('vacay.legendBand')), item('key-bar', t('vacay.legendFused')), item('key-ring', t('vacay.legendView')), item('key-trip', t('vacay.legendTrip'))));
  }
  function renderStats(list) {
    const totals = summary(list);
    const stat = (value, label, focus) => el('div.stat', { dataset: { focus } }, el('strong', {}, value), el('span', {}, label));
    stats.replaceChildren(el('section.vacay-card', { 'aria-labelledby': 'vacay-stats-title' },
      el('div.vacay-card-head', {}, el('h2', { id: 'vacay-stats-title' }, t('vacay.stats', { year: yearLabel(range()) })),
        button(t('vacay.editAllowance'), { size: 'sm', variant: 'ghost', icon: 'pencil', dataset: { focus: 'allowance' }, disabled: !editable(), onclick: () => openAllowance(totals) })),
      el('div.vacay-stats', {},
        stat(daysText(totals.total), totals.carried ? t('vacay.statTotalCarried', { days: daysText(totals.days), carried: daysText(totals.carried) }) : t('vacay.statTotal'), 'stat-total'),
        stat(daysText(totals.used), t('vacay.statUsed'), 'stat-used'),
        stat(daysText(totals.remaining), totals.remaining < 0 ? t('vacay.statOver') : t('vacay.statRemaining'), 'stat-remaining'),
        stat(daysText(totals.comp), t('vacay.statComp'), 'stat-comp')),
      totals.waived ? el('p.vacay-hint', {}, t('vacay.waived', { days: daysText(totals.waived) })) : null));
  }
  // Re-renders keep focus on the control at the same position (segmented buttons have no stable id).
  function focusPath(region) {
    let node = document.activeElement;
    if (!region.contains(node) || node === region) return null;
    const path = [];
    while (node && node !== region) { path.unshift([...node.parentNode.children].indexOf(node)); node = node.parentNode; }
    return path;
  }
  function restorePath(region, path) {
    let node = region;
    for (const index of path ?? []) { node = node?.children[index]; if (!node) return; }
    if (path && node !== region) node.focus?.({ preventScroll: true });
  }
  function renderDetails(list) {
    if (details.contains(document.activeElement) && document.activeElement.matches('input,textarea')) return;
    const path = focusPath(details);
    paintDetails(list);
    restorePath(details, path);
  }
  function paintDetails(list) {
    const date = ui.selected;
    if (!date || date < range().start || date > range().end) { details.replaceChildren(el('section.vacay-card', {}, el('p.vacay-hint', {}, t('vacay.pickDay')))); return; }
    const ctx = contextFor(ui.year, list);
    const cell = cellFor(date, ctx, list);
    const facts = [];
    if (cell.status === 'weekend') facts.push(t('vacay.cell.weekend'));
    for (const name of cell.publicNames) facts.push(t('vacay.cell.holiday', { name }));
    if (store.state.company.has(date)) facts.push(t('vacay.detailCompanyOwn'));
    for (const { peer } of confirmedFused(list)) if (peer.company.has(date)) facts.push(t('vacay.detailCompanyFrom', { name: nameOf(peer.name) }));
    for (const band of cell.bands) facts.push(band.name);
    const own = cell.own;
    const canBook = bookable(date, ctx) && editable();
    const amount = segmented({ label: t('vacay.detailAmount'), radio: true, value: own ? (own.fraction === 0.5 ? 'half' : 'full') : 'off',
      items: ['off', 'full', 'half'].map((value) => ({ value, label: t(`vacay.amount.${value}`), disabled: !canBook && value !== (own ? (own.fraction === 0.5 ? 'half' : 'full') : 'off') })),
      onChange: (value) => saveEntry(date, value === 'off' ? null : { fraction: value === 'half' ? 0.5 : 1, kind: own?.kind ?? 'vacation', ...(own?.note ? { note: own.note } : {}) }) });
    const kind = segmented({ label: t('vacay.detailKind'), radio: true, value: own?.kind ?? 'vacation',
      items: ['vacation', 'comp'].map((value) => ({ value, label: t(`vacay.kind.${value}`), disabled: !own || !canBook })),
      onChange: (value) => own && saveEntry(date, { ...own, kind: value }) });
    const note = field({ label: t('vacay.note'), hint: t('vacay.noteHint'), value: own?.note ?? '', maxLength: NOTE_MAX, disabled: !own || !editable(), dataset: { focus: 'note' } });
    note.input.addEventListener('change', () => { if (own) saveEntry(date, { ...own, note: note.input.value.trim() || undefined }); });
    const others = [...cell.peers, ...cell.rings];
    details.replaceChildren(el('section.vacay-card.vacay-details', { 'aria-labelledby': 'vacay-day-title' },
      el('h2', { id: 'vacay-day-title' }, formatDate(date, { weekday: true, style: 'long' })),
      facts.length ? el('ul.vacay-facts', {}, facts.map((fact) => el('li', {}, fact))) : null,
      el('div.vacay-entry', {}, amount.element, kind.element, note.element),
      bookable(date, ctx) ? null : el('p.vacay-hint', {}, t('vacay.notBookable')),
      others.length ? el('div', {}, el('h3.vacay-subhead', {}, t('vacay.othersOff')), el('ul.vacay-facts', {}, others.map((item) => el('li', {},
        el('span.vacay-swatch', { 'aria-hidden': 'true', style: { '--mark': `var(--day-${item.color})` } }), t(item.fraction === 0.5 ? 'vacay.cell.peerHalf' : 'vacay.cell.peerOff', { name: item.name }))))) : null,
      cell.trips.length ? el('div', {}, el('h3.vacay-subhead', {}, t('vacay.tripsOn')), el('ul.vacay-facts', {}, cell.trips.map((trip) => el('li', {}, el('a', { href: `${spaceRoute(trip.ref)}` }, trip.title))))) : null));
  }
  function renderPeoplePanel(list) {
    const ctx = contextFor(ui.year, list);
    const r = range();
    const peerDays = (peer) => { let sum = 0; for (const [date, entry] of peer.entries) if (date >= r.start && date <= r.end && entry.kind !== 'comp' && bookable(date, ctx)) sum += entry.fraction; return sum; };
    const fusedUids = new Set(list.filter(({ peer }) => peer.mode === 'fused').map(({ peer }) => peer.uid));
    const model = {
      available: Boolean(sharing?.state.available),
      me: { color: plan().color ?? 1, used: usage(store.state.entries, { ...r, ...ctx }).used },
      peers: list.map((item) => ({ ...item, days: peerDays(item.peer) })),
      grants: Object.entries(store.state.grants).map(([h, grant]) => ({ h, grant, linked: grant.mode === 'fused' && Boolean(grant.uid) && fusedUids.has(grant.uid) })),
      incoming: sharing ? [...sharing.state.incoming.values()] : [],
    };
    keepFocus(people, () => people.replaceChildren(renderPeople(model, peopleActions, { busy: ui.busy })));
  }
  function renderGridBox(list) {
    const hadFocus = gridBox.contains(document.activeElement) ? document.activeElement.dataset?.date : null;
    const ctx = contextFor(ui.year, list);
    const r = range();
    const focusDate = ui.selected && ui.selected >= r.start && ui.selected <= r.end ? ui.selected : (localToday() >= r.start && localToday() <= r.end ? localToday() : r.start);
    gridBox.replaceChildren(renderGrid({ plan: plan(), year: ui.year, range: r, weekStart: plan().weekStart, focusDate, today: localToday(),
      cellFor: (date) => cellFor(date, ctx, list), onActivate: activate, onFocus: (date) => {
        ui.selected = date;
        for (const node of gridBox.querySelectorAll('.vacay-day.is-selected')) node.classList.remove('is-selected');
        gridBox.querySelector(`button.vacay-day[data-date="${date}"]`)?.classList.add('is-selected');
        renderSide();
      } }));
    if (hadFocus) moveFocus(gridBox, focusDate);
  }
  function keepFocus(region, render) {
    const key = region.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    render();
    if (key) [...region.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key)?.focus({ preventScroll: true });
  }
  function renderSide() {
    const list = peerList();
    keepFocus(stats, () => renderStats(list));
    renderDetails(list);
  }
  function renderAll() {
    renderQueued = false;
    if (destroyed || !store?.state.loaded) return;
    const list = peerList();
    keepFocus(head, renderHead);
    renderBanners(list);
    renderGridBox(list);
    renderLegend();
    keepFocus(stats, () => renderStats(list));
    renderDetails(list);
    renderPeoplePanel(list);
  }
  const queueRender = () => { if (!renderQueued) { renderQueued = true; queueMicrotask(renderAll); } };

  function layout() {
    renderToolbar();
    root.replaceChildren(announcer, head, banner,
      el('div.vacay-layout', {},
        el('div.vacay-main', {}, toolbar, gridBox, legend),
        el('aside.vacay-side', { 'aria-label': t('vacay.sideLabel') }, stats, details, people)));
    renderAll();
  }

  // ---- editing ----
  function desired(existing) {
    if (ui.mode === 'company') return null;
    return { fraction: ui.mode === 'half' ? 0.5 : 1, kind: ui.mode === 'comp' ? 'comp' : 'vacation', ...(existing?.note ? { note: existing.note } : {}) };
  }
  const same = (a, b) => Boolean(a && b && a.fraction === b.fraction && a.kind === b.kind);
  function saveEntry(date, entry) {
    if (!editable()) { toast(t('vacay.banner.offline')); return; }
    store.setEntry(date, entry).catch(fail);
  }
  function blockedReason(date, ctx) {
    const status = dayStatus(date, { ...ctx, company: new Set() });
    return status === 'weekend' ? t('vacay.blockedWeekend') : status === 'holiday' ? t('vacay.blockedHoliday') : null;
  }
  function toggle(date) {
    const list = peerList();
    const ctx = contextFor(ui.year, list);
    const blocked = blockedReason(date, ctx);
    if (blocked) { announce(blocked); toast(blocked); return; }
    if (ui.mode === 'company') {
      const on = store.state.company.has(date);
      store.setCompany(date, on ? null : {}).catch(fail);
      announce(t(on ? 'vacay.companyRemoved' : 'vacay.companyAdded', { date: formatDate(date) }));
      return;
    }
    const existing = store.state.entries.get(date);
    const next = desired(existing);
    const remove = same(existing, next);
    saveEntry(date, remove ? null : next);
    announce(t(remove ? 'vacay.dayRemoved' : 'vacay.daySet', { date: formatDate(date), what: t(`vacay.mode.${ui.mode}`) }));
  }
  async function applyRange(from, to) {
    const ctx = contextFor(ui.year, peerList());
    const dates = bookableRange(from, to, ctx).filter((date) => date >= range().start && date <= range().end);
    if (!dates.length) return;
    let failures;
    if (ui.mode === 'company') {
      const remove = dates.every((date) => store.state.company.has(date));
      failures = await settled(dates, 4, (date) => store.setCompany(date, remove ? null : {}));
    } else {
      const remove = dates.every((date) => same(store.state.entries.get(date), desired(null)));
      failures = await settled(dates, 4, (date) => store.setEntry(date, remove ? null : desired(store.state.entries.get(date))));
    }
    announce(plural('vacay.rangeApplied', dates.length));
    if (failures.length) fail(failures[0]);
  }
  function activate(date, event) {
    ui.selected = date;
    if (!editable()) { if (!online()) toast(t('vacay.banner.offline')); queueRender(); return; }
    if (event?.shiftKey && ui.anchor && ui.anchor !== date) void applyRange(ui.anchor, date);
    else toggle(date);
    ui.anchor = date;
    queueRender();
  }
  function setYear(year) {
    ui.year = year;
    ui.anchor = null;
    queueRender();
    void refreshHolidays();
    void pollNow();
  }

  // ---- dialogs ----
  function openSettings() {
    openSettingsDialog({ plan: plan(), services: services(), lang: locale, submit: async (next) => {
      await store.setPlan(next);
      ui.year = leaveYearOf(plan(), ui.selected ?? localToday());
      holidayYears.clear();
      queueRender();
      void refreshHolidays(true);
      toast(t('vacay.settingsSaved'));
    } });
  }
  function openAllowance(totals) {
    const storedValue = store.state.allowances.get(ui.year);
    openAllowanceDialog({ yearText: yearLabel(range()), days: totals.days, carried: storedValue?.carried, stored: Boolean(storedValue), computedCarry: totals.computedCarry,
      submit: (value) => store.setAllowance(ui.year, value), remove: () => store.setAllowance(ui.year, null) });
  }
  function openCalendars() {
    openCalendarsDialog({ calendars: () => store.state.calendars, services: services(), lang: locale, save: async (id, value) => { await store.setCalendar(id, value); void refreshHolidays(true); } });
  }

  // ---- sharing ----
  async function run(task, done) {
    if (ui.busy) return;
    ui.busy = true; queueRender();
    try { const result = await task(); if (done) toast(done); return result; } catch (error) { fail(error); } finally { ui.busy = false; queueRender(); }
  }
  const peopleActions = {
    invite: () => openInviteDialog({ submit: async ({ username, mode }) => {
      await sharing.invite({ username, mode });
      toast(t(mode === 'fused' ? 'vacay.invitedFused' : 'vacay.invitedView', { name: username.trim() }));
      queueRender();
    } }),
    accept: (h) => run(async () => { const peer = await sharing.accept(h); if (peer) { await sharing.loadPeer(peer, range()); void sharing.watchPeer(peer, range); } }, t('vacay.accepted')),
    decline: (h) => run(() => sharing.decline(h), t('vacay.declined')),
    leave: async (h) => {
      const peer = sharing.state.peers.get(h);
      const name = nameOf(peer?.name);
      const fused = peer?.mode === 'fused';
      if (!await confirmDialog({ title: t(fused ? 'vacay.dissolveTitle' : 'vacay.removeOverlayTitle', { name }), body: t(fused ? 'vacay.dissolveBody' : 'vacay.removeOverlayBody', { name }), confirmLabel: t(fused ? 'vacay.dissolve' : 'vacay.removeOverlay'), danger: true })) return;
      await run(() => sharing.leave(h), t(fused ? 'vacay.dissolved' : 'vacay.overlayRemoved', { name }));
    },
    revoke: async (h) => {
      const grant = store.state.grants[h];
      const name = nameOf(grant?.name);
      if (!await confirmDialog({ title: t('vacay.stopSharingTitle', { name }), body: t('vacay.stopSharingBody', { name }), confirmLabel: t('vacay.stopSharing'), danger: true })) return;
      await run(() => sharing.revoke(h), t('vacay.sharingStopped', { name }));
    },
    upgrade: (h) => run(() => sharing.upgrade(h), t('vacay.upgraded', { name: nameOf(store.state.grants[h]?.name) })),
    toggle: (h) => { if (ui.hidden.has(h)) ui.hidden.delete(h); else ui.hidden.add(h); writeUi(uiKey, ui); queueRender(); },
    color: (h, slot) => { sharing.setColor(h, slot).catch(fail); },
    myColor: (slot) => { store.setPlan({ ...store.state.plan, color: slot }).catch(fail); },
  };

  async function refreshSharing({ force = false } = {}) {
    if (!sharing?.state.available || destroyed || !online()) return;
    if (!force && Date.now() - lastRefresh < REFRESH_MS) return;
    lastRefresh = Date.now();
    try { await sharing.discover(); await sharing.reconcile(); } catch (error) { if (!['disabled', 'offline'].includes(errorCode(error))) fail(error); }
    queueRender();
  }
  async function pollNow() {
    clearTimeout(pollTimer);
    if (destroyed || !sharing) return;
    if (!document.hidden && online() && sharing.state.available) {
      await sharing.poll(range());
      for (const peer of sharing.state.peers.values()) void sharing.watchPeer(peer, range);
      queueRender();
    }
    if (!destroyed) pollTimer = setTimeout(() => { void pollNow(); }, POLL_MS);
  }

  // ---- holidays and trips ----
  async function refreshHolidays(force = false) {
    const r = range();
    const config = JSON.stringify([r, plan().holidays ?? null, plan().school ?? null, [...store.state.calendars]]);
    if (!force && config === holidayKey) return;
    holidayKey = config;
    holidayAbort?.abort();
    const controller = new AbortController();
    holidayAbort = controller;
    try {
      const result = await loadHolidays({ services: services(), plan: plan(), calendars: store.state.calendars, range: r, signal: controller.signal });
      if (destroyed || controller.signal.aborted) return;
      holidays = result;
      holidayYears.set(ui.year, new Set(result.publicDays.keys()));
      queueRender();
    } catch (error) {
      if (error?.name !== 'AbortError' && !destroyed) { holidays = { ...holidays, missing: true }; queueRender(); }
    }
  }
  async function reloadTrips() {
    let entries = [];
    try { entries = await personal?.spaces?.list?.() ?? []; } catch { entries = []; }
    const next = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry?.ref?.k !== 'trip' || !isDate(entry.start) || !isDate(entry.end) || entry.end < entry.start) continue;
      const trip = { ref: entry.ref, title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : t('vacay.untitledTrip') };
      for (let date = entry.start, n = 0; date <= entry.end && n < 366; date = addDays(date, 1), n++) { const list = next.get(date) ?? []; list.push(trip); next.set(date, list); }
    }
    trips = next;
    if (!destroyed) queueRender();
  }
  async function knownHandles() {
    try { return new Set((await personal?.spaces?.list?.() ?? []).flatMap((entry) => entry?.handles ? [entry.handles.read, entry.handles.write] : [])); } catch { return new Set(); }
  }

  // ---- startup ----
  async function start() {
    root.replaceChildren(announcer, el('div.vacay-state', {}, spinner(), el('p', {}, t('vacay.loading'))));
    store?.close(); sharing?.close();
    if (!puter?.kv) { showError(new Error('unavailable')); return; }
    store = createVacayStore({ puter });
    try { await store.load(); } catch (error) { if (!destroyed) showError(error); return; }
    if (destroyed) { store.close(); return; }
    sharing = createVacaySharing({ puter, store, account, knownHandles, label: (name) => t('vacay.shareLabel', { name: name || t('vacay.someone') }) });
    const today = localToday();
    ui.year = leaveYearOf(plan(), today);
    ui.selected ??= today;
    store.subscribe((change) => {
      if (change.type === 'gap') { void store.load().then(queueRender, () => {}); return; }
      if (change.type === 'plan' || change.type === 'cal') void refreshHolidays();
      queueRender();
    });
    sharing.subscribe((change) => {
      if (change.type === 'gone') toast(t('vacay.peerGone', { name: nameOf(change.name) }));
      if (change.type === 'grants') for (const event of change.events ?? []) toast(t(event.type === 'left' ? 'vacay.grantLeft' : 'vacay.grantRevoked', { name: nameOf(event.name) }));
      queueRender();
    });
    layout();
    void store.watch();
    void sharing.watchInvites(() => {
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => { void refreshSharing({ force: true }).then(pollNow); }, NOTIFY_DELAY_MS);
    });
    void refreshHolidays();
    void reloadTrips();
    void refreshSharing({ force: true }).then(pollNow);
  }
  function showError(error) {
    const code = errorCode(error);
    root.replaceChildren(announcer, el('div.vacay-state', {}, el('h2.sr-only', {}, t('vacay.planHeading')), emptyState({ title: t('vacay.loadError'), body: t(`vacay.error.${['offline', 'credit'].includes(code) ? code : 'failed'}`), icon: 'warning',
      action: button(t('vacay.retry'), { variant: 'primary', onclick: () => { void start(); } }) })));
  }

  const visibility = () => { if (!document.hidden) { void refreshSharing(); void pollNow(); } };
  const connectivity = () => { queueRender(); if (online()) { void refreshHolidays(true); void refreshSharing({ force: true }).then(pollNow); } };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
  cleanups.push(() => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); });
  if (personal?.subscribe) cleanups.push(personal.subscribe('me:spaces', () => { void reloadTrips(); }));
  cleanups.push(onPrefs((_prefs, changed) => { if (new Set(changed ?? []).has('dateFormat')) queueRender(); }));
  signal?.addEventListener('abort', () => { destroyed = true; }, { once: true });

  await start();

  return () => {
    destroyed = true;
    clearTimeout(pollTimer); clearTimeout(notifyTimer);
    holidayAbort?.abort();
    store?.close(); sharing?.close();
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* Keep tearing down. */ } }
  };
}
