// "Open in" deep links. Coordinates when the place has them, otherwise a search for its name and address.
import { hasLocation } from './filter.js';

const fixed = (value) => Number(value.toFixed(6));

export function mapLinks(place) {
  const located = hasLocation(place);
  const lat = located ? fixed(place.lat) : 0;
  const lng = located ? fixed(place.lng) : 0;
  const label = encodeURIComponent(place.name ?? '');
  const query = encodeURIComponent([place.name, place.address].filter(Boolean).join(', '));
  if (!located && !query) return [];
  return [
    { id: 'google', url: located ? `https://www.google.com/maps/search/?api=1&query=${lat}%2C${lng}` : `https://www.google.com/maps/search/?api=1&query=${query}` },
    { id: 'apple', url: located ? `https://maps.apple.com/?ll=${lat},${lng}&q=${label}` : `https://maps.apple.com/?q=${query}` },
    { id: 'osm', url: located ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}` : `https://www.openstreetmap.org/search?query=${query}` },
    { id: 'waze', url: located ? `https://www.waze.com/ul?ll=${lat}%2C${lng}&navigate=yes` : `https://www.waze.com/ul?q=${query}` },
    ...(located ? [{ id: 'comaps', url: `https://comaps.at/map?v=1&ll=${lat},${lng}&n=${label}` }] : []),
  ];
}
