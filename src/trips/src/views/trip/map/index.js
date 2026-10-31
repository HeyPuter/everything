import './map.css';
import { el, uid } from '../../../ui/dom.js';
import { button, emptyState, spinner } from '../../../ui/bits.js';
import { toast } from '../../../ui/toast.js';
import { openMenu } from '../../../ui/menu.js';
import { isDark, onThemeChange } from '../../../ui/theme.js';
import { t } from '../../../lib/i18n/index.js';
import { displayLocale, mapPrefs, onPrefs, prefersReducedMotion, prefsBound, setPrefs } from '../../../lib/prefs.js';
import { formatDistance, formatDuration, formatNumber } from '../../../lib/format.js';
import { createTripMap } from '../../../map/index.js';
import { DEFAULT_CONFIG } from '../../../services/core.js';
import { createTiles } from '../../../services/tiles.js';
import { applePlace, comapsPlace, coords, dayLinks, googlePlace, transitLinks } from '../../../lib/route-plan/index.js';
import { tripPlanner } from '../plan/schedule/planner.js';
import { icon } from './icons.js';
import { categoryStyle, EXPLORE_CATEGORIES } from '../../../lib/categories.js';
import { createMarkerIcons } from './marker-icons.js';
import { averageRating, bookingMarkers, collection, dayLabel, dayTone, framePoints, placeFeatures, routeFeatures } from './features.js';
import { createSearch, sourceLabel } from './search.js';
import { createExplore } from './explore.js';
import { locationCard, placeCard, proposalPanel, tooltip } from './cards.js';
import { createTrackLayer } from '../../io/tracks.js';
import { createTrailLayer } from '../../integrations/trail.js';

// `member`: a role change shows or hides the edit actions.
const ENTITY_TYPES = ['day', 'visit', 'place', 'res', 'cat', 'member'];
const LONG_PRESS = 550;
const ROUTE_DELAY = 400;
// Routing a whole trip lands one day at a time; redraws for them are batched.
const ROUTES_BATCH = 250;
const storageKey = (spaceId) => `trips:map:${spaceId}`;

function readLocal(key) {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be disabled. */ }
}
const latLngText = (lat, lng) => t('planMap.coordinates', { lat: formatNumber(lat, { digits: 5 }), lng: formatNumber(lng, { digits: 5 }) });
const fixMapCredit = () => ({ text: t('services.fixMap'), url: 'https://www.openstreetmap.org/fixthemap' });
const uniqueCredits = (list) => list.filter((item, i) => item?.url && list.findIndex((other) => other?.url === item.url && other?.text === item.text) === i);
const actionButton = (label, name, onClick, { variant = '', key } = {}) => el(`button.btn.btn-sm${variant ? `.btn-${variant}` : ''}`, { type: 'button', onclick: onClick, dataset: key ? { key } : undefined }, icon(name, 16), label);
/** Rebuilds `node` with `fill()` and keeps keyboard focus on the element with the same `data-key`. */
function keepFocus(node, fill) {
  const key = node.contains(document.activeElement) ? document.activeElement?.dataset?.key : null;
  fill();
  if (key) node.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

/**
 * Planner map pane. `context` is the trip tab context plus `plan` (views/trip/plan/state.js): follows `plan.day`,
 * pans on `locate`, sets `hover` and `place` from markers and emits `pickLocation` for places to add.
 */
export function mountMap(container, context = {}) {
  const { space, session, plan } = context;
  const controller = new AbortController();
  const { signal } = controller;
  const cleanups = [];
  const root = el('div.planmap');
  container.replaceChildren(root);
  const abortFromContext = () => destroy();
  context.signal?.addEventListener('abort', abortFromContext, { once: true });
  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    controller.abort();
    context.signal?.removeEventListener('abort', abortFromContext);
    for (const cleanup of cleanups.splice(0).reverse()) { try { cleanup(); } catch { /* Keep tearing down. */ } }
    container.replaceChildren();
  }
  if (!space?.select || !plan?.get) {
    root.append(emptyState({ title: t('planMap.unavailable'), body: t('planMap.noTrip'), icon: 'map' }));
    return destroy;
  }

  const services = session?.services ?? null;
  const lang = displayLocale();
  const spaceId = space.ref?.s ?? context.ref?.s ?? 'trip';
  const local = readLocal(storageKey(spaceId));
  const saveLocal = (patch) => { Object.assign(local, patch); writeLocal(storageKey(spaceId), local); };
  const planner = tripPlanner(space, services?.route ?? null);
  const tracks = createTrackLayer({ space, api: session?.api ?? null, onChange: () => schedule() });
  cleanups.push(() => tracks.destroy());
  const trail = createTrailLayer({ space, puter: context.puter, onChange: () => schedule() });
  cleanups.push(() => trail.destroy());
  const canvas = el('div.planmap-canvas');
  const loading = el('div.planmap-loading', {}, spinner());
  const live = el('div.sr-only', { 'aria-live': 'polite' });
  const announce = (message) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = message; }); };
  root.append(canvas, loading, live);

  let tripMap = null; let icons = null; let search = null; let explore = null; let tiles = null;
  let card = null; let tip = null; let tipAt = null; let proposal = null; let userMoved = false; let framed = false;
  let routeTimer = 0; let routeController = null; let routeTarget = null; let routeErrors = 0; let frame = 0; let summaryOpen = typeof local.summaryOpen === 'boolean' ? local.summaryOpen : !globalThis.matchMedia?.('(max-width: 639px)').matches;
  let overlayController = null; let overlayRouted = { signature: null, features: null };
  let collectionOverlay = null; let roadOverlay = null;
  const drawn = new Map();
  const credits = { routes: [], explore: [] };

  const top = el('div.planmap-top');
  const offline = el('p.planmap-offline', { role: 'status', hidden: navigator.onLine !== false }, t('planMap.offline'));
  const tools = el('div.planmap-tools');
  const summary = el('section.planmap-summary', { 'aria-label': t('planMap.routeSummary') });
  const cardSlot = el('div.planmap-card-slot');

  const routesOn = () => Boolean(mapPrefs().alwaysRoutes) || local.routes !== false;
  const bookingsOn = () => local.bookings !== false;
  const basemap = () => (local.basemap === 'satellite' || local.basemap === 'map' ? local.basemap : mapPrefs().basemap);
  const basemapTheme = () => mapPrefs().theme ?? (isDark() ? 'dark' : 'light');
  const canEdit = () => { try { return Boolean(space.can('plan.edit')); } catch { return false; } };
  const currentDay = () => { const id = plan.get().day; return id ? planner.stops(id) : null; };
  const motion = () => (prefersReducedMotion() ? 0 : 400);
  // Fit padding keeps points clear of the search bar on top and the summary below, within small panes.
  function padding() {
    const width = root.clientWidth; const height = root.clientHeight;
    const side = Math.max(16, Math.min(60, Math.floor(width / 8)));
    const topSpace = Math.min(Math.floor(height / 3), (top.offsetHeight || 0) + 24);
    const bottomSpace = Math.min(Math.floor(height / 3), summary.hidden ? 64 : (summary.offsetHeight || 0) + 56);
    // The map controls sit at the inline end (top left in right-to-left layouts).
    const controls = Math.max(side, Math.min(70, Math.floor(width / 6)));
    const rtl = getComputedStyle(root).direction === 'rtl';
    return { top: Math.max(16, topSpace), bottom: bottomSpace, left: rtl ? controls : side, right: rtl ? side : controls };
  }
  const fitTo = (points) => tripMap.fit(points, { padding: padding(), duration: motion() });
  const summaryId = uid('planmap-summary');

  async function start() {
    let theme;
    try {
      const config = services?.context?.loadConfig ? await services.context.loadConfig() : DEFAULT_CONFIG;
      if (signal.aborted) return;
      tiles = createTiles(config);
      theme = basemapTheme();
      tripMap = await createTripMap(canvas, { t, theme, config, language: lang, geolocation: true, signal, onError: reportError });
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
      loading.remove();
      root.append(el('div.planmap-failed', {}, emptyState({ title: t('planMap.loadFailed'), body: t('planMap.loadFailedBody'), icon: 'warning', action: button(t('planMap.retry'), { variant: 'primary', onclick: retry }) })));
      return;
    }
    loading.remove();
    cleanups.push(() => tripMap?.destroy());
    icons = createMarkerIcons(tripMap, root);
    cleanups.push(() => icons.destroy());
    // A collection drawn over the map, chosen from the layers menu.
    void import('../../collections/overlay.js').then(({ createCollectionOverlay }) => {
      if (signal.aborted || !tripMap) return;
      collectionOverlay = createCollectionOverlay({ context, tripMap, tripId: spaceId });
      cleanups.push(() => collectionOverlay.destroy());
    }).catch(() => {});
    // Road trips: drive legs, night pauses, range bands, hazards and search results.
    void import('../road/overlay.js').then(({ createRoadOverlay }) => {
      if (signal.aborted || !tripMap) return;
      roadOverlay = createRoadOverlay({ context, tripMap });
      cleanups.push(() => roadOverlay.destroy());
    }).catch(() => {});
    void icons.prepare().catch(() => {});
    if (basemap() === 'satellite' && tiles.satelliteSource()) tripMap.setBasemap('satellite');
    buildControls();
    bindMap();
    bindData();
    // The first draw waits a frame so the days and places beside the map paint first.
    schedule();
    // The app theme may have changed while the map library loaded.
    if (basemapTheme() !== theme) void syncTheme();
  }
  function retry() {
    root.querySelector('.planmap-failed')?.remove();
    root.append(loading);
    void start();
  }
  // MapLibre tile errors arrive as event objects and are not shown; a failed basemap swap arrives as an Error.
  let styleWarned = false;
  function reportError(error) {
    if (!(error instanceof Error) || styleWarned) return;
    styleWarned = true;
    toast(t('planMap.styleFailed'));
  }

  function buildControls() {
    search = services?.geocode ? createSearch({ services, lang, bias: searchBias, places: () => space.select.place.all(), onChoose: chooseResult, announce }) : null;
    explore = services?.geocode ? createExplore({ services, tripMap, lang, onPick: pickPoi, onCredits: (list) => { credits.explore = list; updateCredits(); }, announce }) : null;
    if (search) cleanups.push(() => search.destroy());
    if (explore) { cleanups.push(() => explore.destroy()); explore.setVisible(mapPrefs().explorePills !== false); }
    top.append(...[search?.element, explore?.element, offline].filter(Boolean));
    const layersButton = el('button.planmap-tool', { type: 'button', 'aria-label': t('planMap.layers'), title: t('planMap.layers'), onclick: () => openLayersMenu(layersButton) }, icon('layers', 20));
    const fitButton = el('button.planmap-tool', { type: 'button', 'aria-label': t('planMap.fit'), title: t('planMap.fit'), onclick: () => frameView(true) }, icon('fit', 20));
    tools.append(layersButton, fitButton);
    root.append(top, tools, summary, cardSlot);
    const status = () => { offline.hidden = navigator.onLine !== false; };
    window.addEventListener('online', status); window.addEventListener('offline', status);
    cleanups.push(() => { window.removeEventListener('online', status); window.removeEventListener('offline', status); });
  }

  function openLayersMenu(anchor) {
    const prefs = mapPrefs();
    const satellite = Boolean(tiles?.satelliteSource());
    openMenu(anchor, [
      { label: t('planMap.satellite'), checked: basemap() === 'satellite', disabled: !satellite, onSelect: (on) => { saveLocal({ basemap: on ? 'satellite' : 'map' }); tripMap.setBasemap(on ? 'satellite' : 'map'); } },
      { separator: true },
      { label: prefs.alwaysRoutes ? t('planMap.routesAlways') : t('planMap.routes'), checked: routesOn(), disabled: Boolean(prefs.alwaysRoutes), onSelect: (on) => { saveLocal({ routes: on }); render(); } },
      { label: t('planMap.bookings'), checked: bookingsOn(), onSelect: (on) => { saveLocal({ bookings: on }); render(); } },
      // Account preferences; signed out (the public viewer) there are none to change.
      ...(prefsBound() ? [
        { label: t('planMap.placeLabels'), checked: Boolean(prefs.placeLabels), onSelect: (on) => setPrefs({ mapPlaceLabels: on }) },
        { label: t('planMap.endpointLabels'), checked: Boolean(prefs.endpointLabels), onSelect: (on) => setPrefs({ mapEndpointLabels: on }) },
        ...(explore ? [{ label: t('planMap.explorePills'), checked: prefs.explorePills !== false, onSelect: (on) => setPrefs({ mapExplorePills: on }) }] : []),
      ] : []),
      ...(collectionOverlay ? [{ separator: true }, ...collectionOverlay.menuItems()] : []),
      ...(roadOverlay?.menuItems().length ? [{ separator: true }, ...roadOverlay.menuItems()] : []),
    ]);
  }

  // Map events: markers set `place` and `hover`; empty-map clicks, right-clicks and long presses look up the address.
  function bindMap() {
    const map = tripMap.map;
    for (const key of ['places', 'stops']) {
      cleanups.push(tripMap.onClick(key, (feature) => { plan.set({ place: String(feature.id) }); }));
      cleanups.push(tripMap.onHover(key, (feature) => setHover(feature ? { t: 'place', id: String(feature.id) } : null)));
    }
    cleanups.push(tripMap.onClick('booking-pins', (feature) => { locate({ t: 'res', id: String(feature.id) }); }));
    cleanups.push(tripMap.onHover('booking-pins', (feature) => showTip(feature ? { point: feature.lngLat, title: feature.properties.title, subtitle: t(feature.properties.kind === 'stay' ? 'planMap.stay' : 'planMap.booking') } : null)));
    const ours = (event) => map.queryRenderedFeatures?.(event.point)?.some((feature) => String(feature.layer?.id ?? '').startsWith('trips-') && feature.layer.id !== 'trips-satellite');
    const onClick = (event) => {
      if (ours(event)) return;
      if (card || plan.get().place) { closeCard(); if (plan.get().place) plan.set({ place: null }); return; }
      void dropPin(event.lngLat);
    };
    let press = 0; let pressStart = null;
    const cancelPress = () => { clearTimeout(press); press = 0; };
    const onContext = (event) => { event.preventDefault?.(); cancelPress(); if (!ours(event)) void dropPin(event.lngLat); };
    const onTouchStart = (event) => {
      cancelPress();
      if (event.originalEvent?.touches?.length !== 1) return;
      pressStart = event.point;
      press = setTimeout(() => { press = 0; if (!ours(event)) void dropPin(event.lngLat); }, LONG_PRESS);
    };
    const onTouchMove = (event) => { if (press && pressStart && Math.hypot(event.point.x - pressStart.x, event.point.y - pressStart.y) > 10) cancelPress(); };
    const onMove = () => { positionTip(); };
    const onUserMove = (event) => { if (event.originalEvent) userMoved = true; };
    const handlers = [['click', onClick], ['contextmenu', onContext], ['touchstart', onTouchStart], ['touchmove', onTouchMove], ['touchend', cancelPress], ['touchcancel', cancelPress], ['move', onMove], ['dragstart', onUserMove], ['zoomstart', onUserMove]];
    for (const [name, handler] of handlers) map.on(name, handler);
    cleanups.push(() => { cancelPress(); for (const [name, handler] of handlers) map.off(name, handler); });
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (proposal) { event.preventDefault(); cancelProposal(); }
      else if (card) { event.preventDefault(); closeCard(); if (plan.get().place) plan.set({ place: null }); }
    };
    root.addEventListener('keydown', onKey);
    cleanups.push(() => root.removeEventListener('keydown', onKey));
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => tripMap?.resize());
      observer.observe(root);
      cleanups.push(() => observer.disconnect());
    }
  }

  function bindData() {
    cleanups.push(space.subscribe((event) => { if (ENTITY_TYPES.some((type) => event.types.has(type))) schedule(); }));
    let routed = 0;
    cleanups.push(planner.subscribe(() => { if (!routed) routed = setTimeout(() => { routed = 0; schedule(); }, ROUTES_BATCH); }));
    cleanups.push(() => clearTimeout(routed));
    cleanups.push(plan.subscribe((state, patch) => {
      if ('day' in patch) {
        cancelProposal(); framed = false; userMoved = false; schedule();
        if (state.place) openPlaceCard(state.place); else closeCard();
      }
      if ('place' in patch) { selectionChanged(); if (state.place) openPlaceCard(state.place); else if (card?.kind === 'place') closeCard(); }
      if ('hover' in patch) hoverChanged(state.hover);
    }));
    cleanups.push(plan.on('locate', (detail) => locate(detail)));
    cleanups.push(onPrefs((_prefs, changed) => {
      const keys = new Set(changed ?? []);
      if (keys.has('mapStyle')) {
        delete local.basemap; saveLocal({});
        const kind = basemap();
        if (kind === 'map' || tiles?.satelliteSource()) tripMap.setBasemap(kind);
        void syncTheme();
      }
      if (keys.has('mapExplorePills')) explore?.setVisible(mapPrefs().explorePills !== false);
      // High contrast remaps tokens without a theme change; markers and glyphs re-read them.
      if (keys.has('contrast') && !keys.has('mapStyle')) void syncTheme();
      if (['mapPlaceLabels', 'mapEndpointLabels', 'mapAlwaysRoutes', 'distanceUnit', 'dateFormat'].some((key) => keys.has(key))) schedule();
    }));
    cleanups.push(onThemeChange(() => { void syncTheme(); }));
  }

  async function syncTheme() {
    if (!tripMap) return;
    await icons?.refresh().catch(() => {});
    if (destroyed) return;
    const swapped = await tripMap.setTheme(basemapTheme());
    if (!swapped && !destroyed) tripMap.refresh();
  }

  function schedule() {
    if (frame || destroyed) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  cleanups.push(() => cancelAnimationFrame(frame));

  // Skips identical layer data, so unrelated changes do not re-send every marker to the map.
  function draw(method, key, data, options = {}) {
    const signature = JSON.stringify([data, options]);
    if (drawn.get(key) === signature) return;
    drawn.set(key, signature);
    tripMap[method](key, data, options);
  }

  function render() {
    if (!tripMap || destroyed) return;
    const prefs = mapPrefs();
    // An unknown day (not synced yet, or deleted) shows the whole trip until it resolves.
    const dayStops = currentDay();
    const model = planner.model();
    const overlays = planner.overlays();
    const selected = plan.get().place;
    const markers = placeFeatures({ model, space, dayStops });
    draw('setMarkers', 'places', markers.places, { cluster: true, radius: dayStops ? 6 : 11, selected });
    draw('setMarkers', 'stops', markers.stops, { cluster: false, radius: 12, selected });
    icons.attach('places');
    draw('setMarkers', 'booking-pins', bookingsOn() ? bookingMarkers(overlays) : collection(), { cluster: false, radius: 11 });
    icons.attach('booking-pins');
    draw('setLabels', 'place-labels', prefs.placeLabels ? markers.labels : collection(), { textProperty: 'title', anchor: 'left', offset: [1.4, 0], textSize: 12 });
    draw('setLabels', 'place-ratings', markers.ratings, { textProperty: 'rating', anchor: 'bottom-left', offset: [0.7, -0.7], textSize: 10, font: ['Noto Sans Bold'], allowOverlap: true });
    tracks.render(tripMap, dayStops);
    trail.render(tripMap, plan.get().day);
    renderOverlays(overlays, prefs);
    renderRoutes(dayStops, model);
    renderSummary(dayStops, model);
    if (proposal && proposal.signature !== JSON.stringify(dayStops?.input ?? null)) cancelProposal();
    if (card?.kind === 'place') refreshPlaceCard();
    if (!framed && !userMoved) frameView(false);
  }

  function renderOverlays(overlays, prefs) {
    const on = bookingsOn();
    draw('setArcs', 'booking-arcs', collection(on ? overlays.arcs : []));
    const signature = JSON.stringify(overlays.lines.map((line) => [line.key, line.mode ?? null, line.points]));
    const lines = !on ? [] : overlayRouted.signature === signature ? overlayRouted.features : overlays.lines.map((line) => ({ type: 'Feature', properties: { id: line.id, type: line.type, status: line.status, estimated: Boolean(line.mode) }, geometry: { type: 'LineString', coordinates: line.points } }));
    draw('setArcs', 'booking-lines', collection(lines.map((feature) => ({ ...feature, properties: { ...feature.properties, tone: 'ink-2' } }))), { width: 3 });
    draw('setLabels', 'booking-ends', collection(on && prefs.endpointLabels ? overlays.endpoints : []), { textProperty: 'label', anchor: 'top', offset: [0, 0.8], textSize: 12, font: ['Noto Sans Bold'] });
    if (on && overlayRouted.signature !== signature && overlays.lines.some((line) => line.mode)) routeOverlays(signature);
  }

  // Booking road lines are routed once per set of lines; later renders reuse the result.
  function routeOverlays(signature) {
    if (overlayController?.signature === signature) return;
    overlayController?.abort();
    const current = overlayController = Object.assign(new AbortController(), { signature });
    planner.overlayLines({ signal: current.signal }).then((features) => {
      if (current !== overlayController || destroyed) return;
      overlayRouted = { signature, features };
      schedule();
    }, () => {}).finally(() => { if (overlayController === current) overlayController = null; });
  }

  function renderRoutes(dayStops, model) {
    const visible = routesOn() && !proposal;
    const results = !visible ? [] : dayStops ? [planner.latest(dayStops.dayId)] : model.days.map((day) => planner.latest(day.id));
    draw('setRoutes', 'day-routes', routeFeatures(results, model));
    credits.routes = visible ? uniqueCredits([fixMapCredit(), ...results.flatMap((result) => result?.attribution ?? [])]) : [];
    updateCredits();
    clearTimeout(routeTimer);
    const target = dayStops ? dayStops.dayId : '*';
    if (!visible) { routeController?.abort(); return; }
    const pending = results.some((result) => result && !result.routed);
    if (pending && services?.route && routeErrors < 3 && !(routeController && routeTarget === target)) routeTimer = setTimeout(() => requestRoutes(dayStops), ROUTE_DELAY);
  }
  cleanups.push(() => { clearTimeout(routeTimer); routeController?.abort(); overlayController?.abort(); });

  // One routing run at a time per target (a day or the whole trip); a run picks up the current input of each day.
  function requestRoutes(dayStops) {
    const target = dayStops ? dayStops.dayId : '*';
    if (routeController && routeTarget === target) return;
    routeController?.abort();
    const current = routeController = new AbortController();
    routeTarget = target;
    const work = dayStops ? planner.day(dayStops.dayId, { signal: current.signal }) : planner.trip({ signal: current.signal });
    work.then(() => { routeErrors = 0; }, (error) => { if (error?.name !== 'AbortError') routeErrors++; })
      .finally(() => { if (routeController === current) { routeController = null; schedule(); } });
  }

  function updateCredits() { tripMap?.setAttribution(uniqueCredits([...credits.routes, ...credits.explore])); }

  function renderSummary(dayStops, model) {
    const results = dayStops ? [planner.latest(dayStops.dayId)] : model.days.map((day) => planner.latest(day.id));
    const total = results.reduce((sum, result) => sum + (result?.distance ?? 0), 0);
    const time = results.reduce((sum, result) => sum + (result?.duration ?? 0), 0);
    const estimated = results.some((result) => result?.estimated && result.legs.length);
    const hasLegs = results.some((result) => result?.legs.length);
    summary.hidden = !model.days.length || Boolean(proposal);
    const bodyId = summaryId;
    const heading = dayStops
      ? (hasLegs ? t('planMap.dayRoute', { day: dayLabel(dayStops.day, dayStops.index), distance: formatDistance(total), duration: formatDuration(time / 60) }) : t('planMap.dayNoRoute', { day: dayLabel(dayStops.day, dayStops.index) }))
      : t('planMap.tripRoute', { distance: formatDistance(total) });
    const head = el('button.planmap-summary-head', { type: 'button', dataset: { key: 'toggle' }, 'aria-expanded': String(summaryOpen), 'aria-controls': bodyId, onclick: () => { summaryOpen = !summaryOpen; saveLocal({ summaryOpen }); render(); } },
      icon('route', 16), el('span', {}, heading), estimated && el('span.chip.chip-warn', { title: t('planMap.approxHint') }, t('planMap.approx')), icon(summaryOpen ? 'down' : 'up', 16));
    const body = el('div.planmap-summary-body', { id: bodyId, hidden: !summaryOpen });
    if (dayStops) {
      const actions = [];
      if (canEdit() && dayStops.items.filter((item) => item.t === 'visit' && item.point).length > 2) actions.push(actionButton(t('planMap.optimize'), 'optimize', startOptimize, { key: 'optimize' }));
      const links = exportLinks(dayStops);
      if (links) {
        const directions = actionButton(t('planMap.directions'), 'directions', () => openMenu(directions, links), { key: 'directions' });
        actions.push(directions);
      }
      if (!routesOn()) body.append(el('p.planmap-small.planmap-muted', {}, t('planMap.routesHidden')));
      if (estimated) body.append(el('p.planmap-small.planmap-muted', {}, t('planMap.approxHint')));
      if (actions.length) body.append(el('div.planmap-summary-actions', {}, ...actions));
      body.append(actionButton(t('planMap.wholeTrip'), 'basemap', () => plan.set({ day: null }), { variant: 'ghost', key: 'trip' }));
    } else {
      body.append(el('ul.planmap-days', {}, ...model.days.map((day, index) => {
        const result = results[index];
        return el('li', {}, el('button.planmap-day', { type: 'button', dataset: { key: `day-${day.id}` }, onclick: () => plan.set({ day: day.id }) },
          el('span.planmap-dot', { style: { '--tone': `var(--day-${dayTone(day, index)})` } }),
          el('span', {}, dayLabel(day, index)),
          el('span', {}, result?.legs.length ? formatDistance(result.distance) : '–')));
      })), el('p.planmap-total', {}, el('span', {}, t('planMap.total')), el('span', {}, formatDistance(total))));
      if (estimated) body.append(el('p.planmap-small.planmap-muted', {}, t('planMap.approxHint')));
    }
    keepFocus(summary, () => summary.replaceChildren(head, body));
  }

  function exportLinks(dayStops) {
    const model = planner.model();
    const name = (item) => item.t === 'visit' ? model.place(item.entity.placeId)?.name ?? item.entity.title : item.entity.title;
    const points = [
      ...(dayStops.start ? [{ point: dayStops.start.point, name: dayStops.start.res.title }] : []),
      ...dayStops.items.filter((item) => item.kind !== 'transport' && item.point).map((item) => ({ point: item.point, name: name(item) })),
      ...(dayStops.end ? [{ point: dayStops.end.point, name: dayStops.end.res.title }] : []),
    ];
    const links = dayLinks(points, dayStops.mode);
    if (!links) return null;
    const go = (url) => () => openExternal(url);
    return [
      links.google && { label: links.google.truncated ? t('planMap.googleTruncated') : t('planMap.googleDirections'), onSelect: go(links.google.url) },
      links.apple && { label: t('planMap.appleDirections'), onSelect: go(links.apple) },
      links.comaps && { label: t('planMap.comapsDirections'), onSelect: go(links.comaps) },
    ].filter(Boolean);
  }
  function openExternal(url) {
    const link = el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', hidden: true });
    root.append(link); link.click(); link.remove();
  }

  function frameView(force) {
    const dayStops = currentDay();
    const points = framePoints({ places: space.select.place.all(), dayStops, overlays: planner.overlays() });
    if (!points.length) { if (force) announce(t('planMap.nothingToShow')); return; }
    framed = true;
    if (points.length === 1) tripMap.map.easeTo({ center: points[0], zoom: Math.max(tripMap.map.getZoom(), 13), duration: motion() });
    else fitTo(points);
    if (force) userMoved = false;
  }

  function selectionChanged() {
    const selected = plan.get().place;
    if (!tripMap) return;
    for (const key of ['places', 'stops']) { try { tripMap.setSelected(key, selected); } catch { /* Drawn on the next render. */ } }
  }

  function setHover(next) {
    const current = plan.get().hover;
    if ((current?.t ?? null) === (next?.t ?? null) && (current?.id ?? null) === (next?.id ?? null)) return;
    plan.set({ hover: next });
  }
  function hoverChanged(hover) {
    const placeId = hover?.t === 'place' ? hover.id : hover?.t === 'visit' ? space.get('visit', hover.id)?.placeId : null;
    const place = placeId ? space.get('place', placeId) : null;
    const point = coords(place);
    if (!place || !point) { showTip(null); return; }
    showTip({ point, title: place.name, subtitle: categoryStyle(place.cat, space).label, ratingValue: averageRating(place) });
  }
  // A located place shows its tooltip briefly, unless the pointer or a list row takes over.
  let flashTimer = 0;
  function flashTip(placeId) {
    hoverChanged({ t: 'place', id: placeId });
    clearTimeout(flashTimer);
    const shown = tip;
    flashTimer = setTimeout(() => { if (tip === shown && !plan.get().hover) showTip(null); }, 2500);
  }
  cleanups.push(() => clearTimeout(flashTimer));
  function showTip(detail) {
    tip?.remove(); tip = null; tipAt = null;
    if (!detail || !tripMap) return;
    tip = tooltip(detail); tipAt = detail.point;
    root.append(tip); positionTip();
  }
  function positionTip() {
    if (!tip || !tipAt) return;
    const { x, y } = tripMap.map.project(tipAt);
    const width = root.clientWidth; const height = root.clientHeight;
    tip.hidden = x < 0 || y < 0 || x > width || y > height;
    tip.style.transform = `translate(${Math.round(Math.min(x + 14, width - tip.offsetWidth - 8))}px, ${Math.round(Math.max(8, y - tip.offsetHeight - 14))}px)`;
  }

  function setCard(kind, element, extra = {}) {
    cardSlot.replaceChildren(element);
    card = { kind, element, ...extra };
    root.classList.add('has-card');
  }
  function closeCard() {
    if (!card) return;
    cardSlot.replaceChildren(); card = null; root.classList.remove('has-card');
    draw('setMarkers', 'pin', collection(), { cluster: false, radius: 9 });
  }

  function placeCardElement(placeId) {
    const place = space.get('place', placeId);
    if (!place || place.deleted) return null;
    const point = coords(place);
    const category = categoryStyle(place.cat, space);
    const dayStops = currentDay();
    const visits = dayStops?.items.filter((item) => item.t === 'visit') ?? [];
    const index = visits.findIndex((item) => item.entity.placeId === placeId);
    const actions = [{ label: t('planMap.openPlace'), icon: 'pencil', onClick: () => plan.emit('openPlace', { id: placeId }) }];
    if (dayStops && index === -1 && canEdit()) actions.push({ label: t('planMap.addToDay', { day: dayLabel(dayStops.day, dayStops.index) }), icon: 'plus', primary: true, onClick: () => plan.emit('addToDay', { placeId, dayId: dayStops.dayId }) });
    let transit = [];
    if (index > 0) {
      const previous = dayStops.items.slice(0, dayStops.items.indexOf(visits[index])).findLast((item) => item.point || item.to);
      const from = previous?.kind === 'transport' ? previous.to : previous?.point;
      const links = from && point ? transitLinks(from, point) : null;
      if (links) transit = [{ label: t('planMap.google'), url: links.google }, { label: t('planMap.apple'), url: links.apple }];
    }
    return placeCard({
      place, category, ratingValue: averageRating(place), stop: index >= 0 ? index + 1 : null, actions,
      links: point ? [{ label: t('planMap.google'), url: googlePlace(point, place.name) }, { label: t('planMap.apple'), url: applePlace(point, place.name) }, { label: t('planMap.comaps'), url: comapsPlace(point, place.name) }] : [],
      transit, onClose: () => { closeCard(); plan.set({ place: null }); },
    });
  }
  function openPlaceCard(placeId) {
    if (!tripMap || proposal) return;
    const element = placeCardElement(placeId);
    if (!element) { closeCard(); return; }
    draw('setMarkers', 'pin', collection(), { cluster: false, radius: 9 });
    setCard('place', element, { placeId });
  }
  function refreshPlaceCard() {
    const element = placeCardElement(card.placeId);
    if (!element) { closeCard(); return; }
    if (element.textContent !== card.element.textContent) { cardSlot.replaceChildren(element); card.element = element; }
  }

  function showLocation({ lat, lng, title, address, source, loading: busy = false, pick }) {
    const point = [lng, lat];
    draw('setMarkers', 'pin', collection([{ type: 'Feature', properties: { id: 'pin', tone: 'accent' }, geometry: { type: 'Point', coordinates: point } }]), { cluster: false, radius: 9 });
    const element = locationCard({
      title, address: address || latLngText(lat, lng), source, loading: busy, canAdd: canEdit() && !busy,
      onAdd: () => { plan.emit('pickLocation', { lat, lng, ...(title ? { name: title } : {}), ...(address ? { address } : {}), ...pick }); closeCard(); },
      links: [{ label: t('planMap.google'), url: googlePlace(point, title) }, { label: t('planMap.apple'), url: applePlace(point, title) }, { label: t('planMap.comaps'), url: comapsPlace(point, title) }],
      onClose: closeCard,
    });
    setCard('location', element);
  }
  async function dropPin(lngLat) {
    if (!lngLat || proposal) return;
    const lat = lngLat.lat; const lng = lngLat.lng;
    if (plan.get().place) plan.set({ place: null });
    const token = Symbol('pin');
    showLocation({ lat, lng, loading: Boolean(services?.geocode) });
    card.token = token;
    if (!services?.geocode) return;
    let result = null; let source = '';
    try {
      const response = await services.geocode.reverse(lat, lng, { lang, signal });
      result = response?.data?.[0] ?? null;
      source = (response?.attribution ?? []).map((item) => item?.text).filter(Boolean).join(' · ');
    } catch (error) { if (error?.name === 'AbortError') return; }
    if (destroyed || card?.token !== token) return;
    showLocation({ lat, lng, title: result?.name ?? '', address: result?.address ?? '', source, pick: pickFields(result) });
    if (card) card.token = token;
    announce(result?.name ? t('planMap.foundAddress', { name: result.name }) : t('planMap.noAddress'));
  }
  function pickFields(result, extra = {}) {
    if (!result) return extra;
    return { ...(result.osm ? { osm: `${result.osm.type}/${result.osm.id}` } : {}), ...(result.wikidata ? { wikidata: result.wikidata } : {}), ...(result.source ? { source: result.source } : {}), ...extra };
  }
  function chooseResult(result) {
    if (result.placeId) { plan.set({ place: result.placeId }); focusPoint([result.lng, result.lat]); return; }
    if (plan.get().place) plan.set({ place: null });
    focusPoint([result.lng, result.lat]);
    showLocation({ lat: result.lat, lng: result.lng, title: result.name, address: result.address, source: sourceLabel(result.source), pick: pickFields(result) });
    announce(t('planMap.selected', { name: result.name || t('planMap.unnamedPlace') }));
  }
  function pickPoi(result, category) {
    if (plan.get().place) plan.set({ place: null });
    const cat = EXPLORE_CATEGORIES[category]?.cat;
    showLocation({ lat: result.lat, lng: result.lng, title: result.name, address: result.address, source: t('planMap.source.photon'), pick: pickFields(result, cat ? { cat } : {}) });
  }
  function searchBias() {
    const dayStops = currentDay();
    const points = dayStops ? framePoints({ places: [], dayStops, overlays: planner.overlays() }) : [];
    if (points.length) return { lat: points.reduce((sum, p) => sum + p[1], 0) / points.length, lng: points.reduce((sum, p) => sum + p[0], 0) / points.length, zoom: 12 };
    if (!tripMap) return undefined;
    const center = tripMap.map.getCenter();
    return { lat: center.lat, lng: center.lng, zoom: Math.max(0, Math.min(18, tripMap.map.getZoom())) };
  }
  function focusPoint(point, zoom = 15) {
    if (!tripMap) return;
    userMoved = true;
    tripMap.map.easeTo({ center: point, zoom: Math.max(tripMap.map.getZoom(), zoom), duration: motion() });
  }

  function locate(detail) {
    if (!tripMap || !detail?.id) return;
    const model = planner.model();
    if (detail.t === 'place' || detail.t === 'visit') {
      const placeId = detail.t === 'place' ? detail.id : space.get('visit', detail.id)?.placeId;
      const point = placeId ? model.placePoint(placeId) : null;
      if (point) { focusPoint(point); flashTip(placeId); }
      return;
    }
    if (detail.t === 'day') {
      const dayStops = planner.stops(detail.id);
      const points = dayStops ? framePoints({ places: [], dayStops, overlays: planner.overlays() }) : [];
      if (points.length) { userMoved = true; fitTo(points); }
      return;
    }
    if (detail.t === 'res') {
      const res = model.res(detail.id);
      if (!res) return;
      const ends = (res.legs ?? []).flatMap((leg) => [coords(leg.from), coords(leg.to)]).filter(Boolean);
      const points = ends.length ? ends : [model.resPoint(res)].filter(Boolean);
      if (points.length === 1) focusPoint(points[0]);
      else if (points.length) { userMoved = true; fitTo(points); }
    }
  }

  function startOptimize() {
    const dayStops = currentDay();
    if (!dayStops || !canEdit()) return;
    const result = planner.propose(dayStops.dayId, { anchorHotel: Boolean(mapPrefs().optimizeFromHotel) });
    if (!result?.changed || !result.patches.length) { toast(t('planMap.alreadyOptimal')); return; }
    closeCard();
    proposal = { ...result, dayId: dayStops.dayId, signature: JSON.stringify(dayStops.input) };
    const line = [];
    if (dayStops.start) line.push(dayStops.start.point);
    for (const item of result.sequence) for (const point of item.kind === 'transport' ? [item.from, item.to] : [item.point]) if (point) line.push(point);
    if (dayStops.end) line.push(dayStops.end.point);
    draw('setRoutes', 'proposal', collection(line.length > 1 ? [{ type: 'Feature', properties: { id: 'proposal', tone: 'accent', estimated: true }, geometry: { type: 'LineString', coordinates: line } }] : []));
    const panel = proposalPanel({
      saved: formatDistance(result.before - result.after), before: formatDistance(result.before), after: formatDistance(result.after),
      onApply: () => applyProposal(panel), onCancel: cancelProposal,
    });
    cardSlot.replaceChildren(panel); root.classList.add('has-card');
    announce(t('planMap.optimizeSaves', { saved: formatDistance(result.before - result.after), before: formatDistance(result.before), after: formatDistance(result.after) }));
    render();
    panel.querySelector('button.btn-primary')?.focus();
  }
  async function applyProposal(panel) {
    if (!proposal) return;
    const current = proposal;
    panel.querySelector('button.btn-primary')?.setAttribute('aria-busy', 'true');
    try {
      await space.apply(current.patches.map((patch) => space.ops.patch('visit', patch.id, { set: { order: patch.order } })), { history: t('planMap.optimizeHistory') });
      cancelProposal();
      toast(t('planMap.optimized'), { action: { label: t('planMap.undo'), onClick: () => { void space.history.undo().catch(() => toast(t('planMap.undoFailed'))); } } });
    } catch {
      panel.querySelector('button.btn-primary')?.setAttribute('aria-busy', 'false');
      toast(t('planMap.optimizeFailed'));
    }
  }
  function cancelProposal() {
    if (!proposal) return;
    proposal = null;
    cardSlot.replaceChildren(); root.classList.remove('has-card');
    if (tripMap) draw('setRoutes', 'proposal', collection());
    schedule();
  }

  cleanups.push(() => { tip?.remove(); });
  void start();
  return destroy;
}

export const mount = mountMap;
