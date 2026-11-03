// Planning a booking move between two trips. Pure: the caller passes what both replicas hold and gets the ops for
// the target trip, the arguments of the source trip's `res.moveToTrip`, and what the user should be told.
import { DomainError } from '../../../../shared/errors.js';
import { isId, isUuid, newId } from '../../../../shared/ids.js';
import { dateRange, isDate } from '../../../../shared/dates.js';
import { orderKeys } from '../../../../shared/order.js';
import { splitAmount } from '../../../../shared/money.js';
import { validateEntity } from '../../../../shared/schema/index.js';
import { LIMITS } from '../../../../shared/limits.js';
import { isBuiltinCategory } from '../../../../lib/costs/categories.js';
import { hasLink, linkedExpenses } from '../../../../lib/res/index.js';

// Booking fields that mean the same in any trip; links to the source trip's entities are remapped or dropped.
export const RES_FIELDS = Object.freeze(['type', 'title', 'status', 'code', 'start', 'end', 'location', 'url', 'notes', 'legs', 'review', 'src']);
const STAY_TIMES = ['checkInFrom', 'checkInUntil', 'checkOut'];
const PLACE_FIELDS = ['name', 'desc', 'notes', 'address', 'lat', 'lng', 'tz', 'cc', 'admin1', 'price', 'web', 'phone', 'ids', 'src', 'stop'];
const EXP_FIELDS = ['name', 'amount', 'currency', 'date', 'order', 'note'];
const pick = (entity, fields) => Object.fromEntries(fields.filter((key) => entity?.[key] !== undefined).map((key) => [key, structuredClone(entity[key])]));
const norm = (text) => String(text ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const abs = (value) => (value < 0 ? -value : value);

/** First and last date a booking covers, or nulls. */
export function bookingDates(res) {
  const dates = [res?.start?.date, res?.end?.date, ...(res?.legs ?? []).flatMap((leg) => [leg?.dep?.date, leg?.arr?.date])].filter(isDate).sort();
  return { start: dates[0] ?? null, end: dates.at(-1) ?? null };
}

/**
 * Maps source people to the target trip: members by account uuid, guests by name. Returns `(who) => id|null`.
 */
export function personMapper({ sourceGuests = [], targetMembers = [], targetGuests = [] }) {
  const members = new Set(targetMembers);
  const guestNames = new Map(sourceGuests.map((guest) => [guest.id, norm(guest.name)]));
  const byName = new Map();
  for (const guest of targetGuests) if (!byName.has(norm(guest.name))) byName.set(norm(guest.name), guest.id);
  return (who) => {
    if (isUuid(who)) return members.has(who) ? who : null;
    const name = guestNames.get(who);
    return name ? byName.get(name) ?? null : null;
  };
}

/** A target place equal to `place`: same OSM id, or the same name within about 50 m (or with the same address). */
export function findSamePlace(place, candidates) {
  if (!place) return null;
  const osm = place.ids?.osm;
  if (osm) { const hit = candidates.find((item) => item.ids?.osm === osm); if (hit) return hit; }
  const name = norm(place.name);
  return candidates.find((item) => {
    if (norm(item.name) !== name) return false;
    if (Number.isFinite(place.lat) && Number.isFinite(item.lat)) return abs(place.lat - item.lat) < 0.0005 && abs(place.lng - item.lng) < 0.0005;
    return !Number.isFinite(place.lat) && !Number.isFinite(item.lat) && norm(place.address) === norm(item.address);
  }) ?? null;
}

/** Place fields worth copying; trip category ids, file images and per-member values stay behind. */
export function placeCopy(place) {
  const fields = pick(place, PLACE_FIELDS);
  if (typeof place.cat === 'string' && !isId(place.cat)) fields.cat = place.cat;
  if (place.img?.url) fields.img = structuredClone(place.img);
  return fields;
}

/**
 * An expense as it would be stored in the target trip, or `{reason}` when it cannot move: `links` (it also belongs
 * to other entities) or `people` (someone on it is not in the target trip). The rate is relative to the trip
 * currency, so it is kept only when both trips share one and becomes pending otherwise.
 */
export function expenseCopy(exp, { from, resId, id, mapPerson, sourceCurrency, targetCurrency }) {
  if (exp.links?.length !== 1 || !hasLink(exp, 'res', from)) return { reason: 'links' };
  const map = (who) => mapPerson(who);
  const people = [...exp.payers.map((payer) => payer.who), ...exp.split.parts.map((part) => part.who), ...(exp.split.items ?? []).flatMap((item) => item.who)];
  if (people.some((who) => !map(who))) return { reason: 'people' };
  const fields = pick(exp, EXP_FIELDS);
  fields.cat = isBuiltinCategory(exp.cat) ? exp.cat : 'other';
  if (exp.currency !== targetCurrency) {
    if (sourceCurrency === targetCurrency && exp.rate !== undefined) fields.rate = exp.rate;
    else fields.rate = null;
  }
  fields.payers = exp.payers.map((payer) => ({ who: map(payer.who), amount: payer.amount }));
  const split = { mode: exp.split.mode, parts: exp.split.parts.map((part) => ({ ...structuredClone(part), who: map(part.who) })) };
  if (exp.split.items) split.items = exp.split.items.map((item) => ({ ...structuredClone(item), who: item.who.map(map) }));
  // Equal splits rotate leftover minor units by expense id, so a paid-back share is re-fitted to the new id.
  let shares = null;
  try { shares = splitAmount(exp.amount, split, { expenseId: id }); } catch { return { reason: 'invalid' }; }
  split.parts = split.parts.map((part, index) => {
    if (!part.paid) return part;
    const share = shares[index].amount;
    const { paid, ...rest } = part;
    if (share === 0 || (share < 0) !== (paid < 0)) return rest;
    return { ...rest, paid: abs(paid) > abs(share) ? share : paid };
  });
  fields.split = split;
  fields.links = [{ t: 'res', id: resId }];
  try { validateEntity('trip', 'exp', fields); } catch { return { reason: 'invalid' }; }
  return { fields };
}

/**
 * `source`: `{currency, files, exps, privateExps (the mover's own), visits, reservations, places, guests, days, can}`;
 * `target`: `{currency, members (uuids), guests, places, days, can, newDays?}`, `newDays` being dates to lay out first
 * in a trip without days; `options`: `{copyFiles, moveExpenses}`. In the result, `created` lists what an undo deletes
 * from the target (the copied place last); `privateExps` are `{from, id, fields}` (moved) or `{from, links}` (stays,
 * unlinked).
 */
export function planMove({ res, base = res?.v, source, target, options = {}, makeId = newId }) {
  if (!res) throw new DomainError('gone', 409);
  const resId = makeId();
  const mapPerson = personMapper({ sourceGuests: source.guests, targetMembers: target.members, targetGuests: target.guests });
  const days = (target.newDays ?? []).length ? (() => {
    const keys = orderKeys(target.newDays.length);
    return target.newDays.map((date, index) => ({ id: makeId(), date, order: keys[index] }));
  })() : [];
  const targetDays = [...(target.days ?? []), ...days];
  const dayByDate = new Map();
  for (const day of targetDays) if (isDate(day.date) && !dayByDate.has(day.date)) dayByDate.set(day.date, day.id);
  const sourceDate = new Map((source.days ?? []).map((day) => [day.id, day.date]));
  const remapDay = (dayId) => dayByDate.get(sourceDate.get(dayId)) ?? null;

  const fields = pick(res, RES_FIELDS);
  const notes = [];
  if (res.stay) {
    const stay = pick(res.stay, STAY_TIMES);
    const from = res.stay.fromDayId ? remapDay(res.stay.fromDayId) : null;
    const to = res.stay.toDayId ? remapDay(res.stay.toDayId) : null;
    if (from) { stay.fromDayId = from; if (to) stay.toDayId = to; }
    fields.stay = stay;
  }
  if (res.dayPos) {
    const dayPos = {};
    for (const [dayId, order] of Object.entries(res.dayPos)) { const mapped = remapDay(dayId); if (mapped && !dayPos[mapped]) dayPos[mapped] = order; }
    if (Object.keys(dayPos).length) fields.dayPos = dayPos;
  }
  const dropped = [];
  if (res.people?.length) {
    const people = [];
    for (const who of res.people) { const mapped = mapPerson(who); if (mapped && !people.includes(mapped)) people.push(mapped); else if (!mapped) dropped.push(who); }
    if (people.length) fields.people = people;
  }

  let place = null;
  const sourcePlace = res.placeId ? (source.places ?? []).find((item) => item.id === res.placeId) : null;
  if (sourcePlace) {
    const same = findSamePlace(sourcePlace, target.places ?? []);
    if (same) place = { id: same.id, name: same.name, reused: true };
    else if (target.can('plan.edit')) place = { id: makeId(), name: sourcePlace.name, reused: false, fields: placeCopy(sourcePlace) };
    else notes.push('place_skipped');
    if (place) fields.placeId = place.id;
  }
  try { validateEntity('trip', 'res', fields); } catch { throw new DomainError('invalid_booking', 400); }

  const linked = linkedExpenses(source.exps ?? [], res.id);
  const expenses = [];
  const staying = [];
  const blocked = [];
  const canMoveCosts = options.moveExpenses && source.can('costs.edit') && target.can('costs.edit');
  for (const exp of linked) {
    if (!canMoveCosts) { staying.push(exp.id); continue; }
    const id = makeId();
    const copy = expenseCopy(exp, { from: res.id, resId, id, mapPerson, sourceCurrency: source.currency, targetCurrency: target.currency });
    if (copy.fields) expenses.push({ from: exp.id, id, fields: copy.fields });
    else { staying.push(exp.id); blocked.push({ id: exp.id, reason: copy.reason }); }
  }

  const files = options.copyFiles && target.can('files.upload')
    ? (source.files ?? []).filter((file) => file.kind === 'user' && !file.trashed && hasLink(file, 'res', res.id)).map((file) => ({ id: file.id, name: file.name, mime: file.mime, size: file.size }))
    : [];

  const op = (t, id, put) => ({ opId: makeId(), t, id, put });
  const targetOps = [
    ...days.map((day) => op('day', day.id, { date: day.date, order: day.order })),
    ...(place && !place.reused ? [op('place', place.id, place.fields)] : []),
    op('res', resId, fields),
    ...expenses.map((exp) => op('exp', exp.id, exp.fields)),
  ];
  if (targetOps.length > LIMITS.commitWrites) throw new DomainError('move_too_large', 413);
  const sourceArgs = {
    res: res.id,
    ...(base ? { base } : {}),
    files: (source.files ?? []).filter((file) => hasLink(file, 'res', res.id)).map((file) => file.id),
    exps: linked.map((exp) => exp.id),
    moved: expenses.map((exp) => exp.from),
    visits: res.type === 'lodging' ? (source.visits ?? []).filter((visit) => visit.stayId === res.id).map((visit) => visit.id) : [],
    stays: res.type === 'lodging' ? (source.reservations ?? []).filter((item) => item.id !== res.id && item.stayId === res.id).map((item) => item.id) : [],
  };
  for (const key of ['files', 'exps', 'moved', 'visits', 'stays']) if (!sourceArgs[key].length) delete sourceArgs[key];
  const created = [...expenses.map((exp) => ({ t: 'exp', id: exp.id })), { t: 'res', id: resId }, ...(place && !place.reused ? [{ t: 'place', id: place.id }] : [])];
  const privateExps = linkedExpenses(source.privateExps ?? [], res.id).map((exp) => {
    const id = makeId();
    const copy = options.moveExpenses ? expenseCopy(exp, { from: res.id, resId, id, mapPerson, sourceCurrency: source.currency, targetCurrency: target.currency }) : {};
    if (copy.fields) return { from: exp.id, id, fields: copy.fields };
    return { from: exp.id, links: exp.links.filter((link) => !(link.t === 'res' && link.id === res.id)).map((link) => ({ t: link.t, id: link.id })) };
  });
  return { resId, fields, place, days, expenses, staying, blocked, files, dropped, targetOps, created, sourceArgs, privateExps, notes };
}

/** Dates for laying out a new trip around a booking (at most the trip length limit), or an empty list. */
export function newTripDates(res) {
  const { start, end } = bookingDates(res);
  return start ? dateRange(start, end ?? start, LIMITS.tripDays) : [];
}

/** A patch bringing a copy up to a newer source version; remapped links (place, people, days) stay as they are. */
export function refreshPatch(copy, latest) {
  const set = {};
  const unset = [];
  for (const key of RES_FIELDS) {
    if (latest[key] === undefined) { if (copy?.[key] !== undefined) unset.push(key); }
    else set[key] = structuredClone(latest[key]);
  }
  if (latest.stay) set.stay = { ...pick(latest.stay, STAY_TIMES), ...pick(copy?.stay, ['fromDayId', 'toDayId']) };
  return { set, unset };
}
