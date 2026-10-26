import './plan.css';
import { el } from '../../../ui/dom.js';
import { emptyState } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { makeDragSource } from '../../../ui/dnd.js';
import { t } from '../../../lib/i18n/index.js';
import { isId } from '../../../shared/ids.js';
import { createPlanState } from './state.js';
import { mountMap } from '../map/index.js';
import { mountPlaces } from '../places/index.js';
import { mountDays } from './days.js';
import { mountDayPanel } from './panel.js';
import { mountWeather } from './weather/index.js';
import { mountSchedule } from './schedule/index.js';
import { mountTransit } from './transit/index.js';
import { mountRouteImport } from './route-import/index.js';
import { mountPhotoDays } from './photo-days/index.js';
import { registerAssistantCommand } from '../assistant/command.js';
import { mountRoadTrip } from '../road/index.js';
import { mountAlternatives } from './alternatives/index.js';

// Three panes from 1280px; the days column plus map or places from 1024px; one pane at a time below.
const WIDE = '(min-width: 1280px)';
const NARROW = '(max-width: 1023px)';
const WIDTHS = 'trips:plan:panes';
const LIMITS = Object.freeze({ days: [300, 640], places: [280, 560] });

function readWidths() {
  try {
    const value = JSON.parse(localStorage.getItem(WIDTHS) ?? '{}');
    return { days: Number(value.days) || 400, places: Number(value.places) || 340 };
  } catch { return { days: 400, places: 340 }; }
}
const clamp = (name, value) => Math.round(Math.max(LIMITS[name][0], Math.min(LIMITS[name][1], value)));

/** Keeps the day panel below the map's search and explore controls, which the map adds once it has loaded. */
function placePanelBelow(mapHost, mapPane) {
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function') return () => {};
  const resize = new ResizeObserver(([entry]) => {
    const top = entry.target;
    mapPane.style.setProperty('--plan-panel-top', `${Math.ceil(top.offsetTop + top.offsetHeight) + 8}px`);
  });
  const watch = () => { const top = mapHost.querySelector('.planmap-top'); if (!top) return false; resize.observe(top); return true; };
  const mutations = new MutationObserver(() => { if (watch()) mutations.disconnect(); });
  if (!watch()) mutations.observe(mapHost, { childList: true, subtree: true });
  return () => { mutations.disconnect(); resize.disconnect(); };
}

/**
 * The Plan tab hosts the days column, the map and the places pool. Desktop shows all three side by side with
 * resizable splits; phones switch between them. The panes share `plan` (see state.js) for selection and events.
 */
export async function mount(container, context) {
  const { space, app } = context;
  if (!space) {
    container.replaceChildren(emptyState({ icon: 'map', title: t('plan.unavailable'), body: t('plan.unavailableBody') }));
    return () => {};
  }
  const plan = createPlanState();
  const pane = { ...context, plan };
  const wide = globalThis.matchMedia?.(WIDE);
  const narrow = globalThis.matchMedia?.(NARROW);
  const layout = () => (wide?.matches ? 'wide' : narrow?.matches || !wide ? 'narrow' : 'medium');
  const widths = readWidths();

  const daysPane = el('section.plan-pane.plan-days-pane', { 'aria-label': t('plan.title') });
  const mapHost = el('div.plan-map-host');
  const panel = el('section.plan-panel', { 'aria-label': t('plan.dayDetails'), hidden: true });
  const mapPane = el('section.plan-pane.plan-map-pane', { 'aria-label': t('plan.map') }, mapHost, panel);
  const placesHost = el('div.plan-places-host');
  // The places module is the "Places" landmark itself.
  const placesPane = el('div.plan-pane.plan-places-pane', {}, placesHost);
  const root = el('div.plan', { dataset: { pane: 'days' } });

  function setWidth(name, value) {
    widths[name] = clamp(name, value);
    root.style.setProperty(`--plan-${name}`, `${widths[name]}px`);
    for (const node of root.querySelectorAll(`[data-split="${name}"]`)) node.setAttribute('aria-valuenow', String(widths[name]));
  }
  function saveWidths() { try { localStorage.setItem(WIDTHS, JSON.stringify(widths)); } catch { /* Width is a convenience. */ } }
  function splitter(name, sign) {
    const node = el('div.plan-split', {
      role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical', 'aria-label': t(name === 'days' ? 'plan.resizeDays' : 'plan.resizePlaces'),
      'aria-valuemin': String(LIMITS[name][0]), 'aria-valuemax': String(LIMITS[name][1]), 'aria-valuenow': String(widths[name]), dataset: { split: name },
    });
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = event.clientX; const initial = widths[name];
      const rtl = getComputedStyle(root).direction === 'rtl' ? -1 : 1;
      node.setPointerCapture?.(event.pointerId);
      const move = (next) => { setWidth(name, initial + (next.clientX - start) * sign * rtl); window.dispatchEvent(new Event('resize')); };
      const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up); saveWidths(); };
      node.addEventListener('pointermove', move); node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    });
    node.addEventListener('keydown', (event) => {
      const rtl = getComputedStyle(root).direction === 'rtl' ? -1 : 1;
      const delta = { ArrowLeft: -24, ArrowRight: 24 }[event.key];
      if (delta) { event.preventDefault(); setWidth(name, widths[name] + delta * sign * rtl); saveWidths(); window.dispatchEvent(new Event('resize')); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setWidth(name, LIMITS[name][event.key === 'Home' ? 0 : 1]); saveWidths(); }
    });
    return node;
  }

  const switcher = segmented({
    label: t('plan.panes'), value: 'days',
    items: [{ value: 'days', label: t('plan.title'), icon: 'calendar' }, { value: 'map', label: t('plan.map'), icon: 'map' }, { value: 'places', label: t('plan.places'), icon: 'pin' }],
    onChange: (value) => show(value, false),
  });
  function show(name, sync = true) {
    if (root.dataset.pane === name) return;
    root.dataset.pane = name;
    if (sync) switcher.setValue(name);
    // The map measures its container when it becomes visible.
    window.dispatchEvent(new Event('resize'));
  }
  const showOnPhone = (name) => { if (layout() !== 'wide' && !(name === 'days' && layout() === 'medium')) show(name); };

  root.append(el('div.plan-switch', {}, switcher.element),
    el('div.plan-panes', {}, daysPane, splitter('days', 1), mapPane, splitter('places', -1), placesPane));
  setWidth('days', widths.days); setWidth('places', widths.places);
  const place = () => root.style.setProperty('--plan-top', `${Math.max(0, root.getBoundingClientRect().top + window.scrollY)}px`);
  container.replaceChildren(root);
  place();

  const weather = mountWeather(pane);
  const stopSchedule = mountSchedule(pane);
  const stopTransit = mountTransit(pane);
  const stopAlternatives = mountAlternatives(pane);
  const stopRouteImport = mountRouteImport(pane);
  const stopPhotoDays = mountPhotoDays(pane);
  const days = mountDays(daysPane, { space, plan, app, route: context.route, showPane: showOnPhone });
  const cleanups = [weather, stopSchedule, stopTransit, stopAlternatives, stopRouteImport, stopPhotoDays, () => days.destroy(), mountDayPanel(panel, { space, plan }), mountRoadTrip(pane, { daysPane })];
  const mountPane = async (fn, host) => {
    try {
      const cleanup = await fn(host, pane);
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    } catch { host.replaceChildren(el('p.view-error', { role: 'alert' }, t('app.viewError'))); }
  };
  await Promise.all([mountPane(mountMap, mapHost), mountPane(mountPlaces, placesHost)]);
  cleanups.push(placePanelBelow(mapHost, mapPane));

  // Places in the pool are rows with `data-place-id`; the whole row drags with a mouse, a long press on touch.
  const pool = makeDragSource(placesHost, {
    itemSelector: '[data-place-id]', handle: null, longPress: true,
    data: (item) => (space.can('plan.edit') && isId(item.dataset.placeId) ? { t: 'place', id: item.dataset.placeId } : null),
  });
  cleanups.push(() => pool.destroy());
  cleanups.push(
    plan.on('addToDay', (detail) => { void days.addToDay(detail ?? {}); }),
    plan.on('locate', () => showOnPhone('map')),
    plan.on('openPlace', () => showOnPhone('places')),
    plan.on('pickLocation', () => showOnPhone('places')),
  );
  const register = (command) => { try { return app?.commands?.register(command) ?? (() => {}); } catch { return () => {}; } };
  cleanups.push(
    register({ id: 'plan-undo', labelKey: 'plan.undo', shortcut: 'Mod+z', run: () => days.undo() }),
    register({ id: 'plan-redo', labelKey: 'plan.redo', shortcut: 'Mod+Shift+z', run: () => days.redo() }),
    register({ id: 'plan-redo-alt', labelKey: 'plan.redo', shortcut: 'Mod+y', hidden: true, run: () => days.redo() }),
    register({ id: 'plan-next-day', labelKey: 'plan.nextDay', shortcut: 'j', run: () => days.step(1) }),
    register({ id: 'plan-previous-day', labelKey: 'plan.previousDay', shortcut: 'k', run: () => days.step(-1) }),
    register({ id: 'plan-add-day', labelKey: 'plan.addDay', run: () => days.addDay() }),
    // The trip shell registers the trip-wide commands; this one adds the selected day for the assistant.
    registerAssistantCommand(pane),
  );
  const onMedia = () => {
    root.dataset.layout = layout();
    if (root.dataset.layout === 'medium' && root.dataset.pane === 'days') show('map');
    else switcher.setValue(root.dataset.pane);
    place();
  };
  onMedia();
  for (const query of [wide, narrow]) query?.addEventListener?.('change', onMedia);
  window.addEventListener('resize', place);
  cleanups.push(() => { for (const query of [wide, narrow]) query?.removeEventListener?.('change', onMedia); window.removeEventListener('resize', place); });

  return () => { for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* Keep tearing down. */ } } };
}
