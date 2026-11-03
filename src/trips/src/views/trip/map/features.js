import { t } from '../../../lib/i18n/index.js';
import { formatDate, formatNumber } from '../../../lib/format.js';
import { coords } from '../../../lib/route-plan/index.js';
import { categoryStyle } from '../../../lib/categories.js';
import { markerIconId } from './marker-icons.js';

export const collection = (features = []) => ({ type: 'FeatureCollection', features });
const pointFeature = (point, properties) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: point } });

export function dayTone(day, index) { return Number.isInteger(day?.color) && day.color >= 1 && day.color <= 8 ? day.color : (index % 8) + 1; }
export function dayLabel(day, index) {
  if (day?.title?.trim()) return day.title.trim();
  if (day?.date) return formatDate(day.date, { style: 'medium', weekday: true, year: false });
  return t('planMap.dayN', { n: index + 1 });
}

/** Average of per-user ratings, or null. */
export function averageRating(place) {
  const values = Object.values(place?.rating ?? {}).filter((value) => Number.isInteger(value) && value >= 1 && value <= 5);
  return values.length ? { average: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length } : null;
}

const style = (place, space) => {
  const value = categoryStyle(place.cat, space);
  return { ...(value.tone !== undefined ? { tone: value.tone } : {}), ...(value.color ? { color: value.color } : {}), icon: markerIconId(value.icon) };
};

/**
 * Marker data for the open view. Whole trip: every located place with its category color and glyph.
 * One day: that day's visits numbered in plan order in the day's tone (`stops`), other places muted.
 * `ratings` are small average-rating labels beside rated markers.
 */
export function placeFeatures({ model, space, dayStops }) {
  const inDay = new Set();
  const stops = [];
  if (dayStops) {
    const tone = dayTone(dayStops.day, dayStops.index);
    let number = 0;
    for (const item of dayStops.items) {
      if (item.t !== 'visit') continue;
      number++;
      const place = item.entity.placeId ? model.place(item.entity.placeId) : null;
      const point = coords(place);
      if (!point) continue;
      inDay.add(place.id);
      stops.push(pointFeature(point, { id: place.id, visit: item.id, tone, order: number, title: place.name ?? '' }));
    }
  }
  const places = [];
  const labels = [...stops.map((feature) => pointFeature(feature.geometry.coordinates, { id: feature.properties.id, title: feature.properties.title }))];
  for (const place of space.select.place.all()) {
    const point = coords(place);
    if (!point || inDay.has(place.id)) continue;
    places.push(pointFeature(point, dayStops ? { id: place.id, tone: 'ink-3', title: place.name ?? '' } : { id: place.id, ...style(place, space), title: place.name ?? '' }));
    if (!dayStops) labels.push(pointFeature(point, { id: place.id, title: place.name ?? '' }));
  }
  const ratings = [];
  for (const feature of [...stops, ...places]) {
    if (dayStops && feature.properties.tone === 'ink-3') continue;
    const value = averageRating(model.place(feature.properties.id));
    if (value) ratings.push(pointFeature(feature.geometry.coordinates, { id: feature.properties.id, rating: formatNumber(value.average, { digits: 1 }) }));
  }
  return { places: collection(places), stops: collection(stops), labels: collection(labels), ratings: collection(ratings) };
}

/** Lodging and located bookings without a place marker. */
export function bookingMarkers(overlays) {
  return collection([
    ...overlays.stays.filter((stay) => !stay.place || !coords(stay.place)).map((stay) => pointFeature(stay.point, { id: stay.res.id, kind: 'stay', tone: 5, icon: markerIconId('bed-double'), title: stay.res.title ?? '', status: stay.res.status })),
    ...overlays.bookings.map((entry) => pointFeature(entry.point, { id: entry.res.id, kind: 'booking', tone: 'ink-2', icon: markerIconId(entry.res.type === 'restaurant' ? 'utensils' : entry.res.type === 'flight' ? 'plane' : 'ticket'), title: entry.res.title ?? '', status: entry.res.status })),
  ]);
}

/** Road features of day routes, colored by day. */
export function routeFeatures(results, model) {
  const features = [];
  for (const result of results) {
    if (!result) continue;
    const index = model.dayIndex.get(result.dayId);
    const tone = dayTone(model.days[index], index ?? 0);
    for (const feature of result.features.features) if (feature.properties?.kind === 'road') features.push({ ...feature, properties: { ...feature.properties, id: result.dayId, tone } });
  }
  return collection(features);
}

/** Points to frame: a day's stays and stops, or the trip's places, stays and bookings (endpoints when nothing else). */
export function framePoints({ places, dayStops, overlays }) {
  const points = [];
  if (dayStops) {
    if (dayStops.start) points.push(dayStops.start.point);
    for (const item of dayStops.items) for (const point of [item.point, item.from, item.to]) if (point) points.push(point);
    if (dayStops.end) points.push(dayStops.end.point);
    return points;
  }
  for (const place of places) { const point = coords(place); if (point) points.push(point); }
  for (const stay of overlays.stays) points.push(stay.point);
  for (const entry of overlays.bookings) points.push(entry.point);
  if (!points.length) for (const feature of overlays.endpoints) points.push(feature.geometry.coordinates);
  return points;
}
