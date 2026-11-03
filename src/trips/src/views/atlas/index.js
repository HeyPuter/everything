import './atlas.css';
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, spinner } from '../../ui/bits.js';
import { field, segmented, switchField } from '../../ui/fields.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { onPrefs } from '../../lib/prefs.js';
import { formatNumber } from '../../lib/format.js';
import { openDatabase } from '../../lib/idb.js';
import { warmSpace } from '../../lib/offline/warm.js';
import { aggregateAtlas, localToday } from '../../lib/atlas/aggregate.js';
import { MARKS_KEY, airportRows, loadCountries, loadTripHeads, loadTrips, normalizeMarks, tripInput, writeMarks } from '../../lib/atlas/data.js';
import { loadRegionIndex, loadRegions, locatePlace } from '../../lib/atlas/boundaries.js';
import { aggregateRegions, regionCountry, regionTotals } from '../../lib/atlas/regions.js';
import { flightLegs, flightStats } from '../../lib/atlas/flights.js';
import { createBucketStore, sortBucket } from '../../lib/atlas/bucket.js';
import { countryCode } from '../../lib/atlas/countries.js';
import { createAtlasMap } from './map.js';
import { boardView, detailView, resultsView, searchCountries, statsView } from './panel.js';
import { regionsSection } from './regions-view.js';
import { bucketError, bucketName, bucketRow, bucketView, openBucketDialog } from './bucket.js';
import { flightsView } from './flights.js';
import { nameOf, plural } from './text.js';
import { atlasEntry } from '../integrations/entry.js';

const UI_KEY = 'trips:atlas';
const VIEWS = ['countries', 'bucket', 'flights'];
const WARM_CONCURRENCY = 2;
const REGION_CONCURRENCY = 2;
const refKey = (ref) => `${ref.w}:${ref.s}`;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function readUi() {
  try {
    const value = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}');
    return { planned: value?.planned !== false, view: VIEWS.includes(value?.view) ? value.view : 'countries' };
  } catch { return { planned: true, view: 'countries' }; }
}
function writeUi(value) { try { localStorage.setItem(UI_KEY, JSON.stringify(value)); } catch { /* Private mode keeps the default. */ } }

function errorKey(error) {
  if (globalThis.navigator?.onLine === false || error?.status === 0) return 'atlas.error.offline';
  if (error?.status === 402) return 'atlas.error.credit';
  if (error?.status === 401 || error?.status === 403) return 'atlas.error.forbidden';
  return 'atlas.error.failed';
}

/**
 * Atlas page (`#/atlas`): countries and admin-1 regions from trips plus manual marks, the bucket list and distance
 * flown. Reads local replicas only; `heads` refreshes trip dates and trips missing on this device load on request.
 */
export async function mount(container, context) {
  const { signal } = context;
  const session = context.session ?? null;
  const personal = session?.personal ?? context.personal;
  const puter = context.puter;
  const self = context.account?.uuid ?? session?.account?.uuid ?? null;
  const ui = readUi();
  const cleanups = [];
  const bucketStore = personal && puter?.kv ? createBucketStore({ personal, puter }) : null;
  const state = {
    phase: 'loading', items: [], heads: new Map(), airports: new Map(), marks: normalizeMarks(null), countries: null, trips: new Map(), atlas: null,
    selected: null, selectedRegion: null, query: '', busy: false, warming: null, view: ui.view,
    bucket: [], bucketCountries: new Map(), flights: null,
    regionIndex: null, regionData: new Map(), regionStatus: new Map(), regionResults: new Map(), regionTotals: null, regionFilter: '',
  };
  let db = session?.db ?? null;
  let ownDb = null;
  let atlasMap = null;
  let destroyed = false;

  const bodyId = uid('atlas-body');
  const stats = el('dl.atlas-stats', { 'aria-label': t('atlas.statsLabel') });
  const offline = el('p.atlas-offline', { role: 'status', hidden: navigator.onLine !== false }, t('atlas.offline'));
  const canvas = el('div.atlas-canvas');
  const mapBox = el('div.atlas-map', {}, el('div.atlas-map-state', {}, spinner()));
  const plannedToggle = switchField(t('atlas.showPlanned'), { checked: ui.planned, onChange: (value) => { ui.planned = value; writeUi(ui); renderAll(); } });
  const legend = el('ul.atlas-legend', { 'aria-label': t('atlas.legend') },
    el('li', {}, el('span.atlas-swatch.atlas-swatch-visited'), t('atlas.legendVisited')),
    el('li', {}, el('span.atlas-swatch.atlas-swatch-planned'), t('atlas.legendPlanned')),
    el('li', {}, el('span.atlas-swatch.atlas-swatch-wish'), t('atlas.legendWishlist')));
  const search = field({ label: t('atlas.search'), type: 'search', prefix: 'search', autocomplete: 'off', spellcheck: false, 'aria-controls': bodyId });
  const viewSwitch = segmented({ label: t('atlas.view.label'), value: state.view,
    items: VIEWS.map((value) => ({ value, label: t(`atlas.view.${value}`) })),
    onChange: (value) => { state.view = value; ui.view = value; writeUi(ui); renderSide(); } });
  const announcer = el('p.sr-only', { role: 'status' });
  const dawarich = atlasEntry(context, { visited: () => state.atlas?.visited ?? [] });
  cleanups.push(dawarich.destroy);
  const body = el('div.atlas-side-body', { id: bodyId, role: 'region' });
  const root = el('div.atlas', {}, offline, stats,
    el('div.atlas-layout', {},
      el('div.atlas-mapcol', {}, el('div.atlas-toolbar', {}, legend, plannedToggle, dawarich.element), mapBox),
      el('aside.atlas-side', { 'aria-label': t('atlas.title') }, viewSwitch.element, search.element, announcer, body)));
  container.replaceChildren(root);

  const focusTarget = (region, key) => [...region.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === key) ?? null;
  // Re-renders keep focus on the control that had it (rows, actions), matched by `data-focus`.
  function keepFocus(region, render) {
    const key = region.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    render();
    if (key) focusTarget(region, key)?.focus({ preventScroll: true });
  }
  const online = () => navigator.onLine !== false;

  function recomputeRegions() {
    if (!state.atlas) return;
    const moved = state.regionIndex?.moved ?? {};
    state.regionTotals = regionTotals({ atlas: state.atlas, loaded: state.regionData, marks: state.marks, moved });
    state.regionResults = new Map();
    for (const [cc, data] of state.regionData) {
      if (!data) continue;
      state.regionResults.set(cc, state.regionTotals.byCountry.get(cc) ?? aggregateRegions({ country: state.atlas.countries.get(cc), regions: data.regions, marks: state.marks, locate: data.locate }));
    }
  }
  function recompute() {
    const trips = state.items.map(({ entry, replica }) => tripInput(entry, replica, state.heads.get(refKey(entry.ref))));
    const today = localToday();
    const locate = state.countries?.locate;
    state.trips = new Map(trips.map((trip) => [trip.key, trip]));
    state.atlas = aggregateAtlas({ trips, marks: state.marks, bucket: state.bucket, uid: self, today, locate, airportCountry: (code) => state.airports.get(code)?.country ?? null });
    state.flights = flightStats(flightLegs(trips, { today, uid: self, airport: (code) => state.airports.get(code) ?? null }));
    state.bucketCountries = new Map(state.bucket.map((entry) => [entry.id, countryCode(entry.cc) ?? (finite(entry.lat) && locate ? locate(entry.lat, entry.lng) : null)]));
    recomputeRegions();
  }

  function renderStats() { stats.replaceChildren(...statsView(state.atlas, { showPlanned: ui.planned, regions: state.regionTotals, flights: state.flights })); }
  function renderMap() {
    if (!atlasMap || !state.atlas) return;
    const regions = [];
    for (const [cc, data] of state.regionData) {
      const result = data && state.regionResults.get(cc);
      if (!result) continue;
      const statuses = new Map(result.regions.map((region) => [region.code, region.status === 'planned' && !ui.planned ? null : region.status]));
      regions.push({ cc, features: data.features, statuses });
    }
    atlasMap.render({
      visited: state.atlas.visited, planned: ui.planned ? state.atlas.planned : [], selected: state.selected, selectedRegion: state.selectedRegion,
      wishlist: state.atlas.wishlist, regions,
      bucket: state.bucket.filter((entry) => finite(entry.lat) && finite(entry.lng)).map((entry) => ({ id: entry.id, lat: entry.lat, lng: entry.lng, visited: Boolean(entry.visitedAt) })),
    });
  }

  function countryBucket(code) {
    const entries = sortBucket(state.bucket.filter((entry) => state.bucketCountries.get(entry.id) === code));
    const nodes = [el('h3.atlas-subhead', {}, el('span', {}, t('atlas.bucket.heading')), entries.length ? el('span.atlas-count', {}, formatNumber(entries.length)) : null)];
    if (entries.length) nodes.push(el('ul.atlas-list.atlas-detail-list', {}, entries.map((entry) => bucketRow(entry, { country: null, busy: state.busy, onOpen: openBucket, onToggle: toggleBucket }))));
    if (bucketStore) nodes.push(button(t('atlas.bucket.addLabel'), { icon: 'plus', size: 'sm', variant: 'outline', dataset: { focus: 'bucket-add-country' }, onclick: () => { void addBucket({ cc: code }); } }));
    return nodes;
  }

  // The countries list has no visible heading of its own; its sections are h3s under this one.
  const viewHeading = () => el('h2.sr-only', {}, t('atlas.view.countries'));
  function renderSide() {
    search.element.hidden = state.view !== 'countries';
    body.setAttribute('aria-label', t(`atlas.view.${state.view}`));
    // The panel scrolls on wide screens; the flights view has no controls, so the panel itself takes focus there.
    if (state.view === 'flights') body.tabIndex = 0; else body.removeAttribute('tabindex');
    keepFocus(body, () => {
      if (state.phase === 'loading') { body.replaceChildren(el('div.atlas-side-state', {}, spinner(), el('p', {}, t('atlas.loading')))); return; }
      if (state.phase === 'error') {
        body.replaceChildren(viewHeading(), emptyState({ title: t('atlas.loadError'), icon: 'warning', action: button(t('atlas.retry'), { variant: 'primary', onclick: () => { state.phase = 'loading'; renderAll(); void load(); } }) }));
        return;
      }
      if (state.view === 'bucket') {
        body.replaceChildren(...bucketView({ entries: sortBucket(state.bucket), countries: state.bucketCountries, busy: state.busy, onAdd: () => { void addBucket(); }, onOpen: openBucket, onToggle: toggleBucket }));
        return;
      }
      if (state.view === 'flights') { body.replaceChildren(...flightsView({ stats: state.flights, uncached: state.atlas?.uncached ?? 0 })); return; }
      if (state.selected) {
        const code = state.selected;
        const regions = regionsSection({ entry: { status: state.regionStatus.get(code) ?? 'loading', result: state.regionResults.get(code) }, filter: state.regionFilter, busy: state.busy,
          selected: state.selectedRegion, showPlanned: ui.planned, onToggle: toggleRegion, onRetry: () => { void ensureRegions([code], { priority: true }); }, onFilter: (text) => { state.regionFilter = text; } });
        body.replaceChildren(...detailView({ code, atlas: state.atlas, trips: state.trips, drawn: !state.countries || state.countries.codes.has(code),
          busy: state.busy, regions, bucket: countryBucket(code), onBack: back, onMark: mark, onHide: hide }));
        return;
      }
      if (state.query.trim()) {
        const results = searchCountries(state.query);
        body.replaceChildren(viewHeading(), ...resultsView({ atlas: state.atlas, query: state.query, results, onSelect: (code) => select(code) }));
        announcer.textContent = results.length ? plural('atlas.results', results.length) : t('atlas.noResults', { query: state.query.trim() });
        return;
      }
      body.replaceChildren(viewHeading(), ...boardView({ atlas: state.atlas, showPlanned: ui.planned, warming: state.warming, canWarm: Boolean(session?.api && db) && online(),
        onSelect: (code) => select(code), onShow: (code) => hide(code, false), onWarm: () => { void warmMissing(); } }));
    });
  }
  function renderAll() {
    if (destroyed) return;
    renderStats(); renderSide(); renderMap();
  }

  function showCountries() {
    if (state.view === 'countries') return;
    state.view = 'countries'; ui.view = 'countries'; writeUi(ui); viewSwitch.setValue('countries');
  }
  function select(code, { fromMap = false, region = null } = {}) {
    if (state.selected !== code) state.regionFilter = '';
    state.selected = code;
    state.selectedRegion = region;
    showCountries();
    void ensureRegions([code], { priority: true });
    renderSide(); renderMap();
    if (!fromMap) atlasMap?.frame(code);
    // Side by side the panel is already in view; stacked on phones, focus scrolls down to it.
    body.querySelector('.atlas-detail-title')?.focus({ preventScroll: Boolean(window.matchMedia?.('(min-width: 1024px)').matches) });
    if (region) [...body.querySelectorAll('.atlas-region')].find((node) => node.dataset.code === region)?.scrollIntoView?.({ block: 'nearest' });
  }
  function back() {
    const previous = state.selected;
    state.selected = null; state.selectedRegion = null;
    renderSide(); renderMap();
    (focusTarget(body, `row:${previous}`) ?? search.input).focus();
  }

  async function save(changes, doneKey, values) {
    if (state.busy) return;
    if (!online()) { toast(t('atlas.error.offline')); return; }
    state.busy = true; renderSide();
    try {
      state.marks = await writeMarks({ puter, personal, changes });
      if (destroyed) return;
      recompute();
      toast(t(doneKey, values));
    } catch (error) {
      if (!destroyed) toast(t(errorKey(error)));
    } finally {
      state.busy = false;
      renderAll();
    }
  }
  function mark(code, on) {
    // Marking a hidden country also shows it again.
    const changes = on ? { [`visited.${code}`]: 'manual', ...(state.marks.hidden[code] ? { [`hidden.${code}`]: null } : {}) } : { [`visited.${code}`]: null };
    return save(changes, on ? 'atlas.saved.marked' : 'atlas.saved.unmarked', { country: nameOf(code) });
  }
  function hide(code, on) { return save({ [`hidden.${code}`]: on ? true : null }, on ? 'atlas.saved.hidden' : 'atlas.saved.shown', { country: nameOf(code) }); }
  function toggleRegion(region, on) {
    const code = state.selected;
    const changes = { [`regions.${region.code}`]: on ? 'manual' : null };
    // A visited region means a visited country.
    if (on && code && state.atlas?.countries.get(code)?.status !== 'visited') {
      changes[`visited.${code}`] = 'manual';
      if (state.marks.hidden[code]) changes[`hidden.${code}`] = null;
    }
    return save(changes, on ? 'atlas.saved.regionMarked' : 'atlas.saved.regionUnmarked', { region: region.name });
  }

  // Region files: one per country, two at a time; the selected country jumps the queue.
  const regionQueue = [];
  let regionWorkers = 0;
  async function ensureRegions(codes, { priority = false } = {}) {
    if (!state.regionIndex) {
      try { state.regionIndex = await loadRegionIndex(); } catch {
        for (const cc of codes) if (!state.regionData.has(cc)) state.regionStatus.set(cc, 'error');
        if (!destroyed) renderSide();
        return;
      }
      if (destroyed) return;
    }
    let changed = false;
    for (const cc of codes) {
      const status = state.regionStatus.get(cc);
      if (status === 'queued' && priority && regionQueue.includes(cc)) { regionQueue.splice(regionQueue.indexOf(cc), 1); regionQueue.unshift(cc); continue; }
      if (status === 'ready' || status === 'none' || status === 'queued' || status === 'loading') continue;
      if (!state.regionIndex.countries[cc]) { state.regionStatus.set(cc, 'none'); state.regionData.set(cc, null); changed = true; continue; }
      state.regionStatus.set(cc, 'queued');
      if (priority) regionQueue.unshift(cc); else regionQueue.push(cc);
    }
    if (changed) { recomputeRegions(); renderAll(); }
    while (regionWorkers < REGION_CONCURRENCY && regionQueue.length) void regionWorker();
  }
  async function regionWorker() {
    regionWorkers += 1;
    try {
      while (regionQueue.length && !destroyed) {
        const cc = regionQueue.shift();
        state.regionStatus.set(cc, 'loading');
        if (cc === state.selected) renderSide();
        try {
          const data = await loadRegions(cc);
          if (destroyed) return;
          state.regionData.set(cc, data);
          state.regionStatus.set(cc, data ? 'ready' : 'none');
        } catch {
          if (destroyed) return;
          state.regionStatus.set(cc, 'error');
        }
        recomputeRegions();
        renderAll();
      }
    } finally { regionWorkers -= 1; }
  }
  const atlasRegionCountries = () => [...new Set([...(state.atlas?.visited ?? []), ...(ui.planned ? state.atlas?.planned ?? [] : []),
    ...Object.keys(state.marks.regions).map((code) => regionCountry(code, state.regionIndex?.moved))])].filter(Boolean);

  // Bucket list.
  function refocus(keys) {
    for (const key of keys) { const node = focusTarget(body, key); if (node) { node.focus(); return; } }
  }
  async function addBucket(defaults = {}) {
    if (!bucketStore) return;
    await openBucketDialog({ item: defaults, store: bucketStore, geocode: session?.services?.geocode ?? null, locatePlace: (lat, lng) => locatePlace(lat, lng) });
    if (!destroyed) refocus([defaults.cc ? 'bucket-add-country' : 'bucket-add']);
  }
  async function openBucket(id) {
    if (!bucketStore) return;
    let item;
    try { item = await bucketStore.get(id, { fresh: online() }); } catch { toast(t('atlas.bucket.loadFailed')); return; }
    if (destroyed) return;
    if (!item) { toast(t('atlas.bucket.gone')); if (online()) void bucketStore.forget(id).catch(() => {}); return; }
    await openBucketDialog({ item, store: bucketStore, geocode: session?.services?.geocode ?? null, locatePlace: (lat, lng) => locatePlace(lat, lng) });
    if (!destroyed) refocus([`bucket:${id}`, 'bucket-add', 'bucket-add-country']);
  }
  async function toggleBucket(id, on) {
    if (!bucketStore || state.busy) return;
    if (!online()) { toast(t('atlas.error.offline')); return; }
    const entry = state.bucket.find((item) => item.id === id);
    const name = entry ? bucketName(entry) : '';
    state.busy = true; renderSide();
    try {
      await bucketStore.setVisited(id, on ? localToday() : null);
      if (!destroyed) toast(t(on ? 'atlas.bucket.markedVisited' : 'atlas.bucket.unmarkedVisited', { name }));
    } catch (error) {
      if (!destroyed) toast(bucketError(error));
    } finally {
      state.busy = false;
      if (!destroyed) renderSide();
    }
  }

  async function refreshHeads() {
    if (!session?.api || !online() || !state.items.length) return;
    try { state.heads = await loadTripHeads(state.items, { api: session.api, signal }); } catch { return; }
    if (destroyed) return;
    recompute(); renderAll();
  }
  async function resolveAirports() {
    const found = await airportRows([...state.trips.values()], session?.services?.airports, { signal }).catch(() => new Map());
    if (destroyed || !found.size) return;
    state.airports = found; recompute(); renderAll();
  }
  async function reloadTrips() {
    try { state.items = await loadTrips({ personal, db }); } catch { return; }
    if (destroyed) return;
    recompute(); renderAll();
  }

  // Trips never opened on this device: one background pull each, two at a time, only when asked.
  async function warmMissing() {
    const missing = state.items.filter((item) => !item.replica);
    if (!missing.length || state.warming || !session?.api || !db) return;
    state.warming = { done: 0, total: missing.length, failed: 0 };
    renderSide();
    let own = null;
    try { own = (await session.deployer?.current?.())?.name ?? null; } catch { own = null; }
    let next = 0;
    const run = async () => {
      while (next < missing.length && !destroyed) {
        const { entry } = missing[next++];
        try { await warmSpace({ ref: entry.ref, db, api: session.api, puter, handles: entry.handles ?? null, ownWorker: own, signal }); }
        catch { state.warming.failed += 1; }
        state.warming.done += 1;
        renderSide();
      }
    };
    await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, missing.length) }, run));
    if (destroyed) return;
    const { failed } = state.warming;
    state.warming = null;
    await reloadTrips();
    void ensureRegions(atlasRegionCountries());
    toast(failed ? plural('atlas.loadFailed', failed) : t('atlas.loadDone'));
  }

  let styleWarned = false;
  function mapError(error) {
    if (!(error instanceof Error) || styleWarned) return;
    styleWarned = true;
    toast(t('atlas.styleFailed'));
  }
  async function startMap() {
    mapBox.replaceChildren(el('div.atlas-map-state', {}, spinner()));
    try {
      state.countries ??= await loadCountries();
      if (destroyed) return;
      if (state.phase === 'ready') { recompute(); renderAll(); }
      mapBox.replaceChildren(canvas);
      atlasMap = await createAtlasMap(canvas, { countries: state.countries.features, services: session?.services, signal, onError: mapError,
        onSelect: (code) => select(code, { fromMap: true }),
        onRegion: ({ code, cc }) => { if (cc) select(cc, { fromMap: true, region: code }); },
        onBucket: (id) => { void openBucket(id); },
        onView: ({ countries }) => { if (countries.length) void ensureRegions(countries); } });
    } catch (error) {
      if (destroyed || error?.name === 'AbortError') return;
      mapBox.replaceChildren(el('div.atlas-map-state', {}, el('h2.sr-only', {}, t('atlas.mapHeading')), emptyState({ title: t('atlas.mapFailed'), body: t('atlas.mapFailedBody'), icon: 'warning',
        action: button(t('atlas.retry'), { variant: 'primary', onclick: () => { void startMap(); } }) })));
      return;
    }
    if (destroyed) { atlasMap.destroy(); return; }
    cleanups.push(() => atlasMap?.destroy());
    renderMap();
    if (state.selected) atlasMap.frame(state.selected);
  }

  async function load() {
    try {
      if (!db && self) { ownDb = await openDatabase(self); db = ownDb; }
      const [items, marks, countries, bucket] = await Promise.all([
        loadTrips({ personal, db }),
        personal.get(MARKS_KEY).catch(() => null),
        loadCountries().catch(() => null),
        bucketStore ? bucketStore.list().catch(() => []) : [],
      ]);
      if (destroyed) return;
      Object.assign(state, { items, marks: normalizeMarks(marks), countries, bucket, phase: 'ready' });
      recompute();
    } catch {
      if (destroyed) return;
      state.phase = 'error';
      renderAll();
      return;
    }
    renderAll();
    void refreshHeads();
    void resolveAirports();
    // Region totals need the visited countries' boundaries; they load in the background.
    void ensureRegions(atlasRegionCountries());
  }

  search.input.addEventListener('input', () => { state.query = search.input.value; state.selected = null; state.selectedRegion = null; renderSide(); renderMap(); });
  body.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.selected && state.view === 'countries') { event.preventDefault(); back(); } });
  const connectivity = () => { offline.hidden = online(); renderSide(); if (online()) void refreshHeads(); };
  window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity);
  cleanups.push(() => { window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); });
  cleanups.push(personal.subscribe(MARKS_KEY, (value) => { state.marks = normalizeMarks(value); if (state.phase === 'ready') { recompute(); renderAll(); } }));
  cleanups.push(personal.subscribe('me:spaces', () => { if (state.phase === 'ready') void reloadTrips(); }));
  if (bucketStore) cleanups.push(bucketStore.subscribe((entries) => { state.bucket = entries; if (state.phase === 'ready') { recompute(); renderAll(); } }));
  cleanups.push(onPrefs((_prefs, changed) => { const keys = new Set(changed ?? []); if ((keys.has('dateFormat') || keys.has('distanceUnit')) && state.phase === 'ready') renderAll(); }));

  renderAll();
  void load();
  void startMap();

  return () => {
    destroyed = true;
    for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* Keep tearing down. */ } }
    ownDb?.close();
  };
}
