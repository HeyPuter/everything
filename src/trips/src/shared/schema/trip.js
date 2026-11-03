import { s } from './dsl.js';
import * as f from './fields.js';
import { isWeight, splitAmount, validatePayers } from '../money.js';
import { daysBetween } from '../dates.js';
import { isId, isUuid } from '../ids.js';

const o = s.optional;
const bool = s.boolean();
const nullableId = s.nullable(f.id);
const workerName = s.string(16, { pattern: /^trips-[a-z0-9]{10}$/ });
const bookingTypes = ['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport', 'lodging', 'restaurant', 'event', 'tour', 'parking', 'other'];
export const DAY_NOTE_ICONS = Object.freeze(['sticky-note', 'sun', 'moon', 'clock', 'coffee', 'utensils', 'bed-double', 'map-pin', 'camera', 'landmark', 'mountain', 'ticket', 'plane', 'train-front', 'bus', 'car', 'ship', 'bike', 'footprints', 'luggage', 'backpack', 'wallet', 'receipt', 'calendar-range', 'cloud-rain', 'users', 'heart', 'star', 'flag', 'info', 'circle-alert', 'circle-check']);

const avoid = s.array(s.enum('toll', 'motorway', 'ferry'), 3);
/** The id of a trip's single `rtPrefs` entity. */
export const ROAD_PREFS_ID = '00000000000000rt';

const split = s.object({
  mode: s.enum('equal', 'amounts', 'percent', 'shares', 'items'),
  parts: s.array(s.object({ who: f.person, value: o(s.union(s.number(), s.string(80))), paid: o(f.amount) }), 50, 1),
  items: o(s.array(s.object({ label: f.short, amount: f.amount, who: s.array(f.person, 50, 1) }), 1000)),
});
// An expense split across trips: each part is the share one trip carries, in the expense currency.
const across = s.object({
  group: f.id, total: f.amount,
  parts: s.array(s.object({ w: s.string(16, { pattern: /^trips-[a-z0-9]{10}$/ }), s: f.id, title: o(f.short), amount: f.amount }), 20, 2),
}, { refine: (value) => value.parts.reduce((sum, part) => sum + BigInt(part.amount), 0n) === BigInt(value.total)
  && new Set(value.parts.map((part) => part.s)).size === value.parts.length });
const endpoint = s.object({ name: o(f.short), code: o(s.string(16)), lat: o(s.number(-90, 90)), lng: o(s.number(-180, 180)), tz: o(f.tz) });
const leg = s.object({
  from: endpoint, to: endpoint,
  dep: s.object({ date: f.date, time: o(f.time) }), arr: s.object({ date: f.date, time: o(f.time) }),
  carrier: o(f.short), number: o(f.short), seat: o(f.short), cls: o(f.short), code: o(f.short), platform: o(f.short), coach: o(f.short),
  mode: o(f.short), color: o(f.color), shape: o(s.string(8192)),
});

export const tripSchemas = Object.freeze({
  meta: s.object({
    title: f.name, description: o(f.text), start: o(s.nullable(f.date)), end: o(s.nullable(f.date)), dayCount: o(s.integer(1, 999)), currency: f.currency,
    cover: o(f.cover), tags: o(f.tags), archived: o(bool), reminderDays: o(s.array(s.integer(0, 365), 50)),
    settings: o(s.object({
      splitCosts: o(bool), perPersonPacking: o(bool), bagTracking: o(bool),
      addons: o(s.object({ lists: o(bool), costs: o(bool), files: o(bool), collab: o(bool), roadtrip: o(bool) })),
      weekStart: o(s.integer(0, 6)), homeTz: o(f.tz),
    })),
    share: o(s.object({
      on: o(bool), exp: o(s.nullable(f.nonnegative)), plan: o(bool), map: o(bool), bookings: o(bool), codes: o(bool), packing: o(bool), costs: o(bool),
      chat: o(bool), files: o(bool), cur: o(s.nullable(f.currency)), since: o(f.nonnegative), road: o(bool), journey: o(bool),
    })),
    perms: o(f.permissions),
    // Worker-only: an ownership transfer in progress, and where a moved trip lives now.
    transfer: o(s.object({
      to: f.uid, name: o(f.name), by: f.uid, at: f.nonnegative, exp: f.nonnegative, state: s.enum('offered', 'moving'), worker: o(workerName),
    })),
    movedTo: o(s.object({ w: workerName, s: f.id, at: f.nonnegative, name: o(f.name) })),
  }, { refine: (value) => !value.start || !value.end || (daysBetween(value.start, value.end) >= 0 && daysBetween(value.start, value.end) < 999) }),
  member: s.object({ name: f.name, role: f.role, color: o(f.color), avatar: o(f.web) }),
  day: s.object({ order: f.order, date: s.nullable(f.date), title: o(f.short), notes: o(f.text), mode: o(f.transport), color: o(s.integer(1, 8)) }),
  place: s.object(f.placeFields, { refine: (value) => Object.hasOwn(value, 'lat') === Object.hasOwn(value, 'lng') }),
  visit: s.object({
    dayId: f.id, placeId: s.nullable(f.id), order: f.order,
    start: o(f.time), end: o(f.time), dwell: o(s.integer(0, 10080)), endDayId: o(f.id), pinned: o(bool),
    title: o(f.name), notes: o(f.text), legMode: o(f.transport), inMode: o(f.transport), people: o(f.people), stayId: o(f.id), alt: o(f.id),
  }, { refine: (value) => value.placeId !== null || Boolean(value.title?.trim()) }),
  dayNote: s.object({ dayId: f.id, order: f.order, title: f.name, text: o(f.text), time: o(f.time), icon: o(s.enum(...DAY_NOTE_ICONS)), color: o(f.color) }),
  res: s.object({
    type: s.enum(...bookingTypes), title: f.name, status: s.enum('pending', 'confirmed', 'cancelled'), code: o(f.short),
    start: o(f.localDateTime), end: o(f.localDateTime), location: o(f.point), placeId: o(nullableId), visitId: o(nullableId), stayId: o(nullableId),
    url: o(f.web), notes: o(f.text), people: o(f.people), legs: o(s.array(leg, 100)),
    stay: o(s.object({ checkInFrom: o(f.time), checkInUntil: o(f.time), checkOut: o(f.time), fromDayId: o(f.id), toDayId: o(f.id) })),
    dayPos: o(s.record(f.order, isId, 1000)), review: o(bool),
    src: o(s.object({ kind: s.enum('manual', 'ai', 'pkpass', 'airtrail'), ext: o(f.short), hash: o(s.string(128)) })),
  }),
  exp: s.object({
    name: f.name, amount: f.amount, currency: f.currency, rate: o(f.rate), date: o(s.nullable(f.date)), order: o(f.order),
    cat: o(f.short), note: o(f.text), payers: s.array(s.object({ who: f.person, amount: f.amount }), 50), split, links: o(f.links),
    due: o(s.nullable(f.date)), across: o(across),
  }, { refine: (value) => {
    try { validatePayers(value.amount, value.payers, { partial: Boolean(value.due) }); splitAmount(value.amount, value.split); return true; } catch { return false; }
  } }),
  settle: s.object({ from: f.person, to: f.person, amount: s.integer(1), currency: f.currency, rate: o(f.rate), date: o(s.nullable(f.date)), note: o(f.text) }, { refine: (value) => value.from !== value.to }),
  splitPreset: s.object({ name: f.name, weights: s.record(s.custom(isWeight, 'weight'), (key) => isId(key) || isUuid(key), 50) }, { refine: (value) => Object.values(value.weights).some((weight) => Number(weight) > 0) }),
  costCat: s.object({ cat: f.short, order: f.order }),
  budget: s.object({ cat: o(f.short), amount: f.nonnegative, note: o(f.text) }),
  pack: s.object({
    name: f.name, qty: o(s.number(0, 1_000_000)), list: o(f.short), order: f.order,
    done: o(bool), doneBy: o(f.perUser(bool)), grams: o(s.number(0, 1_000_000_000)), bagId: o(nullableId),
    vis: o(s.enum('shared', 'people')), for: o(f.people), owner: o(f.person), bring: o(f.perUser(s.enum('yes', 'maybe'))),
  }),
  bag: s.object({ name: f.name, color: o(f.color), limitGrams: o(s.number(0, 1_000_000_000)), people: o(f.people), order: f.order }),
  todo: s.object({ name: f.name, list: o(f.short), order: f.order, done: o(bool), due: o(s.nullable(f.date)), desc: o(f.text), who: o(s.nullable(f.person)), prio: o(s.integer(1, 3)) }),
  listMeta: s.object({ kind: s.enum('pack', 'todo', 'note'), name: f.name, color: o(f.color), order: f.order, assignees: o(f.people) }),
  note: s.object({ title: f.name, body: o(f.text), cat: o(f.short), color: o(f.color), pinned: o(bool), web: o(f.web), author: o(f.uid) }),
  link: s.object({ title: f.name, url: f.web, pinned: o(bool), author: o(f.uid) }),
  poll: s.object({ question: f.name, options: s.array(f.name, 50, 2), multi: o(bool), deadline: o(s.nullable(f.nonnegative)), closed: o(bool), votes: o(f.perUser(s.array(s.integer(0, 49), 50))), author: o(f.uid) }, {
    refine: (value) => Object.values(value.votes ?? {}).every((votes) => votes.every((index) => index < value.options.length)
      && new Set(votes).size === votes.length && (value.multi || votes.length <= 1)),
  }),
  msg: s.object({ text: s.string(4000), reply: o(nullableId), react: o(s.record(f.perUser(s.literal(1)), (key) => key.length <= 32, 50)), deleted: o(bool), author: o(f.uid) }, {
    refine: (value) => value.deleted ? value.text === '' && Object.keys(value.react ?? {}).length === 0 : Boolean(value.text.trim()),
  }),
  file: s.object({
    name: f.name, mime: s.string(255, { pattern: /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/ }), size: s.integer(0, 2 ** 40),
    sha256: s.string(64, { pattern: /^[0-9a-f]{64}$/ }), kind: s.enum('user', 'track', 'book', 'photo'),
    loc: s.object({ mode: s.enum('direct', 'proxied'), uid: o(f.uid) }), thumb: o(f.id), desc: o(f.text), star: o(bool), trashed: o(s.nullable(f.nonnegative)), links: o(f.links), linked: o(f.linkSet),
    taken: o(s.object({ date: f.date, time: o(f.time) })), geo: o(s.object({ lat: s.number(-90, 90), lng: s.number(-180, 180) })),
  }),
  cat: s.object({ name: f.name, color: f.color, icon: f.icon }),
  guest: s.object({ name: f.name, color: o(f.color) }),
  // An alternative plan for one day (`dayId`) or the whole trip; visits with `alt` set to its id belong to it.
  alt: s.object({ name: f.name, order: f.order, dayId: o(f.id), color: o(s.integer(1, 8)), notes: o(f.text) }),
  via: s.object({ dayId: f.id, after: f.id, order: f.order, lat: s.number(-90, 90), lng: s.number(-180, 180) }),
  dayEnd: s.object({ day: f.id, fromVisit: f.id, toVisit: f.id, fraction: s.number(0, 1) }),
  dayTrack: s.object({ dayId: f.id, placeId: f.id, strayKm: s.number(0, 1000) }),
  rtPrefs: s.object({
    fuel: o(s.enum('petrol', 'electric', 'either')), range: o(s.number(10, 3000)), tank: o(s.number(1, 500)), use: o(s.number(0.5, 100)),
    battery: o(s.number(1, 500)), degrade: o(s.integer(0, 60)), fill: o(s.integer(10, 100)), reserve: o(s.integer(0, 50)),
    price: o(s.string(16, { pattern: /^\d{1,6}(?:\.\d{1,6})?$/ })), currency: o(f.currency),
    start: o(f.time), end: o(f.time), stint: o(s.integer(15, 720)), daily: o(s.integer(30, 1440)), pause: o(s.integer(0, 240)),
    avoid: o(avoid), dayAvoid: o(s.record(avoid, isId, 1000)), corridor: o(s.integer(1, 50)), showStops: o(bool),
  }),
});
