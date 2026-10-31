import { abortError, stable } from '../../services/core.js';
import { createTripModel } from './model.js';
import { estimateStops, routeStops } from './routes.js';
import { proposeOrder } from './optimize.js';
import { bookingOverlays, estimateLines, routeLines } from './overlays.js';

const CACHE_LIMIT = 200;

/**
 * Per-trip route planning over a space (`openSpace` handle). `route` is `session.services.route` (null keeps
 * every result a straight-line estimate). `timeline(dayId)` optionally supplies the plan view's merged order.
 * `day(dayId)` calls for unchanged input share one routing job; `latest(dayId)` is the routed result when known, else
 * the estimate; `subscribe` hears each day as it is routed.
 *
 * Day routes are `{dayId, mode, routed, legs, transports, distance, duration, estimated, attribution, features}`;
 * each leg is `{from: {t, id}, to: {t, id}, mode, distance (m), duration (s), estimated}`.
 */
export function createRoutePlanner({ space, route = null, timeline } = {}) {
  let modelCache = null;
  let overlayCache = null;
  const results = new Map();
  const lineResults = new Map();
  const listeners = new Set();
  const source = () => [space.select.day.all(), space.select.visit.all(), space.select.place.all(), space.select.res.all()];

  function model() {
    const inputs = source();
    if (!modelCache || modelCache.inputs.some((value, i) => value !== inputs[i])) {
      const [days, visits, places, reservations] = inputs;
      modelCache = { inputs, model: createTripModel({ days, visits, places, reservations, timeline }) };
    }
    return modelCache.model;
  }
  const stops = (dayId) => model().dayStops(dayId);
  function overlays() {
    const current = model();
    if (overlayCache?.model !== current) overlayCache = { model: current, value: bookingOverlays(current) };
    return overlayCache.value;
  }
  const keyOf = (entry) => stable(entry.input);
  function remember(key, value) {
    results.delete(key); results.set(key, value);
    while (results.size > CACHE_LIMIT) results.delete(results.keys().next().value);
  }

  async function day(dayId, { signal } = {}) {
    const entry = stops(dayId);
    if (!entry) return null;
    const key = keyOf(entry);
    const known = results.get(key);
    if (known?.value) return known.value;
    if (!route) return estimateStops(entry);
    if (signal?.aborted) throw abortError();
    let job = known;
    if (!job?.promise) {
      const controller = new AbortController();
      job = { controller, consumers: 0 };
      job.promise = routeStops(route, entry, { signal: controller.signal }).then((value) => {
        remember(key, { value });
        for (const listener of [...listeners]) listener(dayId, value);
        return value;
      }, (error) => { if (results.get(key) === job) results.delete(key); throw error; });
      job.promise.catch(() => {});
      remember(key, job);
    }
    // The routing job is shared; it stops only when every caller waiting on it has aborted.
    job.consumers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; job.consumers--; signal?.removeEventListener('abort', cancel); return true; };
      const cancel = () => {
        if (!finish()) return;
        if (!job.consumers) { job.controller.abort(); if (results.get(key) === job) results.delete(key); }
        reject(abortError());
      };
      signal?.addEventListener('abort', cancel, { once: true });
      job.promise.then((value) => { if (finish()) resolve(value); }, (error) => { if (finish()) reject(error); });
    });
  }

  return {
    model,
    stops,
    estimate(dayId) { const entry = stops(dayId); return entry ? estimateStops(entry) : null; },
    day,
    latest(dayId) {
      const entry = stops(dayId);
      if (!entry) return null;
      return results.get(keyOf(entry))?.value ?? estimateStops(entry);
    },
    async trip({ signal } = {}) {
      const days = [];
      for (const { id } of model().days) {
        const value = await day(id, { signal });
        if (value) days.push(value);
      }
      return { days, distance: days.reduce((sum, value) => sum + value.distance, 0), duration: days.reduce((sum, value) => sum + value.duration, 0), estimated: days.some((value) => value.estimated) };
    },
    overlays,
    /** Booking line features: cached routed geometry where known, else routed now (straight when `route` is null). */
    async overlayLines({ signal } = {}) {
      const features = [];
      for (const line of overlays().lines) {
        if (!line.mode || !route) { features.push(...estimateLines([line])); continue; }
        const key = stable({ points: line.points, mode: line.mode });
        if (!lineResults.has(key)) {
          const [feature] = await routeLines(route, [line], { signal });
          lineResults.set(key, feature);
          while (lineResults.size > CACHE_LIMIT) lineResults.delete(lineResults.keys().next().value);
        }
        const cached = lineResults.get(key);
        features.push({ ...cached, properties: { ...cached.properties, id: line.id, type: line.type, status: line.status } });
      }
      return features;
    },
    propose(dayId, options) { const entry = stops(dayId); return entry ? proposeOrder(entry, options) : null; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
