import { buildTimeline, stopNumbers } from '../../lib/timeline/index.js';
import { compareRes, isLodging, isTransport } from '../../lib/res/index.js';
import { computeBalances, netsOf, simplify, spendOf } from '../../lib/costs/ledger.js';
import { isCurrency } from '../../shared/money.js';
import { groupLists, itemGrams, packState } from '../trip/lists/model.js';
import { daysInRange } from './options.js';

const PHOTOS_PER_DAY = 6;

/** Private items are only ever the caller's own (`space.query` reads them from the caller's KV). */
function query(space, type) {
  try { return space.query?.(type, { includePrivate: true }) ?? space.select?.[type]?.all?.() ?? []; } catch { return space.select?.[type]?.all?.() ?? []; }
}

/** The replica entities the print view uses, read once per render. */
export function readTrip(space) {
  const all = (type) => space.select?.[type]?.all?.() ?? [];
  return {
    meta: space.get('meta', 'meta') ?? null,
    days: all('day'), visits: all('visit'), dayNotes: all('dayNote'), reservations: all('res'), places: all('place'),
    members: all('member'), guests: all('guest'), pack: query(space, 'pack'), bags: all('bag'), listMeta: all('listMeta'),
    expenses: query(space, 'exp'), settlements: all('settle'), notes: all('note'),
  };
}

const located = (place) => Number.isFinite(place?.lat) && Number.isFinite(place?.lng);
const byPinned = (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : 1);

function dayModel(entry, { placeById, routes }) {
  // Cancelled bookings are left out of the itinerary; the bookings section still lists them.
  const rows = entry.rows.filter((row) => !(row.kind === 'res' && row.entity.status === 'cancelled'));
  const numbers = stopNumbers(rows, (visit) => located(placeById.get(visit.placeId)));
  const photos = [];
  const seen = new Set();
  for (const row of rows) {
    const place = row.kind === 'visit' ? placeById.get(row.entity.placeId) : null;
    if (!place?.img || seen.has(place.id) || photos.length >= PHOTOS_PER_DAY) continue;
    seen.add(place.id);
    photos.push({ place, img: place.img });
  }
  return {
    id: entry.day.id, day: entry.day, number: entry.number, color: entry.color, date: entry.date,
    rows: rows.map((row) => ({
      ...row, place: row.kind === 'visit' ? placeById.get(row.entity.placeId) ?? null : null,
      stop: row.kind === 'visit' && row.primary ? numbers.get(row.id) ?? null : null,
    })),
    stays: entry.stays.filter((stay) => stay.res.status !== 'cancelled'),
    route: routes.get(entry.day.id) ?? null,
    photos,
  };
}

function packingModel(trip, uid) {
  const perPerson = Boolean(trip.meta?.settings?.perPersonPacking);
  const bags = new Map(trip.bags.map((bag) => [bag.id, bag]));
  let done = 0; let total = 0;
  const lists = groupLists(trip.listMeta, trip.pack, 'pack').filter((group) => group.items.length).map((group) => ({
    name: group.name,
    items: group.items.map((item) => {
      const state = packState(item, { uid, perPerson });
      if (state.relevant) { total += 1; if (state.done) done += 1; }
      return { item, done: state.done, bag: bags.get(item.bagId) ?? null, grams: itemGrams(item) };
    }),
  }));
  return { lists, done, total };
}

function costsModel(trip) {
  const currency = isCurrency(trip.meta?.currency) ? trip.meta.currency : 'EUR';
  const shared = trip.expenses.filter((exp) => !exp.private);
  const privates = trip.expenses.filter((exp) => exp.private);
  const balances = computeBalances({ expenses: shared, settlements: trip.settlements, tripCurrency: currency });
  const split = trip.meta?.settings?.splitCosts;
  const splitCosts = typeof split === 'boolean' ? split : trip.members.length + trip.guests.length > 1;
  return {
    currency,
    count: shared.length,
    spend: balances.spend,
    categories: [...balances.byCategory].map(([id, amount]) => ({ id, amount })).sort((a, b) => b.amount - a.amount || (a.id < b.id ? -1 : 1)),
    people: splitCosts ? [...balances.people.values()].map((entry) => ({ who: entry.who, paid: entry.paid, share: entry.share + entry.unpaidShare, net: entry.net })) : [],
    transfers: splitCosts ? simplify(netsOf(balances)) : [],
    pending: balances.pending.expenses.length,
    personal: privates.length ? spendOf(privates, currency) : null,
  };
}

export const tripTimeline = (trip) => buildTimeline({ days: trip.days, visits: trip.visits, notes: trip.dayNotes, reservations: trip.reservations });

/**
 * Everything the printed pages show, honouring the day range. `routes` maps day ids to route results
 * (`createRoutePlanner` day results); `uid` is the viewer, whose private items and checks are included;
 * `available` lists the sections the trip offers (spend stays off the cover when costs are turned off).
 */
export function buildPrintModel(trip, options, { uid = null, routes = new Map(), timeline = tripTimeline(trip), available = null } = {}) {
  const selected = daysInRange(trip.days, options);
  const full = selected.length === trip.days.length;
  const placeById = new Map(trip.places.map((place) => [place.id, place]));
  const entries = selected.map((day) => timeline.byDay.get(day.id)).filter(Boolean);
  const days = entries.map((entry) => dayModel(entry, { placeById, routes }));

  // A partial range lists only the bookings that show on its days; the whole trip also lists undated ones.
  const shown = new Set();
  for (const entry of entries) {
    for (const row of entry.rows) if (row.kind === 'res') shown.add(row.id);
    for (const stay of entry.stays) shown.add(stay.res.id);
  }
  const reservations = trip.reservations.filter((res) => !res.deleted && (full || shown.has(res.id))).sort(compareRes);
  const bookings = {
    transport: reservations.filter((res) => isTransport(res.type)),
    stays: reservations.filter((res) => isLodging(res.type)),
    other: reservations.filter((res) => !isTransport(res.type) && !isLodging(res.type)),
  };

  const names = new Map([
    ...trip.members.map((member) => [member.id, { name: member.name, guest: false }]),
    ...trip.guests.map((guest) => [guest.id, { name: guest.name, guest: true }]),
  ]);
  const placesVisited = new Set(days.flatMap((day) => day.rows.filter((row) => row.kind === 'visit' && row.place).map((row) => row.place.id)));
  const routed = days.map((day) => day.route).filter((route) => route?.distance > 0);
  const costs = costsModel(trip);

  return {
    meta: trip.meta ?? {},
    full,
    range: { first: days[0]?.number ?? null, last: days.at(-1)?.number ?? null, start: days.find((day) => day.date)?.date ?? null, end: days.findLast((day) => day.date)?.date ?? null },
    days,
    bookings,
    names,
    travelers: [...names.values()],
    packing: packingModel(trip, uid),
    costs,
    notes: trip.notes.filter((note) => !note.deleted).slice().sort(byPinned),
    stats: {
      days: days.length,
      places: placesVisited.size,
      bookings: reservations.filter((res) => res.status !== 'cancelled').length,
      travelers: names.size,
      distance: routed.length ? { meters: routed.reduce((sum, route) => sum + route.distance, 0), estimated: routed.some((route) => route.estimated) } : null,
      spend: costs.count && (!available || available.includes('costs')) ? { amount: costs.spend, currency: costs.currency } : null,
    },
  };
}
