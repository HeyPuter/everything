import './shell.css';
import { el } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { button } from '../../ui/bits.js';
import { openMenu } from '../../ui/menu.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { routeHash } from '../../lib/router.js';
import { tripDates } from './settings/meta.js';
import { presenceStack } from './members/people.js';
import { registerCalendarCommand } from '../ics/command.js';
import { registerPrintCommand } from '../print/command.js';
import { registerAssistantCommand } from './assistant/command.js';
import { openTripExport, openTripImport } from '../io/entry.js';
import { openJourneyFromTrip } from '../journey/command.js';

const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;
const INDEX_DELAY = 2000;
const OPENED_EVERY = 60 * 60_000;

/**
 * Trip routes for the shell: one space per trip through `session.openTrip`, shared by its tabs and closed on leaving,
 * plus the per-trip header extras (sync state, banners, presence, badges, menu, palette commands).
 */
export function createTripRoute({ session, app = null, puter = null, setSyncState, navigate, onTitle = () => {}, onRefused = () => {}, reload = () => globalThis.location.reload() }) {
  let current = null;
  let view = null;
  let tabList = [];
  let route = null;

  function title() {
    const meta = current?.handle.space?.get('meta', 'meta');
    return meta?.title || current?.entry?.title || t('trip.untitled');
  }
  function ownerName(space) {
    return space.members().find((member) => member.role === 'owner')?.name || t('trip.ownerFallback');
  }
  function banner(tone, text, ...actions) {
    return el(`div.trip-banner.trip-banner-${tone}`, { role: tone === 'danger' ? 'alert' : 'status' },
      icon(tone === 'danger' ? 'warning' : tone === 'credit' ? 'wallet' : 'offline', 18), el('p', {}, text), actions.length ? el('div.trip-banner-actions', {}, actions) : null);
  }
  async function removeFromList(control) {
    if (!current) return;
    const ref = current.handle.ref;
    control?.setAttribute('aria-busy', 'true');
    try { await session.personal.spaces.remove(ref); navigate('#/'); }
    catch { control?.setAttribute('aria-busy', 'false'); onRefused('trip.removeFailed'); }
  }
  function renderBanners() {
    if (!view || !current) return;
    const space = current.handle.space;
    const nodes = [];
    if (current.error) {
      nodes.push(banner('danger', t('trip.openError'), button(t('trip.retry'), { size: 'sm', onclick: retryOpen })));
    } else if (space) {
      const { issue, skipped, sync } = space.state;
      if (issue === 'credit') nodes.push(banner('credit', t('trip.bannerCredit')));
      if (issue === 'outdated') {
        nodes.push(skipped > 0
          ? banner('warn', t('trip.bannerOutdatedApp'), button(t('trip.reload'), { size: 'sm', onclick: reload }))
          : banner('warn', t('trip.bannerOutdatedWorker', { owner: ownerName(space) })));
      }
      if (issue === 'gone' || sync === 'forbidden') {
        const remove = button(t('trip.removeFromList'), { size: 'sm', onclick: () => removeFromList(remove) });
        nodes.push(banner('danger', t(issue === 'gone' ? 'trip.bannerGone' : 'trip.bannerForbidden'), remove));
      }
    }
    view.banners.replaceChildren(...nodes);
    view.banners.hidden = !nodes.length;
  }
  function renderHeader() {
    if (!view || !current) return;
    onTitle(title());
    view.subtitle.textContent = tripDates(current.handle.space?.get('meta', 'meta'));
  }
  /** Re-attaches the per-trip nodes (they outlive a tab switch) to the current render. */
  function renderExtras() {
    if (!view || !current) return;
    const { extras } = current;
    view.presence.replaceChildren(...(extras.presence ? [extras.presence] : []));
    view.notice.replaceChildren(...(extras.notice ? [extras.notice] : []));
    for (const [id, node] of extras.badges) view.nav.querySelector(`[data-tab="${id}"]`)?.append(node);
    view.menu.disabled = !current.context;
  }
  function reflect() {
    const state = current?.handle.space?.state;
    if (state) setSyncState(state.sync, { pending: state.pending });
    renderBanners();
  }

  /** Keeps the `me:spaces` cache in step with the trip meta (title, dates, cover) and the last-opened time. */
  function scheduleIndex() {
    if (!current) return;
    clearTimeout(current.indexTimer);
    const target = current;
    target.indexTimer = setTimeout(async () => {
      const space = target.handle.space;
      const meta = space?.get('meta', 'meta');
      const role = space?.role ?? target.entry?.role;
      if (!meta || !role || target !== current) return;
      const entry = target.entry ?? {};
      const next = { ref: target.handle.ref, role, title: meta.title, ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}), ...(meta.cover ? { cover: meta.cover } : {}) };
      const stale = entry.title !== next.title || (entry.start ?? null) !== (next.start ?? null) || (entry.end ?? null) !== (next.end ?? null)
        || JSON.stringify(entry.cover ?? null) !== JSON.stringify(next.cover ?? null) || entry.role !== role;
      if (!stale && Date.now() - (entry.opened ?? 0) < OPENED_EVERY) return;
      try { target.entry = await session.personal.spaces.upsert({ ...next, opened: Date.now() }); } catch { /* A cache; the next change retries. */ }
    }, INDEX_DELAY);
  }

  /** The context trip-wide entry points get: the tab context minus the tab, aborted when the trip closes. */
  function tripContext(entry, space) {
    const ref = { ...entry.handle.ref };
    return {
      app, puter, session, account: { ...session.account }, personal: session.personal, ref, space, signal: entry.controller.signal,
      get route() { return route && sameRef(route.ref, ref) ? route : { name: 'space', ref, tab: 'plan' }; },
      // The assistant's date suggestions open the re-date preview.
      redate: async (dates) => {
        if (!space.can('trip.edit')) { toast(t('trip.errorForbidden')); return false; }
        // The preview pulls in the worker's re-date planner, so it loads on first use.
        const { confirmRedate } = await import('./settings/redate.js');
        return confirmRedate(space, dates, { force: true });
      },
    };
  }
  /** Runs `use(module)` once `load()` resolves while the trip is still open; its cleanup runs on leaving. */
  function later(entry, load, use) {
    load().then((module) => {
      if (current !== entry) return;
      const off = use(module);
      if (typeof off === 'function') entry.offs.push(off);
    }).catch(() => {});
  }
  function remindTodos(entry, space) {
    let done = false;
    const check = () => {
      if (done || current !== entry || (!space.get('meta', 'meta') && !space.state.rev)) return;
      done = true;
      // Same once-a-day key as the Lists tab, so the reminder shows once wherever the trip opens.
      Promise.all([import('./lists/index.js'), import('./lists/model.js'), import('./lists/common.js')]).then(([lists, model, common]) => {
        if (current !== entry) return;
        const due = lists.dueTodos(space, session.account.uuid);
        if (!due.length) return;
        const key = `trips:lists:reminded:${space.ref.s}`;
        const today = model.localToday();
        try { if (globalThis.localStorage?.getItem(key) === today) return; globalThis.localStorage?.setItem(key, today); } catch { /* remind every time */ }
        toast(common.plural(due.length, 'lists.reminderOne', 'lists.reminderOther'), { duration: 10_000,
          action: { label: t('lists.reminderShow'), onClick: () => navigate(routeHash({ name: 'space', ref: space.ref, tab: 'lists' })) } });
      }).catch(() => {});
    };
    check();
    if (!done) entry.offs.push(space.onState(check));
  }
  function startTrip(entry, space) {
    const context = tripContext(entry, space);
    entry.context = context;
    entry.offs.push(registerCalendarCommand(context), registerPrintCommand(context), registerAssistantCommand(context));
    const presence = presenceStack(space, { uid: session.account.uuid, puter });
    entry.extras.presence = presence.element;
    entry.offs.push(() => presence.destroy());
    later(entry, () => import('../../lib/notify/settings.js'), (module) => module.registerReminderCommand(context));
    later(entry, () => import('./transfer/index.js'), (module) => {
      // The Plan tab sizes its panes from their offset, so a notice appearing above it needs a re-measure.
      const notice = module.watchTransfer(context, { onChange: () => globalThis.dispatchEvent?.(new Event('resize')) });
      const off = module.registerTransferCommand(context);
      entry.extras.notice = notice.element; renderExtras();
      return () => { off(); notice.destroy(); };
    });
    for (const tab of tabList.filter((item) => typeof item.badge === 'function')) {
      later(entry, tab.badge, (module) => {
        const badge = module.unreadBadge(space);
        entry.extras.badges.set(tab.id, badge.element); renderExtras();
        return () => badge.destroy();
      });
    }
    remindTodos(entry, space);
    renderExtras();
  }
  function menuItems(context) {
    const { space } = context;
    const open = (load, name) => () => { load().then((module) => module[name](context)).catch(() => onRefused('trip.actionFailed')); };
    return [
      { label: t('trip.menuAssistant'), onSelect: open(() => import('./assistant/index.js'), 'openAssistant') },
      { label: t('trip.menuCalendar'), icon: 'calendar', onSelect: open(() => import('../ics/index.js'), 'openCalendarExport') },
      { label: t('trip.menuPrint'), icon: 'file', onSelect: open(() => import('../print/index.js'), 'openPrint') },
      { label: t('trip.menuReminders'), icon: 'clock', onSelect: open(() => import('../../lib/notify/settings.js'), 'openReminderSettings') },
      { separator: true },
      ...(space.can('res.edit') ? [{ label: t('trip.menuImportBookings'), icon: 'plane', onSelect: open(() => import('./bookings/import/index.js'), 'openImport') }] : []),
      ...(space.can('plan.edit') ? [
        { label: t('photoDays.menu'), icon: 'calendar', onSelect: open(() => import('./plan/photo-days/index.js'), 'openPhotoDays') },
        { label: t('routeImport.menu'), icon: 'map', onSelect: open(() => import('./plan/route-import/index.js'), 'openRouteImport') },
      ] : []),
      { label: t('trip.menuImport'), onSelect: () => void openTripImport(context) },
      { label: t('trip.menuExport'), onSelect: () => void openTripExport(context) },
      { label: t('trip.menuJourney'), onSelect: () => openJourneyFromTrip(context) },
    ];
  }

  function enter(ref) {
    if (current && sameRef(current.handle.ref, ref)) return current;
    leave();
    const handle = session.openTrip(ref);
    const entry = { handle, entry: null, error: null, offs: [], indexTimer: null, controller: new AbortController(), context: null, extras: { presence: null, notice: null, badges: new Map() } };
    current = entry;
    entry.offs.push(handle.on((kind, value) => {
      if (kind === 'flush' && value?.status === 'rejected') onRefused('trip.changeRefused');
    }));
    session.personal.spaces.list().then((list) => {
      if (current !== entry) return;
      entry.entry = list.find((item) => sameRef(item.ref, ref)) ?? null;
      renderHeader();
    }).catch(() => {});
    handle.ready.then((space) => {
      if (current !== entry) return;
      entry.offs.push(space.onState(reflect));
      entry.offs.push(space.subscribe('meta', () => { renderHeader(); scheduleIndex(); }));
      entry.offs.push(space.subscribe('member', () => renderBanners()));
      reflect(); renderHeader(); scheduleIndex();
      startTrip(entry, space);
    }, (error) => {
      if (current !== entry || error?.code === 'trip_closed') return;
      entry.error = error;
      setSyncState('offline');
      renderBanners();
    });
    return entry;
  }
  function leave() {
    if (!current) return;
    const entry = current; current = null; view = null;
    clearTimeout(entry.indexTimer);
    entry.controller.abort();
    for (const off of entry.offs.splice(0)) { try { off(); } catch { /* keep closing */ } }
    session.closeTrip();
  }
  function retryOpen() {
    if (!current) return;
    const ref = current.handle.ref;
    const hash = location.hash;
    leave();
    enter(ref);
    navigate(hash, { replace: true });
  }

  /** Content for a registered trip tab; `mount` is null only for a tab registered without a module. */
  function render(next, tabs) {
    route = next; tabList = tabs;
    const entry = enter(next.ref);
    const tab = tabs.find((item) => item.id === next.tab);
    const banners = el('div.trip-banners', { hidden: true });
    const subtitle = el('p.trip-subtitle');
    const presence = el('div.trip-presence');
    const notice = el('div.trip-notice');
    const menu = button(t('trip.menu'), { icon: 'more', size: 'sm', variant: 'outline', disabled: !entry.context, onclick: () => { if (current?.context) openMenu(menu, menuItems(current.context)); } });
    const section = el('section.trip-tab-view');
    const nav = el('nav.trip-tabs', { 'aria-label': t('app.tripNavigation') }, tabs.map((item) => el('a.trip-tab', {
      href: routeHash({ ...next, tab: item.id }), 'aria-current': item.id === next.tab ? 'page' : null, dataset: { tab: item.id },
    }, icon(item.icon, 16), t(item.labelKey))));
    const content = el('div.shell-view.trip-view', {}, el('div.trip-head', {}, subtitle, el('div.trip-head-actions', {}, presence, menu)), banners, notice, nav, section);
    view = { banners, subtitle, presence, notice, nav, menu };
    const prepare = async () => {
      const space = await entry.handle.ready;
      space.setView(next.tab);
      return { ref: { ...next.ref }, space };
    };
    queueMicrotask(() => { if (current === entry) { reflect(); renderHeader(); renderExtras(); } });
    return { title: title(), content, mount: tab?.load ? { node: section, load: tab.load, prepare } : null };
  }

  return {
    render, leave,
    /** Resend queued changes, then pull. */
    async retry() {
      const space = current?.handle.space;
      if (!space) { retryOpen(); return; }
      await space.flush();
      await space.sync();
    },
    get active() { return Boolean(current); },
  };
}
