import { el } from '../../ui/dom.js';
import { createTripMap } from '../../map/index.js';
import { estimateLines } from '../../lib/route-plan/index.js';
import { collection, dayTone, routeFeatures } from '../trip/map/features.js';

export const MAP_SIZE = Object.freeze({ width: 960, height: 540 });
const FIRST_WAIT = 25_000;
const NEXT_WAIT = 12_000;

const point = (coordinates, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });
const lineCoordinates = (feature) => (feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.coordinates.flat());

function job(key, layers) {
  const points = [
    ...[...layers.stops.features, ...layers.stays.features, ...layers.pins.features].map((feature) => feature.geometry.coordinates),
    ...[...layers.routes.features, ...layers.arcs.features, ...layers.lines.features].flatMap(lineCoordinates),
  ];
  return points.length ? { key, layers, points } : null;
}

/**
 * Map pictures to take: the trip overview (stops tinted per day, stays, routes and booking lines) and, when asked,
 * one per day with numbered stops. `routes` maps day ids to route results; `resIds` limits booking overlays.
 */
export function mapJobs({ planner, dayIds, routes, resIds, overview = true, perDay = false }) {
  const model = planner.model();
  const overlays = planner.overlays();
  const shown = (res) => resIds.has(res.id);
  const arcs = overlays.arcs.filter((feature) => resIds.has(feature.properties.id));
  const lines = estimateLines(overlays.lines.filter(shown)).map((feature) => ({ ...feature, properties: { ...feature.properties, tone: 'ink-2' } }));
  const jobs = [];
  if (overview) {
    const indexes = new Set(dayIds.map((id) => model.dayIndex.get(id)));
    const stops = [];
    for (const id of dayIds) {
      const entry = planner.stops(id);
      if (!entry) continue;
      const tone = dayTone(entry.day, entry.index);
      for (const item of entry.items) if (item.t === 'visit' && item.point) stops.push(point(item.point, { id: item.id, tone }));
    }
    const stays = model.stays.filter((stay) => [...indexes].some((index) => index >= stay.from && index <= stay.to))
      .map((stay) => point(stay.point, { id: stay.res.id, tone: 5 }));
    const pins = overlays.bookings.filter((entry) => shown(entry.res)).map((entry) => point(entry.point, { id: entry.res.id, tone: 'ink-2' }));
    const results = dayIds.map((id) => routes.get(id)).filter(Boolean);
    const trip = job('trip', { routes: routeFeatures(results, model), arcs: collection(arcs), lines: collection(lines), stops: collection(stops), stays: collection(stays), pins: collection(pins) });
    if (trip) jobs.push(trip);
  }
  if (perDay) {
    for (const id of dayIds) {
      const entry = planner.stops(id);
      if (!entry) continue;
      const tone = dayTone(entry.day, entry.index);
      const stops = [];
      let number = 0;
      for (const item of entry.items) {
        if (item.t !== 'visit' || !item.point) continue;
        number += 1;
        stops.push(point(item.point, { id: item.id, tone, order: number }));
      }
      const stays = [entry.start, entry.end].filter(Boolean).map((stay) => point(stay.point, { id: stay.res.id, tone: 5 }));
      const transports = new Set(entry.items.filter((item) => item.kind === 'transport').map((item) => item.id));
      const result = routes.get(id);
      const day = job(`day:${id}`, {
        routes: routeFeatures(result ? [result] : [], model),
        arcs: collection(arcs.filter((feature) => transports.has(feature.properties.id))),
        lines: collection(lines.filter((feature) => transports.has(feature.properties.id))),
        stops: collection(stops), stays: collection(stays), pins: collection(),
      });
      if (day && (stops.length || stays.length)) jobs.push(day);
    }
  }
  return jobs;
}

/** Equal jobs at the same quality share one picture. */
export const jobSignature = (item, compress) => JSON.stringify([item.layers, Boolean(compress)]);

function waitFor(map, event, ms, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => { clearTimeout(timer); map.off(event, done); signal.removeEventListener('abort', stop); resolve(value); };
    const done = () => finish(true);
    const stop = () => finish(false);
    if (signal.aborted) { resolve(false); return; }
    timer = setTimeout(stop, ms);
    signal.addEventListener('abort', stop, { once: true });
    map.once(event, done);
    map.triggerRepaint();
  });
}

// The drawing buffer is only readable during the frame that drew it, so the picture is taken in `render`.
function capture(map, quality) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { map.off('render', draw); reject(new Error('capture_timeout')); }, 5000);
    function draw() {
      clearTimeout(timer);
      try { resolve(map.getCanvas().toDataURL('image/jpeg', quality)); } catch (error) { reject(error); }
    }
    map.once('render', draw);
    map.triggerRepaint();
  });
}

/**
 * Takes map pictures one at a time on a single hidden light-theme map inside `parent`. `get(job, {compress})`
 * resolves to `{src, width, height}` or null; equal jobs share one picture. `skip()` gives every waiting and later
 * job null. `state` is `idle|working|failed|skipped`; `failed` means the map could not start or load its style.
 */
export function createSnapshotter({ parent, t, config, language = 'en', create = createTripMap, onState = () => {} }) {
  const cache = new Map();
  const life = new AbortController();
  const waits = new AbortController();
  let queue = Promise.resolve();
  let tripMap = null;
  let starting = null;
  let host = null;
  let broken = false;
  let first = true;
  let state = 'idle';
  const setState = (next) => { if (state !== next) { state = next; onState(next); } };
  const fail = () => { broken = true; waits.abort(); setState('failed'); };

  function ensureMap() {
    starting ??= (async () => {
      const container = el('div.print-snapshot-map', { style: { inlineSize: `${MAP_SIZE.width}px`, blockSize: `${MAP_SIZE.height}px` } });
      host = el('div.print-snapshot', { 'aria-hidden': 'true', inert: true }, container);
      parent.append(host);
      try {
        tripMap = await create(container, {
          t, theme: 'light', config, language, navigation: false, signal: life.signal,
          onError: () => { if (tripMap && !tripMap.map.isStyleLoaded()) fail(); },
        });
      } catch { fail(); }
      return tripMap;
    })();
    return starting;
  }

  async function take(item, compress) {
    const map = await ensureMap();
    if (!map || waits.signal.aborted) return null;
    const raw = map.map;
    const ratio = compress ? 1 : 2;
    if (raw.getPixelRatio?.() !== ratio) raw.setPixelRatio?.(ratio);
    const quiet = { interactive: false };
    map.setRoutes('routes', item.layers.routes, quiet);
    map.setArcs('lines', item.layers.lines, { ...quiet, width: 3 });
    map.setArcs('arcs', item.layers.arcs, quiet);
    map.setMarkers('stays', item.layers.stays, { ...quiet, cluster: false, radius: 9 });
    map.setMarkers('pins', item.layers.pins, { ...quiet, cluster: false, radius: 8 });
    map.setMarkers('stops', item.layers.stops, { ...quiet, cluster: false, radius: 11 });
    map.fit(item.points, { padding: 56, maxZoom: 14, duration: 0, animate: false });
    const ready = await waitFor(raw, 'idle', first ? FIRST_WAIT : NEXT_WAIT, waits.signal);
    first = false;
    if (!ready || broken) return null;
    const src = await capture(raw, compress ? 0.72 : 0.9);
    return { src, width: MAP_SIZE.width, height: MAP_SIZE.height };
  }

  return {
    get state() { return state; },
    get(item, { compress = true } = {}) {
      const signature = jobSignature(item, compress);
      if (cache.has(signature)) return cache.get(signature);
      const promise = queue.then(async () => {
        if (waits.signal.aborted) return null;
        setState('working');
        try { return await take(item, compress); } catch { return null; } finally { if (state === 'working') setState('idle'); }
      });
      queue = promise.catch(() => null);
      cache.set(signature, promise);
      return promise;
    },
    skip() {
      if (waits.signal.aborted) return;
      waits.abort();
      setState('skipped');
    },
    destroy() {
      waits.abort(); life.abort();
      try { tripMap?.destroy(); } catch { /* Already gone. */ }
      host?.remove();
      tripMap = null; host = null; cache.clear();
    },
  };
}
