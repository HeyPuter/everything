// Opening hours come from place details (OSM `opening_hours`), which the services layer caches for 30 days.
const PER_LOAD = 12;

const usable = (place) => Boolean(place?.ids?.osm || place?.ids?.wikidata);

/** `get(place)` → `{week, timeZone}` or null; `load(places, {signal})` fetches what is missing, one place at a time. */
export function createHoursSource({ services, lang = 'en', onChange }) {
  const known = new Map();
  const pending = new Set();
  return {
    get: (place) => known.get(place?.id) ?? null,
    async load(places, { signal } = {}) {
      const details = services?.placeInfo?.details;
      if (typeof details !== 'function') return;
      const wanted = places.filter((place) => usable(place) && !known.has(place.id) && !pending.has(place.id)).slice(0, PER_LOAD);
      let changed = false;
      for (const place of wanted) {
        if (signal?.aborted) break;
        pending.add(place.id);
        try {
          const result = await details({ wikidata: place.ids.wikidata, osm: place.ids.osm, name: place.name, lat: place.lat, lng: place.lng, tz: place.tz, lang }, { signal });
          const hours = result?.data?.hours;
          // Nothing cached while offline: try again next time.
          if (result || globalThis.navigator?.onLine !== false) known.set(place.id, hours?.week ? { week: hours.week, timeZone: result.data.timeZone ?? null } : null);
          changed ||= Boolean(hours?.week);
        } catch (error) {
          if (error?.name === 'AbortError') break;
          known.set(place.id, null);
        } finally { pending.delete(place.id); }
      }
      if (changed) onChange?.();
    },
  };
}
