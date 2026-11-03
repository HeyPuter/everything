// What the assistant may read about a trip, as plain data for the model. Every view is built field by field, so
// nothing reaches the model unless it is listed here. Left out: other members' per-user values (tags, visited,
// checks, pledges), anything private but the viewer's own private items, confirmation codes, seats, booking notes
// and links, chat, and member ids.
import { buildTimeline } from '../../timeline/index.js';
import { computeBalances, spendOf, summary as costSummary } from '../../costs/ledger.js';
import { fromMinor } from '../../../shared/money.js';
import { isDate, isTime } from '../../../shared/dates.js';

// Control, zero-width, bidi-override and line-separator characters.
const span = ([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const CONTROL = new RegExp(`[${[[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(span).join('')}]+`, 'g');
const pad =(value) => String(value).padStart(2, '0');
const weekday = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' });

/** One line of untrusted text: control and bidi characters removed, whitespace collapsed, at most `max` chars. */
export function clip(value, max = 120) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Drops undefined, null, empty strings and empty arrays so the model reads fewer tokens. */
export function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '' && !(Array.isArray(item) && !item.length)));
}
export const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const coord = (value) => (Number.isFinite(value) ? Number(value.toFixed(4)) : undefined);
const located = (entity) => Number.isFinite(entity?.lat) && Number.isFinite(entity?.lng);
const normal = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').trim();
const median = (values) => { const sorted = [...values].sort((x, y) => x - y); return sorted[Math.floor(sorted.length / 2)]; };
const stamp = (point) => (point?.date ? [point.date, isTime(point.time) ? point.time : null, point.tz].filter(Boolean).join(' ') : undefined);
const page = (list, offset = 0, limit = 50) => ({ total: list.length, items: list.slice(offset, offset + limit), ...(offset + limit < list.length ? { more: list.length - offset - limit, next: offset + limit } : {}) });

/** A reader over one open space for the viewer `uid`. Each call reads the replica as it is now. */
export function createReader(space, { uid, now = () => new Date() }) {
  const all = (type) => space.select?.[type]?.all?.() ?? space.query?.(type) ?? [];
  const meta = () => space.get('meta', 'meta') ?? {};
  const settings = () => meta().settings ?? {};

  function person(id) {
    if (!id) return undefined;
    if (id === uid) return 'you';
    const member = (space.members?.() ?? []).find((entry) => entry.uid === id);
    if (member) return clip(member.name, 60) ?? 'a member';
    const guest = space.get('guest', id);
    return guest ? `${clip(guest.name, 60) ?? 'guest'} (guest)` : 'a former member';
  }
  const people = (list) => (Array.isArray(list) ? list.map(person).filter(Boolean) : undefined);

  function timeline() {
    return buildTimeline({ days: all('day'), visits: all('visit'), notes: all('dayNote'), reservations: all('res') });
  }
  function dayLabel(entry) {
    return compact({ id: entry.day.id, n: entry.number, date: entry.date ?? undefined, weekday: entry.date ? weekday.format(new Date(`${entry.date}T00:00:00Z`)) : undefined, title: clip(entry.day.title, 80) });
  }
  function rowName(row) {
    if (row.kind === 'visit') return clip(row.entity.placeId ? space.get('place', row.entity.placeId)?.name ?? row.entity.title : row.entity.title, 100) ?? 'untitled';
    return clip(row.entity.title, 100) ?? 'untitled';
  }
  function row(entry, { detail = false } = {}) {
    const base = { id: entry.id, kind: entry.kind === 'res' ? 'booking' : entry.kind, name: rowName(entry), time: entry.time ?? undefined, end: entry.end ?? undefined, phase: entry.phase ?? undefined };
    if (entry.kind === 'res') Object.assign(base, { type: entry.entity.type, status: entry.entity.status === 'cancelled' ? 'cancelled' : undefined });
    if (detail && entry.kind === 'visit') Object.assign(base, { place: entry.entity.placeId ?? undefined, notes: clip(entry.entity.notes, 300), movable: entry.primary || undefined });
    if (detail && entry.kind === 'note') Object.assign(base, { text: clip(entry.entity.text, 300) });
    return compact(base);
  }
  const stayNames = (entry) => entry.stays.map((stay) => compact({ name: clip(stay.res.title, 80), phase: stay.phase }));

  function packedByMe(item) {
    if (item.private) return item.done === true;
    return settings().perPersonPacking ? item.doneBy?.[uid] === true : item.done === true;
  }
  function center() {
    const spots = all('place').filter(located);
    if (!spots.length) return null;
    return { lat: median(spots.map((place) => place.lat)), lng: median(spots.map((place) => place.lng)) };
  }
  function myRating(place) { return place.rating?.[uid]; }
  function averageRating(place) {
    const values = Object.values(place.rating ?? {}).filter((value) => Number.isInteger(value));
    return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : undefined;
  }

  return {
    today: () => localDate(now()),

    summary() {
      const value = meta();
      const days = all('day');
      const places = all('place');
      const visits = all('visit');
      const scheduled = new Set(visits.map((visit) => visit.placeId).filter(Boolean));
      const bookings = {};
      for (const res of all('res')) bookings[res.type] = (bookings[res.type] ?? 0) + 1;
      const pack = space.query?.('pack', { includePrivate: true }) ?? all('pack');
      const todos = all('todo');
      const today = localDate(now());
      const status = !isDate(value.start) ? 'undated' : today < value.start ? 'upcoming' : isDate(value.end) && today > value.end ? 'past' : 'ongoing';
      const countries = {};
      for (const place of places) if (place.cc) countries[place.cc] = (countries[place.cc] ?? 0) + 1;
      const spots = places.filter(located);
      return compact({
        title: clip(value.title, 120), description: clip(value.description, 300), start: value.start ?? undefined, end: value.end ?? undefined,
        status, today, days: days.length, currency: value.currency,
        you: compact({ role: space.role ?? undefined, canEdit: compact({ plan: space.can('plan.edit') || undefined, lists: space.can('lists.edit') || undefined, bookings: space.can('res.edit') || undefined, dates: space.can('trip.edit') || undefined }) }),
        members: (space.members?.() ?? []).length || undefined, guests: all('guest').length || undefined,
        places: compact({ total: places.length, scheduled: places.filter((place) => scheduled.has(place.id)).length, notScheduled: places.filter((place) => !scheduled.has(place.id)).length }),
        visits: visits.length, bookings: Object.keys(bookings).length ? bookings : undefined,
        packing: pack.length ? { items: pack.length, packedByYou: pack.filter((item) => packedByMe(item)).length } : undefined,
        todos: todos.length ? { open: todos.filter((todo) => !todo.done).length, done: todos.filter((todo) => todo.done).length } : undefined,
        area: spots.length ? compact({
          countries: Object.entries(countries).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([cc]) => cc),
          center: { lat: coord(median(spots.map((place) => place.lat))), lng: coord(median(spots.map((place) => place.lng))) },
        }) : undefined,
      });
    },

    /** `detail`: `full` (items with ids), `brief` (count and first names) or `count`. */
    days(detail = 'full', { from = 0, limit = Infinity, items = 15 } = {}) {
      return timeline().days.slice(from, from + limit).map((entry) => {
        const label = dayLabel(entry);
        if (detail === 'count') return compact({ ...label, items: entry.rows.length });
        if (detail === 'brief') return compact({ ...label, items: entry.rows.length, first: entry.rows.slice(0, 3).map(rowName) });
        return compact({
          ...label, stay: stayNames(entry).filter((stay) => stay.phase !== 'checkout').map((stay) => stay.name),
          items: entry.rows.slice(0, items).map((item) => row(item)), more: entry.rows.length > items ? entry.rows.length - items : undefined,
        });
      });
    },

    /** Resolves a day id or a date to the day, or null. */
    findDay(ref) {
      const days = all('day');
      return days.find((day) => day.id === ref) ?? (isDate(ref) ? days.find((day) => day.date === ref) : null) ?? null;
    },

    day(dayId) {
      const entry = timeline().byDay.get(dayId);
      if (!entry) return null;
      return compact({ ...dayLabel(entry), notes: clip(entry.day.notes, 600), stays: stayNames(entry), items: entry.rows.map((item) => row(item, { detail: true })) });
    },

    places({ query, cat, notScheduled = false, offset = 0, limit = 50 } = {}) {
      const visits = all('visit');
      const dayNumber = new Map(all('day').map((day, index) => [day.id, index + 1]));
      const onDays = new Map();
      for (const visit of visits) if (visit.placeId) onDays.set(visit.placeId, [...(onDays.get(visit.placeId) ?? []), dayNumber.get(visit.dayId)].filter(Boolean));
      const needle = normal(query);
      const list = all('place')
        .filter((place) => (!needle || normal(place.name).includes(needle) || normal(place.address).includes(needle)) && (!cat || place.cat === cat) && (!notScheduled || !onDays.has(place.id)))
        .sort((x, y) => normal(x.name).localeCompare(normal(y.name)));
      const result = page(list, offset, limit);
      result.items = result.items.map((place) => compact({
        id: place.id, name: clip(place.name, 100), cat: place.cat, address: clip(place.address, 100), lat: coord(place.lat), lng: coord(place.lng),
        days: [...new Set(onDays.get(place.id) ?? [])].slice(0, 6), rating: averageRating(place), yourRating: myRating(place),
        yourTags: (place.tags?.[uid] ?? []).slice(0, 10).map((tag) => clip(tag, 40)), visitedByYou: place.visited?.[uid] || undefined, notes: clip(place.notes, 160),
      }));
      return result;
    },

    bookings({ type, offset = 0, limit = 30 } = {}) {
      const list = all('res').filter((res) => !type || res.type === type)
        .sort((x, y) => String(stamp(x.start) ?? '~').localeCompare(String(stamp(y.start) ?? '~')));
      const result = page(list, offset, limit);
      result.items = result.items.map((res) => compact({
        id: res.id, type: res.type, title: clip(res.title, 100), status: res.status, start: stamp(res.start), end: stamp(res.end),
        where: clip(res.location?.name ?? res.location?.address, 100), place: res.placeId ?? undefined,
        legs: (res.legs ?? []).slice(0, 8).map((leg) => compact({
          from: clip([leg.from?.code, leg.from?.name].filter(Boolean).join(' '), 80), to: clip([leg.to?.code, leg.to?.name].filter(Boolean).join(' '), 80),
          dep: stamp(leg.dep), arr: stamp(leg.arr), carrier: clip(leg.carrier, 60), number: clip(leg.number, 20),
        })),
        travelers: people(res.people),
      }));
      return result;
    },

    lists(kind, { list, offset = 0, limit = 100 } = {}) {
      const byOrder = (x, y) => normal(x.list).localeCompare(normal(y.list)) || String(x.order).localeCompare(String(y.order));
      const wanted = list === undefined ? null : normal(list);
      const items = (kind === 'pack' ? space.query?.('pack', { includePrivate: true }) ?? all('pack') : all('todo'))
        .filter((item) => wanted === null || normal(item.list) === wanted).sort(byOrder);
      const names = new Map();
      for (const item of items) names.set(item.list ?? '', (names.get(item.list ?? '') ?? 0) + 1);
      const result = page(items, offset, limit);
      result.lists = [...names].map(([name, count]) => compact({ name: clip(name, 80) ?? '(no list)', count }));
      if (kind === 'pack') {
        result.items = result.items.map((item) => compact({
          id: item.id, name: clip(item.name, 100), qty: item.qty, list: clip(item.list, 80), packedByYou: packedByMe(item),
          bag: item.bagId ? clip(space.get('bag', item.bagId)?.name, 60) : undefined,
          for: item.vis === 'people' ? people(item.for) : undefined, youBring: item.private ? undefined : item.bring?.[uid], private: item.private || undefined,
        }));
      } else {
        result.items = result.items.map((todo) => compact({
          id: todo.id, name: clip(todo.name, 100), list: clip(todo.list, 80), done: todo.done || undefined, due: todo.due ?? undefined, prio: todo.prio, who: person(todo.who), notes: clip(todo.desc, 200),
        }));
      }
      return result;
    },

    costs() {
      const currency = meta().currency;
      const balances = computeBalances({ expenses: all('exp'), settlements: all('settle'), tripCurrency: currency });
      const mine = costSummary(balances, uid);
      let own = [];
      try { own = space.privateItems?.('exp').list() ?? []; } catch { own = []; }
      const ownSpend = own.length ? spendOf(own, currency) : null;
      const money = (minor) => (Number.isSafeInteger(minor) ? fromMinor(minor, currency) : undefined);
      const label = (cat) => clip(space.get('cat', cat)?.name, 60) ?? cat;
      return compact({
        currency, expenses: all('exp').length, spent: money(balances.spend),
        byCategory: [...balances.byCategory].sort((x, y) => y[1] - x[1]).map(([cat, amount]) => ({ category: label(cat), amount: money(amount) })),
        you: compact({ owe: mine.owe ? money(mine.owe) : undefined, owed: mine.owed ? money(mine.owed) : undefined }),
        pendingRates: balances.pending.expenses.length || undefined,
        yourPrivateSpend: ownSpend ? money(ownSpend.total) : undefined,
      });
    },

    /** Coordinates for a day: its first located visit, else its stay, else the trip's middle. */
    dayLocation(dayId) {
      const entry = timeline().byDay.get(dayId);
      for (const item of entry?.rows ?? []) {
        if (item.kind !== 'visit' || !item.entity.placeId) continue;
        const place = space.get('place', item.entity.placeId);
        if (located(place)) return { lat: place.lat, lng: place.lng, tz: place.tz };
      }
      for (const stay of entry?.stays ?? []) if (located(stay.res.location)) return { lat: stay.res.location.lat, lng: stay.res.location.lng };
      return center();
    },
    center,
  };
}
