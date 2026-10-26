// Turns the stops of an imported route into trip writes: places (reusing the trip's own when they match), visits on
// one day in route order, the travel mode between them, and road-trip route points.
import { orderKeys } from '../../shared/order.js';
import { validateOperation } from '../../shared/operations.js';
import { duplicateOf } from '../io/plan.js';

export const ROUTE_MODES = Object.freeze(['drive', 'bike', 'walk', 'transit']);
const located = (stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);

/**
 * Drafts `[{t, id, put}]` for the chosen stops (`{name, lat, lng, address?, osm?}`, each located). `places` are the
 * trip's places for reuse, `after` the last order key on the day, `vias` route points `{lat, lng, after}` (index of the
 * stop they follow; only with `roadtrip`). Returns `{drafts, reused, created}`.
 */
export function routeDrafts({ stops, vias = [], dayId, mode = null, places = [], reuse = true, after = null, roadtrip = false, makeId, fallbackName = 'Stop' }) {
  const chosen = stops.filter(located);
  const drafts = [];
  const visitIds = [];
  let reused = 0;
  const keys = orderKeys(chosen.length, after, null);
  const legMode = ROUTE_MODES.includes(mode) ? mode : null;
  chosen.forEach((stop, index) => {
    const name = String(stop.name ?? '').trim().slice(0, 500) || fallbackName;
    let placeId = reuse ? duplicateOf({ name, lat: stop.lat, lng: stop.lng }, places) : undefined;
    if (placeId) reused += 1;
    else {
      placeId = makeId();
      const put = { name, lat: stop.lat, lng: stop.lng, src: 'google-route' };
      if (stop.address) put.address = String(stop.address).slice(0, 2000);
      if (stop.osm) put.ids = { osm: String(stop.osm).slice(0, 500) };
      drafts.push({ t: 'place', id: placeId, put });
    }
    const visitId = makeId();
    visitIds.push(visitId);
    drafts.push({ t: 'visit', id: visitId, put: { dayId, placeId, order: keys[index], ...(legMode && index < chosen.length - 1 ? { legMode } : {}) } });
  });
  if (roadtrip) {
    // Route points belong to the leg leaving the stop they follow; stops that were left out move them earlier.
    const position = new Map(stops.map((stop, index) => [index, chosen.indexOf(stop)]));
    const viaKeys = orderKeys(vias.length);
    vias.forEach((via, index) => {
      let from = via.after;
      while (from >= 0 && position.get(from) === -1) from -= 1;
      const at = from >= 0 ? position.get(from) : -1;
      if (at < 0 || at >= visitIds.length - 1) return;
      drafts.push({ t: 'via', id: makeId(), put: { dayId, after: visitIds[at], order: viaKeys[index], lat: via.lat, lng: via.lng } });
    });
  }
  for (const draft of drafts) validateOperation({ opId: makeId(), ...draft }, { kind: 'trip' });
  return { drafts, reused, created: chosen.length - reused };
}
