// The user's recorded Dawarich trail for the selected day on the planner map, drawn only in their own browser.
import { isDate, isTimeZone } from '../../shared/dates.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { dawarichClient, dayTrail } from '../../lib/integrations/dawarich.js';
import { netAvailable, today, tripZone } from './common.js';

const LAYER = 'dawarich-trail';
const cache = new Map();
const MAX_CACHED = 60;
const empty = () => ({ type: 'FeatureCollection', features: [] });

/** The zone of a day: its first visited place with a zone, else the trip's. */
function dayZone(space, dayId) {
  for (const visit of space.select?.visit?.groupBy?.('dayId')?.get?.(dayId) ?? []) {
    const zone = visit.placeId ? space.get('place', visit.placeId)?.tz : null;
    if (isTimeZone(zone)) return zone;
  }
  return tripZone(space);
}

/** `render(tripMap, dayId)` draws the trail of a past or current day; `onChange` runs when a download finishes. */
export function createTrailLayer({ space, puter, onChange = () => {} }) {
  const store = integrationStore(puter);
  let destroyed = false;
  let signature = null;
  if (netAvailable(puter)) {
    void store.load().then(() => { if (!destroyed) onChange(); }, () => {});
  }
  const off = store.subscribe(() => { if (!destroyed) onChange(); });

  function load(key, config, date, zone) {
    const task = dayTrail(dawarichClient(puter, config), { date, zone }).then((trail) => {
      cache.set(key, trail);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      if (!destroyed) onChange();
    }, () => { cache.set(key, { segments: [], failed: true }); });
    cache.set(key, task);
  }

  return {
    render(tripMap, dayId) {
      if (!tripMap?.setTracks || destroyed) return;
      const config = netAvailable(puter) ? store.get('dawarich') : null;
      const day = config && config.trails !== false && dayId ? space.get('day', dayId) : null;
      let data = empty();
      let next = 'none';
      if (day && isDate(day.date) && day.date <= today()) {
        const zone = dayZone(space, day.id);
        const key = `${config.url}|${day.date}|${zone}`;
        const trail = cache.get(key);
        if (!trail) { if (globalThis.navigator?.onLine !== false) load(key, config, day.date, zone); }
        else if (typeof trail.then !== 'function' && trail.segments.length) {
          data = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: trail.segments }, properties: { id: 'trail', tone: 'ink-3', dashed: true } }] };
          next = key;
        }
      }
      if (next === signature) return;
      signature = next;
      try { tripMap.setTracks(LAYER, data, { width: 2.5, casing: false, interactive: false }); } catch { /* A map that refuses the layer keeps drawing the rest. */ }
    },
    destroy() { destroyed = true; off(); },
  };
}
