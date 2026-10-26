// Track lines for the planner map: downloads each track place's geometry once per session and draws it with
// `tripMap.setTracks`. Kept small so the map chunk does not load the import dialogs; the track reader (and its gzip
// library) loads with the first track.

const cache = new Map();
const MAX_CACHED = 200;
// The map wrapper takes at most 200,000 positions per track layer, as plain [lng, lat] pairs.
const MAX_POSITIONS = 190_000;

function flat(feature) {
  const line = (segment) => segment.map((position) => [position[0], position[1]]);
  const geometry = feature.geometry.type === 'LineString'
    ? { type: 'LineString', coordinates: line(feature.geometry.coordinates) }
    : { type: 'MultiLineString', coordinates: feature.geometry.coordinates.map(line) };
  const count = geometry.type === 'LineString' ? geometry.coordinates.length : geometry.coordinates.reduce((sum, segment) => sum + segment.length, 0);
  return { geometry, count };
}

/** `api` is the session's worker client; `onChange` runs when a download finishes so the map can redraw. */
export function createTrackLayer({ space, api, onChange = () => {} }) {
  let destroyed = false;
  let signature = null;
  const failed = new Set();
  const keyOf = (place) => {
    const file = space.get('file', place.track.fileId);
    return file && !file.deleted ? `${space.ref.s}:${file.id}:${file.sha256}` : null;
  };
  function load(place, key) {
    if (!api || cache.has(key) || failed.has(key) || globalThis.navigator?.onLine === false) return;
    const promise = import('../../lib/io/track-file.js').then(({ downloadTrack }) => downloadTrack(space.ref, place.track.fileId, { api })).then((feature) => {
      cache.set(key, flat(feature));
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
      if (!destroyed) onChange();
    }, () => { cache.delete(key); failed.add(key); });
    cache.set(key, promise);
  }
  return {
    /** Draws the tracks of every track place, or only those on the selected day (`dayStops` from the planner). */
    render(tripMap, dayStops) {
      if (!tripMap?.setTracks || destroyed) return;
      const onDay = dayStops ? new Set(dayStops.items.filter((item) => item.t === 'visit').map((item) => item.entity.placeId)) : null;
      const features = [];
      const ids = [];
      let positions = 0;
      for (const place of space.select.place.all()) {
        if (!place.track?.fileId || (onDay && !onDay.has(place.id))) continue;
        const key = keyOf(place);
        if (!key) continue;
        const track = cache.get(key);
        if (!track || typeof track.then === 'function') { load(place, key); continue; }
        if (positions + track.count > MAX_POSITIONS) continue;
        positions += track.count;
        const color = place.track.color;
        features.push({ type: 'Feature', geometry: track.geometry,
          properties: { id: place.id, ...(Number.isInteger(color) ? { tone: color } : typeof color === 'string' ? { color } : { tone: 'accent' }) } });
        ids.push(`${key}:${JSON.stringify(color ?? null)}`);
      }
      const next = ids.join('|');
      if (next === signature) return;
      signature = next;
      tripMap.setTracks('tracks', { type: 'FeatureCollection', features });
    },
    destroy() { destroyed = true; },
  };
}
