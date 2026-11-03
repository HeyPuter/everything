import { DAY, attribution, point } from './core.js';
import { AVOID, MAX_ROUTE_POINTS, decodePolyline, straightRoute } from './route.js';
import { splitAtWaypoints } from '../lib/road/geo.js';
import { t } from '../lib/i18n/index.js';

const fixMap = () => ({ text: t('services.fixMap'), url: 'https://www.openstreetmap.org/fixthemap' });
const metric = (value) => Number.isFinite(value) && value >= 0;

function valhallaLegs(data, count) {
  const trip = data?.trip;
  if (trip?.status !== 0 || !Array.isArray(trip.legs) || trip.legs.length !== count - 1) throw new Error('Invalid Valhalla response');
  return trip.legs.map((leg) => {
    const summary = leg?.summary ?? {};
    if (!metric(summary.length) || !metric(summary.time) || typeof leg.shape !== 'string') throw new Error('Invalid Valhalla leg');
    const line = decodePolyline(leg.shape, 6).map(point);
    if (line.length < 2) throw new Error('Invalid Valhalla leg');
    return {
      distance: summary.length * 1000, duration: summary.time, line,
      flags: { toll: summary.has_toll === true, ferry: summary.has_ferry === true, motorway: summary.has_highway === true },
    };
  });
}

/**
 * Driving routes for road trips. Valhalla (geo worker) comes first because it returns per-leg shapes and toll, ferry
 * and motorway flags; otherwise the shared route adapter's line is split at the waypoints, without flags.
 * `route(points, {avoid, signal})` → `{legs: [{distance (m), duration (s), line, flags|null}], estimated, avoidsApplied,
 * attribution}`. Never throws for provider failures; offline without a cached answer it estimates.
 */
export function createRoadRoute({ context, route }) {
  return {
    async route(points, { avoid = [], signal } = {}) {
      if (!Array.isArray(points) || points.length < 2 || points.length > MAX_ROUTE_POINTS) throw new RangeError('Invalid route');
      const clean = points.map((value) => point(value).map((n) => Number(n.toFixed(5))));
      if (!Array.isArray(avoid) || avoid.some((value) => !AVOID.includes(value))) throw new RangeError('Invalid avoid option');
      const avoids = [...new Set(avoid)].sort();
      let valhalla = null;
      if (context?.run) {
        try {
          valhalla = await context.run('route', { road: 1, points: clean, avoid: avoids }, {
            'geo-valhalla': async (cfg, request = {}) => {
              if (!cfg.geoWorker) return null;
              const { data } = await context.json(new URL('/valhalla', cfg.geoWorker).href, { method: 'POST', body: { points: clean, mode: 'drive', avoid: avoids }, provider: 'geo-valhalla', retries: 0, ...request });
              return { data: { legs: valhallaLegs(data, clean.length) }, attribution: [attribution.valhalla, fixMap()] };
            },
          }, { ttl: 7 * DAY, signal, cacheVariant: (cfg) => cfg.geoWorker });
        } catch (error) { if (error?.name === 'AbortError') throw error; }
      }
      if (valhalla?.data?.legs) return { legs: valhalla.data.legs, estimated: false, avoidsApplied: true, attribution: valhalla.attribution ?? [] };
      let shared = null;
      try { shared = route ? await route.route(clean, 'drive', { avoid: avoids, signal }) : null; } catch (error) { if (error?.name === 'AbortError') throw error; }
      const data = shared?.data ?? { ...straightRoute(clean, 'drive'), avoidsApplied: avoids.length === 0 };
      const lines = splitAtWaypoints(data.geometry.coordinates, clean);
      const legs = (data.legs ?? straightRoute(clean, 'drive').legs).map((leg, index) => ({ distance: leg.distance, duration: leg.duration, line: lines[index] ?? [clean[index], clean[index + 1]], flags: null }));
      return { legs, estimated: Boolean(data.estimated), avoidsApplied: data.avoidsApplied !== false, attribution: shared?.attribution ?? [] };
    },
  };
}
