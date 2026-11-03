import './view.css';
import { el } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { createRoutePlanner } from '../../lib/route-plan/index.js';
import { coverUrl, fileUrl } from '../../lib/files/index.js';
import { DEFAULT_CONFIG } from '../../services/core.js';
import { createTiles } from '../../services/tiles.js';
import { availableSections, daysInRange, has, loadOptions, normalizeOptions, saveOptions } from './options.js';
import { buildPrintModel, readTrip, tripTimeline } from './model.js';
import { buildDocument } from './document.js';
import { createFrame, isPrintKey } from './frame.js';
import { optionsForm } from './form.js';
import { createSnapshotter, jobSignature, mapJobs } from './snapshots.js';

const ROUTE_BUDGET = 8_000;
const MAP_BUDGET = 60_000;
const FILE_WAIT = 15_000;
const MAX_DAY_MAPS = 31;
const PHONE = '(max-width: 760px)';
let current = null;

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => { setTimeout(() => resolve(null), ms); })]);
const online = () => globalThis.navigator?.onLine !== false;

/** The planner follows the printed timeline, so map stop numbers match the day pages. */
function plannerOrder(timeline, dayId) {
  const seen = new Set();
  const order = [];
  for (const row of timeline.byDay.get(dayId)?.rows ?? []) {
    const key = `${row.kind}:${row.id}`;
    if (!row.primary || row.kind === 'note' || seen.has(key)) continue;
    seen.add(key);
    order.push({ t: row.kind, id: row.id });
  }
  return order;
}

/**
 * Opens the print view for a trip: options beside a light-theme paper preview, then the browser's print dialog
 * (which also saves PDFs). `context` is a trip tab context (`space`, optional `session`, `account`, `signal`).
 * Resolves to `{focus, close}`, or null when there is no open trip.
 */
export async function openPrint(context = {}) {
  const { space } = context;
  if (!space?.select || typeof space.get !== 'function') { toast(t('print.unavailable')); return null; }
  if (current) { current.focus(); return current; }
  const session = context.session ?? null;
  const services = session?.services ?? null;
  const uid = context.account?.uuid ?? session?.account?.uuid ?? null;
  const phone = globalThis.matchMedia?.(PHONE) ?? null;

  let trip = readTrip(space);
  let available = availableSections(trip.meta);
  let options = normalizeOptions(loadOptions(), { days: trip.days, available });
  let timeline = tripTimeline(trip);
  let frame = null;
  let shooter = null;
  let credits = [];
  let closed = false;
  let printing = false;
  let pending = [];
  let timer = 0;
  let mapTimer = 0;
  let routing = null;
  let filesFailed = false;
  let snapshotsReady = null;
  const images = new Map();
  const files = new Map();
  const loading = new Set();
  const attempted = new Set();
  const controller = new AbortController();
  const planner = createRoutePlanner({ space, route: services?.route ?? null, timeline: (dayId) => plannerOrder(timeline, dayId) });

  const status = el('p.print-status-text', { role: 'status' });
  const skip = button(t('print.skipMaps'), { size: 'sm', variant: 'ghost', hidden: true, onclick: () => { void snapshots().then((value) => value?.skip()); } });
  const stage = el('div.print-stage');
  const form = optionsForm({ options, days: trip.days, available, onChange: (next) => {
    options = normalizeOptions(next, { days: trip.days, available });
    saveOptions(options);
    schedule(120);
  } });
  const layout = el('div.print-layout', { dataset: { show: 'options' } }, form.element, stage);
  const switcher = segmented({
    label: t('print.show'), value: 'options',
    items: [{ value: 'options', label: t('print.options') }, { value: 'preview', label: t('print.preview') }],
    onChange: (value) => { layout.dataset.show = value; syncPanes(); },
  });
  const printButton = button(t('print.print'), { variant: 'primary', onclick: () => { void doPrint(); } });
  const dialog = openModal({
    title: t('print.title'), kind: 'print-view', dismissOnBackdrop: false, onClose: cleanup,
    content: el('div.print-body', {}, el('div.print-switch', {}, switcher.element), layout),
    actions: [el('div.print-status', {}, status, skip), button(t('ui.close'), { onclick: () => dialog.close() }), printButton],
  });
  const handle = { focus: () => dialog.panel.focus(), close: () => dialog.close() };
  current = handle;

  function syncPanes() {
    const small = Boolean(phone?.matches);
    form.element.inert = small && layout.dataset.show === 'preview';
    stage.inert = small && layout.dataset.show === 'options';
  }
  phone?.addEventListener?.('change', syncPanes);
  syncPanes();
  // The browser's own print shortcut would print the app behind the dialog.
  const keydown = (event) => { if (isPrintKey(event)) { event.preventDefault(); event.stopPropagation(); void doPrint(); } };
  document.addEventListener('keydown', keydown, true);
  const unsubscribe = space.subscribe?.((event) => { if (![...(event?.types ?? ['*'])].every((type) => type === 'presence')) schedule(600); }) ?? (() => {});
  const abort = () => dialog.close();
  context.signal?.addEventListener('abort', abort, { once: true });

  function cleanup() {
    closed = true;
    if (current === handle) current = null;
    clearTimeout(timer); clearTimeout(mapTimer);
    controller.abort(); routing?.abort();
    unsubscribe();
    document.removeEventListener('keydown', keydown, true);
    phone?.removeEventListener?.('change', syncPanes);
    context.signal?.removeEventListener('abort', abort);
    void snapshotsReady?.then((value) => value?.destroy());
    frame?.destroy();
  }
  function schedule(ms = 150) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(render, ms);
  }

  function snapshots() {
    snapshotsReady ??= (async () => {
      let config = DEFAULT_CONFIG;
      try { if (services?.context?.loadConfig) config = await services.context.loadConfig(); } catch { /* Defaults keep the public styles. */ }
      credits = createTiles(config).attribution().map((credit) => credit.text);
      if (closed) return null;
      shooter = createSnapshotter({ parent: dialog.panel, t, config, language: displayLocale(), onState: () => schedule(60) });
      return shooter;
    })();
    return snapshotsReady;
  }
  function requestMap(job, signature, compress) {
    if (loading.has(signature)) return;
    loading.add(signature);
    mapTimer ||= setTimeout(() => { void snapshots().then((value) => value?.skip()); }, MAP_BUDGET);
    void snapshots().then((value) => value?.get(job, { compress }) ?? null).catch(() => null).then((image) => {
      loading.delete(signature);
      images.set(signature, image ?? null);
      schedule(60);
    });
  }
  function requestFile(key, load) {
    if (loading.has(key)) return;
    loading.add(key);
    void withTimeout(Promise.resolve().then(load), FILE_WAIT).catch(() => null).then((url) => {
      loading.delete(key);
      if (!url) filesFailed = true;
      files.set(key, url ?? null);
      schedule(60);
    });
  }
  async function photoUrl(id, thumb) {
    if (thumb) {
      const small = await fileUrl(space, id, { thumb: true, signal: controller.signal }).catch(() => null);
      if (small) return small;
    }
    return fileUrl(space, id, { signal: controller.signal });
  }
  async function routeDays(ids) {
    routing = new AbortController();
    const { signal } = routing;
    const stop = setTimeout(() => routing?.abort(), ROUTE_BUDGET);
    for (const id of ids) attempted.add(JSON.stringify(planner.stops(id)?.input ?? null));
    for (const id of ids) {
      if (signal.aborted) break;
      try { await planner.day(id, { signal }); } catch { /* The straight-line estimate stays. */ }
    }
    clearTimeout(stop);
    routing = null;
    schedule(60);
  }

  function collectMaps(model, dayIds, routes, assets) {
    if (!has(options, 'map')) return;
    if (!online()) { assets.mapState = 'offline'; return; }
    if (shooter?.state === 'failed') { assets.mapState = 'unavailable'; return; }
    const resIds = new Set([...model.bookings.transport, ...model.bookings.stays, ...model.bookings.other].map((res) => res.id));
    const perDay = options.detail === 'detailed' && has(options, 'days') && dayIds.length <= MAX_DAY_MAPS;
    let waiting = false;
    let missing = false;
    for (const job of mapJobs({ planner, dayIds, routes, resIds, overview: true, perDay })) {
      const signature = jobSignature(job, options.compress);
      if (!images.has(signature)) { waiting = true; requestMap(job, signature, options.compress); continue; }
      const image = images.get(signature);
      if (image) assets.maps.set(job.key, image); else missing = true;
    }
    if (!waiting) { clearTimeout(mapTimer); mapTimer = 0; }
    assets.mapState = waiting ? 'pending' : !missing ? 'ready' : shooter?.state === 'skipped' ? 'skipped' : 'unavailable';
  }
  function collectFiles(model, assets) {
    const thumb = options.compress;
    const cover = model.meta.cover;
    let waiting = false;
    if (has(options, 'overview') && cover) {
      const key = `cover:${JSON.stringify(cover)}:${thumb}`;
      if (files.has(key)) assets.cover = files.get(key);
      else { waiting = true; requestFile(key, () => coverUrl(space, cover, { thumb, signal: controller.signal })); }
    }
    if (options.detail === 'detailed' && options.photos && has(options, 'days')) {
      for (const { img } of model.days.flatMap((day) => day.photos)) {
        if (!img.fileId) continue;
        const key = `file:${img.fileId}:${thumb}`;
        if (!files.has(key)) { waiting = true; requestFile(key, () => photoUrl(img.fileId, thumb)); } else if (files.get(key)) assets.photos.set(img.fileId, files.get(key));
      }
    }
    return waiting;
  }

  function render() {
    if (closed || !frame) return;
    trip = readTrip(space);
    available = availableSections(trip.meta);
    options = normalizeOptions(options, { days: trip.days, available });
    form.update({ options, days: trip.days, available });
    timeline = tripTimeline(trip);
    const dayIds = daysInRange(trip.days, options).map((day) => day.id);
    const routes = new Map();
    for (const id of dayIds) { const route = planner.latest(id); if (route) routes.set(id, route); }
    const model = buildPrintModel(trip, options, { uid, routes, timeline, available });
    const assets = { credits, maps: new Map(), mapState: 'off', photos: new Map(), cover: null };
    pending = [];
    if (services?.route && !routing) {
      const todo = dayIds.filter((id) => !attempted.has(JSON.stringify(planner.stops(id)?.input ?? null)));
      if (todo.length) void routeDays(todo);
    }
    if (routing) pending.push('routes');
    collectMaps(model, dayIds, routes, assets);
    if (assets.mapState === 'pending') pending.push('maps');
    if (collectFiles(model, assets)) pending.push('files');
    const title = trip.meta?.title || t('print.untitledTrip');
    frame.render(buildDocument(model, options, assets, { space }), { options, title });
    skip.hidden = assets.mapState !== 'pending';
    updateStatus(assets);
  }

  function updateStatus(assets) {
    let text;
    if (!trip.meta) text = t('print.loadingTrip');
    else if (!options.sections.length) text = t('print.noSections');
    else if (pending.includes('routes')) text = t('print.planningRoutes');
    else if (pending.includes('maps')) text = t('print.preparingMaps');
    else if (pending.includes('files')) text = t('print.loadingPhotos');
    else {
      text = [t('print.ready'),
        assets.mapState === 'offline' && t('print.mapsOffline'),
        assets.mapState === 'unavailable' && t('print.mapsUnavailable'),
        assets.mapState === 'skipped' && t('print.mapsSkipped'),
        filesFailed && t('print.photosFailed')].filter(Boolean).join(' ');
    }
    if (status.textContent !== text) status.textContent = text;
    printButton.disabled = !trip.meta || !options.sections.length;
    printButton.setAttribute('aria-busy', String(printing || pending.length > 0));
  }

  async function doPrint() {
    if (!frame || closed || printing || printButton.disabled || pending.length) return;
    printing = true;
    printButton.setAttribute('aria-busy', 'true');
    try {
      await frame.settled(FILE_WAIT);
      if (!closed) frame.print();
    } catch { if (!closed) toast(t('print.printFailed')); } finally {
      printing = false;
      if (!closed) printButton.setAttribute('aria-busy', String(pending.length > 0));
    }
  }

  try {
    frame = await createFrame(stage, { onEscape: () => dialog.close(), onPrintKey: () => { void doPrint(); } });
  } catch {
    if (!closed) {
      stage.replaceChildren(el('p.print-error', { role: 'alert' }, t('print.previewFailed')));
      printButton.disabled = true;
    }
    return handle;
  }
  if (closed) frame.destroy(); else render();
  return handle;
}
