// Deterministic big-trip fixture for performance work (architecture §18): 60 days, 1,000 places, ~600 visits,
// 80 bookings, 300 expenses, 400 packing items, 2,000 chat messages, 200 files and 6 members.
import { createIdGenerator } from '../../src/shared/ids.js';
import { orderKeys } from '../../src/shared/order.js';
import { addDays } from '../../src/shared/dates.js';

export const LARGE = Object.freeze({ days: 60, places: 1000, visits: 600, bookings: 80, expenses: 300, packing: 400, messages: 2000, files: 200, members: 6 });

export const FIXTURE_MEMBERS = Object.freeze(['alice', 'bob', 'carol', 'dave', 'erin', 'frank'].map((username, index) => Object.freeze({
  uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, username,
})));

const CITIES = [
  ['Lisbon', 38.72, -9.14, 'PT', 'Europe/Lisbon'], ['Porto', 41.15, -8.61, 'PT', 'Europe/Lisbon'], ['Madrid', 40.42, -3.70, 'ES', 'Europe/Madrid'],
  ['Seville', 37.39, -5.98, 'ES', 'Europe/Madrid'], ['Barcelona', 41.39, 2.17, 'ES', 'Europe/Madrid'], ['Lyon', 45.76, 4.84, 'FR', 'Europe/Paris'],
  ['Paris', 48.86, 2.35, 'FR', 'Europe/Paris'], ['Brussels', 50.85, 4.35, 'BE', 'Europe/Brussels'], ['Amsterdam', 52.37, 4.90, 'NL', 'Europe/Amsterdam'],
  ['Cologne', 50.94, 6.96, 'DE', 'Europe/Berlin'], ['Berlin', 52.52, 13.40, 'DE', 'Europe/Berlin'], ['Prague', 50.08, 14.44, 'CZ', 'Europe/Prague'],
  ['Vienna', 48.21, 16.37, 'AT', 'Europe/Vienna'], ['Budapest', 47.50, 19.04, 'HU', 'Europe/Budapest'], ['Zagreb', 45.81, 15.98, 'HR', 'Europe/Zagreb'],
  ['Ljubljana', 46.06, 14.51, 'SI', 'Europe/Ljubljana'], ['Venice', 45.44, 12.32, 'IT', 'Europe/Rome'], ['Florence', 43.77, 11.26, 'IT', 'Europe/Rome'],
  ['Rome', 41.90, 12.50, 'IT', 'Europe/Rome'], ['Naples', 40.85, 14.27, 'IT', 'Europe/Rome'],
];
const CATS = [['Food', 'utensils'], ['Sights', 'landmark'], ['Museums', 'camera'], ['Nature', 'mountain'], ['Nightlife', 'music'], ['Shopping', 'shopping-bag'], ['Coffee', 'coffee'], ['Hotels', 'bed-double']];
const KINDS = ['Café', 'Museum', 'Market', 'Church', 'Park', 'Bistro', 'Gallery', 'Viewpoint', 'Bar', 'Bakery', 'Tower', 'Garden'];
const LISTS = ['Clothes', 'Toiletries', 'Electronics', 'Documents', 'Health', 'Outdoor', 'Kids', 'Snacks'];
const WORDS = 'the a train museum dinner tomorrow tickets booked early late meet station hotel square bridge walk rain sun map bus metro coffee breakfast lunch plan change idea photo view market old town river tour guide queue open closed price cheap'.split(' ');
const EMOJI = ['👍', '❤️', '😂', '🎉'];

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plain client-side fields for every entity, grouped for seeding: `{space, meta, ops: [{t, id, put}], messages:
 * [{author, id, put}], files: [{id, put}]}`. Ops are ordered so referenced days, places, categories and bags come first.
 */
export function largeTrip({ seed = 7, start = '2027-03-01', members = FIXTURE_MEMBERS, epoch = 1_790_000_000_000 } = {}) {
  const random = prng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  let clock = epoch;
  const makeId = createIdGenerator({ now: () => (clock += 1), random: (bytes) => bytes.map(() => Math.floor(random() * 256)) });
  const people = members.map((member) => member.uuid);
  const sentence = (min, max) => { const n = int(min, max); const words = Array.from({ length: n }, () => pick(WORDS)); words[0] = words[0][0].toUpperCase() + words[0].slice(1); return `${words.join(' ')}.`; };
  const time = (min, max) => { const minutes = int(min, max) * 15; return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; };
  const end = addDays(start, LARGE.days - 1);
  const ops = [];
  const add = (t, put, id = makeId()) => { ops.push({ t, id, put }); return id; };
  const meta = {
    title: 'Grand tour of Europe', description: sentence(10, 20), start, end, currency: 'EUR', tags: ['rail', 'summer'],
    settings: { splitCosts: true, perPersonPacking: true, bagTracking: true },
  };

  const cats = CATS.map(([name, icon], index) => add('cat', { name, color: (index % 8) + 1, icon }));
  const dayOrders = orderKeys(LARGE.days);
  const days = dayOrders.map((order, index) => add('day', { order, date: addDays(start, index), ...(index % 7 === 0 ? { title: `Week ${index / 7 + 1}` } : {}) }));
  const cityOf = (dayIndex) => CITIES[Math.min(CITIES.length - 1, Math.floor(dayIndex / (LARGE.days / CITIES.length)))];
  const places = [];
  for (let index = 0; index < LARGE.places; index++) {
    const [city, lat, lng, cc, tz] = CITIES[index % CITIES.length];
    const place = {
      name: `${pick(KINDS)} ${city} ${Math.floor(index / CITIES.length) + 1}`, address: `${int(1, 200)} ${pick(WORDS)} street, ${city}`,
      lat: Math.round((lat + (random() - 0.5) * 0.12) * 1e5) / 1e5, lng: Math.round((lng + (random() - 0.5) * 0.16) * 1e5) / 1e5, tz, cc,
      cat: cats[index % cats.length],
    };
    if (random() < 0.3) place.notes = sentence(5, 25);
    if (random() < 0.2) place.rating = { [people[0]]: int(1, 5) };
    if (random() < 0.1) place.web = `https://example.com/${city.toLowerCase()}/${index}`;
    places.push({ id: add('place', place), city, dayHint: CITIES.findIndex(([name]) => name === city) });
  }
  const bags = Array.from({ length: 6 }, (_, index) => add('bag', { name: `Bag ${index + 1}`, color: index + 1, order: orderKeys(6)[index], people: [people[index]] }));
  for (const [index, name] of LISTS.entries()) add('listMeta', { kind: 'pack', name, order: orderKeys(LISTS.length)[index], color: (index % 8) + 1 });

  // About ten visits a day, each at a place in that day's city.
  const byCity = new Map();
  for (const place of places) { if (!byCity.has(place.city)) byCity.set(place.city, []); byCity.get(place.city).push(place.id); }
  const perDay = Math.floor(LARGE.visits / LARGE.days);
  days.forEach((dayId, dayIndex) => {
    const pool = byCity.get(cityOf(dayIndex)[0]);
    const orders = orderKeys(perDay);
    for (let n = 0; n < perDay; n++) {
      const visit = { dayId, placeId: pool[(dayIndex * perDay + n) % pool.length], order: orders[n] };
      if (n < 6) { visit.start = time(32 + n * 4, 33 + n * 4); visit.dwell = int(2, 6) * 15; }
      if (random() < 0.15) visit.notes = sentence(4, 14);
      add('visit', visit);
    }
  });
  for (let index = 0; index < LARGE.days; index += 3) add('dayNote', { dayId: days[index], order: 'V', title: sentence(2, 4), text: sentence(5, 20), icon: 'info' });

  const resTypes = ['flight', 'train', 'lodging', 'restaurant', 'event', 'tour', 'car', 'bus'];
  for (let index = 0; index < LARGE.bookings; index++) {
    const type = resTypes[index % resTypes.length];
    const dayIndex = Math.floor((index * LARGE.days) / LARGE.bookings);
    const date = addDays(start, dayIndex);
    const [city, lat, lng, , tz] = cityOf(dayIndex);
    const res = { type, title: `${type[0].toUpperCase()}${type.slice(1)} ${city} ${index + 1}`, status: index % 13 === 0 ? 'pending' : 'confirmed', code: `R${String(index).padStart(5, '0')}`,
      start: { date, time: time(28, 80), tz }, people: people.slice(0, int(2, people.length)) };
    if (type === 'flight' || type === 'train' || type === 'bus') {
      const [nextCity, nextLat, nextLng, , nextTz] = cityOf(Math.min(LARGE.days - 1, dayIndex + 3));
      res.legs = [{ from: { name: city, lat, lng, tz }, to: { name: nextCity, lat: nextLat, lng: nextLng, tz: nextTz }, dep: { date, time: '09:15' }, arr: { date, time: '12:40' },
        carrier: type === 'flight' ? 'TP' : 'RX', number: String(100 + index) }];
    } else if (type === 'lodging') {
      res.end = { date: addDays(start, Math.min(LARGE.days - 1, dayIndex + 3)), time: '11:00', tz };
      res.stay = { checkInFrom: '15:00', checkOut: '11:00', fromDayId: days[dayIndex], toDayId: days[Math.min(LARGE.days - 1, dayIndex + 3)] };
      res.location = { name: `Hotel ${city}`, lat, lng };
    } else res.location = { name: city, lat, lng };
    add('res', res);
  }

  const expCats = ['food', 'transport', 'lodging', 'activities', 'shopping', 'other'];
  for (let index = 0; index < LARGE.expenses; index++) {
    const amount = int(300, 60_000);
    const payer = pick(people);
    const foreign = index % 10 === 0;
    add('exp', { name: `${pick(KINDS)} ${index + 1}`, amount, currency: foreign ? 'CHF' : 'EUR', ...(foreign ? { rate: '1.05' } : {}),
      date: addDays(start, index % LARGE.days), cat: pick(expCats), payers: [{ who: payer, amount }],
      split: { mode: 'equal', parts: people.slice(0, int(2, people.length)).map((who) => ({ who })) } });
  }

  const packOrders = orderKeys(LARGE.packing);
  for (let index = 0; index < LARGE.packing; index++) {
    const item = { name: `${pick(WORDS)} item ${index + 1}`, list: LISTS[index % LISTS.length], order: packOrders[index], qty: int(1, 4), grams: int(20, 1500) };
    if (random() < 0.5) item.bagId = pick(bags);
    if (random() < 0.3) item.doneBy = { [people[0]]: true };
    add('pack', item);
  }
  const todoOrders = orderKeys(40);
  for (let index = 0; index < 40; index++) add('todo', { name: sentence(2, 6), list: pick(['Before', 'On the road']), order: todoOrders[index], done: random() < 0.4, prio: int(1, 3) });
  for (let index = 0; index < 20; index++) add('note', { title: sentence(2, 4), body: `${sentence(10, 40)}\n\n${sentence(10, 40)}` });
  for (let index = 0; index < 10; index++) add('link', { title: sentence(2, 4), url: `https://example.org/${index}` });

  const messages = [];
  for (let index = 0; index < LARGE.messages; index++) {
    const author = people[index % people.length];
    const put = { text: sentence(3, 24), author };
    if (index > 10 && random() < 0.1) put.reply = messages[index - int(1, 10)].id;
    if (random() < 0.15) put.react = { [pick(EMOJI)]: { [author]: 1 } };
    messages.push({ author, id: makeId(), put });
  }

  const files = [];
  for (let index = 0; index < LARGE.files; index++) {
    const photo = index % 4 !== 3;
    files.push({ id: makeId(), put: {
      name: photo ? `IMG_${String(4000 + index)}.jpg` : `ticket-${index}.pdf`, mime: photo ? 'image/jpeg' : 'application/pdf', size: int(40_000, 4_000_000),
      sha256: Array.from({ length: 64 }, () => '0123456789abcdef'[int(0, 15)]).join(''), kind: 'user', loc: { mode: 'proxied' }, ...(index % 9 === 0 ? { star: true } : {}),
    } });
  }
  return { space: makeId(), meta, ops, messages, files, epoch };
}

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));

/**
 * Seeds `largeTrip()` through the real worker. File entities are worker-only and need uploaded bytes, so they go
 * straight into the owner's KV at `rev` 0 (outside the change log). `callers[username] = (op, input) => response`;
 * `writeOwnerKv(items)` is a batched `kv.set` in the owner's app namespace.
 */
export async function seedLargeTrip({ callers, writeOwnerKv, fixture = largeTrip(), members = FIXTURE_MEMBERS, onProgress = () => {} }) {
  const { space, meta } = fixture;
  const owner = callers[members[0].username];
  await owner('space.create', { kind: 'trip', meta, space });
  const { token } = await owner('invite.create', { space, role: 'editor', max: members.length });
  for (const member of members.slice(1)) await callers[member.username]('join', { space, token });
  let opId = 0;
  const nextOp = () => `0000${String(++opId).padStart(12, '0')}`;
  let rev = 0;
  const batches = chunk(fixture.ops, 200);
  for (const [index, ops] of batches.entries()) {
    ({ rev } = await owner('commit', { space, ops: ops.map((op) => ({ opId: nextOp(), ...op })) }));
    onProgress({ step: 'entities', done: index + 1, of: batches.length });
  }
  for (const member of members) {
    const own = fixture.messages.filter((message) => message.author === member.uuid);
    for (const ops of chunk(own, 200)) ({ rev } = await callers[member.username]('commit', { space, ops: ops.map(({ id, put }) => ({ opId: nextOp(), t: 'msg', id, put })) }));
    onProgress({ step: 'messages', member: member.username });
  }
  const at = fixture.epoch;
  const stamp = (n) => `${(at + n).toString(36).padStart(10, '0')}:000000:0000000000000000`;
  await writeOwnerKv(fixture.files.map(({ id, put }, index) => ({
    key: `shared:${space}:e:file:${id}`, value: { ...put, id, v: stamp(index), rev: 0, upd: at, by: members[0].uuid, cr: at },
  })));
  onProgress({ step: 'files' });
  return { space, rev };
}
