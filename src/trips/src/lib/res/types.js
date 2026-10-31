// Reservation types, their groups and per-type form metadata. Labels live in the bookings strings.

export const TRANSPORT_TYPES = Object.freeze(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
export const BOOKING_TYPES = Object.freeze(['lodging', 'restaurant', 'event', 'tour', 'parking', 'other']);
export const RES_TYPES = Object.freeze([...TRANSPORT_TYPES, ...BOOKING_TYPES]);
export const STATUSES = Object.freeze(['pending', 'confirmed', 'cancelled']);

/** Transports are described by ordered legs; bookings by start, end and a location. */
export const isTransport = (type) => TRANSPORT_TYPES.includes(type);
export const isLodging = (type) => type === 'lodging';
export const groupOf = (type) => (isTransport(type) ? 'transport' : 'booking');

/** Optional leg fields shown per transport type, in form order. */
export const LEG_FIELDS = Object.freeze({
  flight: ['carrier', 'number', 'seat', 'cls', 'code'],
  train: ['carrier', 'number', 'coach', 'seat', 'platform', 'cls', 'code'],
  bus: ['carrier', 'number', 'seat', 'platform', 'code'],
  car: ['carrier', 'number', 'code'],
  taxi: ['carrier', 'code'],
  bike: ['carrier', 'code'],
  cruise: ['carrier', 'number', 'seat', 'cls', 'code'],
  ferry: ['carrier', 'number', 'seat', 'cls', 'platform', 'code'],
  transit: ['carrier', 'number', 'mode', 'platform'],
  transport: ['carrier', 'number', 'seat', 'code'],
});

/** How a transport's endpoints are picked: the bundled airport list, or location search. */
export const endpointKind = (type) => (type === 'flight' ? 'airport' : 'place');

/**
 * Phase names for an entry spanning days, by type: [start, middle, end]. A booking that fits in one day has
 * the single phase. Timelines translate them as `bookings.phase.<name>`.
 */
const PHASE_NAMES = Object.freeze({
  transport: ['depart', 'transit', 'arrive'],
  car: ['pickup', 'active', 'return'],
  parking: ['dropoff', 'parked', 'collect'],
  lodging: ['checkin', 'stay', 'checkout'],
  generic: ['start', 'ongoing', 'end'],
});
const phaseFamily = (type) => {
  if (type === 'car' || type === 'bike') return 'car';
  if (type === 'parking' || type === 'lodging') return type;
  return isTransport(type) ? 'transport' : 'generic';
};
export function phaseName(type, phase) {
  if (phase === 'single') return 'single';
  const names = PHASE_NAMES[phaseFamily(type)];
  return names[{ start: 0, middle: 1, end: 2 }[phase]] ?? 'single';
}
