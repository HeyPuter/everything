import './road.css';
import { el } from '../../../ui/dom.js';
import { chip } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale } from '../../../lib/prefs.js';
import { formatDistance, formatDuration } from '../../../lib/format.js';
import { refreshPlanHooks, registerPlanHooks } from '../plan/hooks.js';
import { roadState } from './state.js';
import { createRoadOps } from './ops.js';
import { icon } from './icons.js';

const HOOK_DELAY = 400;
const viewKey = (spaceId) => `trips:road:${spaceId}`;
function readView(spaceId) { try { return localStorage.getItem(viewKey(spaceId)) === 'road' ? 'road' : 'days'; } catch { return 'days'; } }
function saveView(spaceId, value) { try { localStorage.setItem(viewKey(spaceId), value); } catch { /* A convenience only. */ } }

/**
 * Road-trip mode in the Plan tab: a Days / Road trip switch above the day list (the road view loads on first use), a
 * driving line under each day header (`dayInfo` hook), service stops hidden from the days view when asked, and the
 * shared state the planner map's overlay reads. `pane` is the Plan tab pane context. Returns the cleanup.
 */
export function mountRoadTrip(pane, { daysPane }) {
  const { space, session, plan } = pane;
  if (!space?.select?.rtPrefs || !daysPane || !plan) return () => {};
  const state = roadState(space, session);
  const ops = createRoadOps(space);
  const release = state.retain();
  const spaceId = space.ref?.s ?? 'trip';
  let lang = 'en';
  try { lang = displayLocale(); } catch { /* English. */ }
  let current = readView(spaceId);
  let panel = null; let loading = null; let destroyed = false; let hookTimer = 0;
  const controller = new AbortController();

  const switcher = segmented({
    label: t('road.switch'), value: current,
    items: [{ value: 'days', label: t('plan.title'), icon: 'calendar' }, { value: 'road', label: t('road.title'), icon: 'map' }],
    onChange: (value) => show(value),
  });
  const bar = el('div.road-switch', {}, switcher.element);
  const host = el('div.road-host', { hidden: true });
  daysPane.prepend(bar);
  daysPane.append(host);

  function mountPanel() {
    if (panel || loading) return;
    loading = import('./panel.js').then(({ mountRoadPanel }) => {
      if (destroyed) return;
      panel = mountRoadPanel(host, { space, session, plan, state, ops, lang, account: pane.account, signal: controller.signal });
    }).catch(() => { host.replaceChildren(el('p.view-error', { role: 'alert' }, t('app.viewError'))); }).finally(() => { loading = null; });
  }
  function show(value, { save = true } = {}) {
    const visible = state.enabled() || state.canTrip();
    current = visible ? value : 'days';
    switcher.setValue(current);
    daysPane.dataset.roadView = current;
    host.hidden = current !== 'road';
    if (current === 'road') mountPanel();
    state.setActive(current === 'road');
    if (save) saveView(spaceId, current);
  }
  // The days view re-renders for the driving line only when a day's numbers change.
  let signature = '';
  function sync() {
    const enabled = state.enabled();
    bar.hidden = !enabled && !state.canTrip();
    if (bar.hidden && current === 'road') show('days', { save: false });
    daysPane.toggleAttribute('data-road-hide-stops', enabled && !state.prefs().showStops);
    const next = enabled ? JSON.stringify(state.view().schedule.days.map((day) => [day.index, Math.round(day.drive), Math.round(day.distance / 100), day.overDaily, day.overWindow])) : '';
    if (next === signature) return;
    signature = next;
    clearTimeout(hookTimer);
    hookTimer = setTimeout(() => { if (!destroyed) refreshPlanHooks(); }, HOOK_DELAY);
  }

  function dayInfo({ entry, context }) {
    if (context?.space !== space || !state.enabled()) return null;
    const view = state.view();
    const stats = view.schedule.days.find((item) => item.index === entry.index);
    if (!stats?.drive) return null;
    const label = t('road.day.drive', { duration: formatDuration(Math.round(stats.drive)), distance: formatDistance(stats.distance) });
    return el('button.road-dayinfo', { type: 'button', title: t('road.openDay'), onclick: () => show('road') },
      icon('car', 14), el('span', {}, label), stats.overDaily && chip(t('road.day.overDaily'), { status: 'warn' }), stats.overWindow && chip(t('road.day.overWindow'), { status: 'warn' }));
  }

  const offs = [
    registerPlanHooks({ dayInfo }),
    state.subscribe(sync),
  ];
  sync();
  show(current, { save: false });

  return () => {
    destroyed = true;
    controller.abort();
    clearTimeout(hookTimer);
    for (const off of offs) off();
    state.setActive(false);
    panel?.destroy();
    release();
    bar.remove(); host.remove();
    delete daysPane.dataset.roadView;
    daysPane.removeAttribute('data-road-hide-stops');
  };
}
