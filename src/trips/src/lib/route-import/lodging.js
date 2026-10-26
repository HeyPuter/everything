// Deep links to lodging portals for a night on the road, prefilled with where and when. Nothing is fetched; the
// links open in a new tab.
import { isDate } from '../../shared/dates.js';

const located = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const fixed = (value) => Number(value).toFixed(5);

/**
 * `[{id, url}]` for a point (`lat`, `lng`, optional `name`), with check-in and check-out dates when both are valid and
 * in order, and the number of adults (1–16).
 */
export function lodgingLinks({ lat, lng, name = '', checkIn = null, checkOut = null, adults = 2 } = {}) {
  if (!located(lat, lng)) return [];
  const dated = isDate(checkIn) && isDate(checkOut) && checkOut > checkIn;
  const people = Math.min(16, Math.max(1, Math.round(Number(adults) || 1)));
  const booking = new URL('https://www.booking.com/searchresults.html');
  booking.search = new URLSearchParams({
    ...(name ? { ss: name } : {}), latitude: fixed(lat), longitude: fixed(lng), group_adults: String(people), no_rooms: '1',
    ...(dated ? { checkin: checkIn, checkout: checkOut } : {}),
  });
  const airbnb = new URL('https://www.airbnb.com/s/homes');
  const span = 0.05;
  airbnb.search = new URLSearchParams({
    ne_lat: fixed(lat + span), ne_lng: fixed(lng + span), sw_lat: fixed(lat - span), sw_lng: fixed(lng - span), search_by_map: 'true', adults: String(people),
    ...(dated ? { checkin: checkIn, checkout: checkOut } : {}),
  });
  const maps = `https://www.google.com/maps/search/hotels/@${fixed(lat)},${fixed(lng)},13z`;
  return [{ id: 'booking', url: booking.href }, { id: 'airbnb', url: airbnb.href }, { id: 'maps', url: maps }];
}
