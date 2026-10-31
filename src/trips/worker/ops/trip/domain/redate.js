// `trip.redate`: new start/end or day count, laying the days out again in one change.
// `planRedate` is pure and shared with the client's redate adapter and impact preview.
import { invariant } from '../../../../src/shared/errors.js';
import { addDays, dateRange, daysBetween, isDate } from '../../../../src/shared/dates.js';
import { isId } from '../../../../src/shared/ids.js';
import { LIMITS } from '../../../../src/shared/limits.js';
import { orderKeys } from '../../../../src/shared/order.js';
import { plainObject } from '../../../../src/shared/schema/dsl.js';
import { shiftPatch, stayDaysPatch } from '../../../../src/lib/res/shift.js';
import { isLodging } from '../../../../src/lib/res/types.js';

const ARG_KEYS = ['start', 'end', 'dayCount', 'bookings', 'days', 'visits', 'notes', 'res', 'newIds'];
const MAX_READS = 900;
const dated = (value) => isDate(value?.start) && isDate(value?.end);
const byOrder = (a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order < b.order ? -1 : 1);
const shiftDate = (date, delta) => (isDate(date) && delta ? addDays(date, delta) : date);

/** Target day count: the date range length for dated trips, else `dayCount`. */
export function targetDays(target) {
  return dated(target) ? daysBetween(target.start, target.end) + 1 : target.dayCount ?? 7;
}

/** Final day list: kept days with their new dates, removed days, and dates or slots needing new days. */
function layout(meta, days, target) {
  const sorted = [...days].sort(byOrder);
  const removed = new Set();
  const next = new Map();
  const wasDated = dated(meta);
  if (dated(target)) {
    const range = dateRange(target.start, target.end);
    const inRange = new Set(range);
    const pureShift = wasDated && target.start !== meta.start && daysBetween(meta.start, meta.end) === daysBetween(target.start, target.end);
    const delta = pureShift ? daysBetween(meta.start, target.start) : 0;
    const undated = sorted.filter((day) => day.date == null);
    const taken = new Set();
    for (const day of sorted) {
      if (day.date == null) continue;
      const date = shiftDate(day.date, delta);
      if (inRange.has(date) && !taken.has(date)) { next.set(day.id, date); taken.add(date); } else removed.add(day.id);
    }
    // Undated days of an undated trip take the free dates in order; in a dated trip they stay undated.
    const free = range.filter((date) => !taken.has(date));
    for (const day of undated) {
      if (wasDated) next.set(day.id, null);
      else if (free.length) next.set(day.id, free.shift());
      else removed.add(day.id);
    }
    return { next, removed, create: free, delta };
  }
  const count = targetDays(target);
  const ordered = [...sorted].sort((a, b) => (a.date ?? '￿').localeCompare(b.date ?? '￿') || byOrder(a, b));
  ordered.forEach((day, index) => { if (index < count) next.set(day.id, null); else removed.add(day.id); });
  return { next, removed, create: Array.from({ length: Math.max(0, count - next.size) }, () => null), delta: 0 };
}

/** Keeps existing order keys that are still increasing; gives the rest new keys between their neighbours. */
function orders(final) {
  const keep = new Array(final.length).fill(false);
  let previous = null;
  final.forEach((item, index) => {
    if (item.order && (previous === null || item.order > previous)) { keep[index] = true; previous = item.order; }
  });
  const result = final.map((item, index) => (keep[index] ? item.order : null));
  for (let index = 0; index < final.length;) {
    if (result[index] !== null) { index += 1; continue; }
    let end = index;
    while (end < final.length && result[end] === null) end += 1;
    const left = index > 0 ? result[index - 1] : null;
    const right = end < final.length ? result[end] : null;
    const keys = orderKeys(end - index, left, right);
    for (let i = index; i < end; i++) result[i] = keys[i - index];
    index = end;
  }
  return result;
}

/**
 * Plans a re-date. Inputs are plain entities; `target` is `{start, end, dayCount}`, `bookings` is `keep|shift`.
 * Returns `{writes, impact}`; `writes` are `{t, id, put|set|unset|del}` and need `newIds.length >= impact.created`.
 */
export function planRedate({ meta, days = [], visits = [], notes = [], res = [], target, bookings = 'keep', newIds = [] }) {
  invariant(meta, 'gone', 409);
  const { next, removed, create, delta } = layout(meta, days, target);
  invariant(newIds.length >= create.length, 'invalid_args');
  const oldDate = new Map(days.map((day) => [day.id, day.date ?? null]));
  // Kept days (dated by new date, then undated by order) followed by the new ones in their slots.
  const kept = days.filter((day) => next.has(day.id)).map((day) => ({ id: day.id, date: next.get(day.id), order: day.order, existing: day }));
  const fresh = create.map((date, index) => ({ id: newIds[index], date, order: null }));
  const all = [...kept, ...fresh];
  const datedDays = all.filter((day) => day.date).sort((a, b) => a.date.localeCompare(b.date));
  const undatedDays = all.filter((day) => !day.date).sort((a, b) => (a.order && b.order ? byOrder(a, b) : a.order ? -1 : b.order ? 1 : 0));
  const final = [...datedDays, ...undatedDays];
  const keys = orders(final);

  const writes = [];
  const metaSet = {};
  if (dated(target)) {
    if (meta.start !== target.start) metaSet.start = target.start;
    if (meta.end !== target.end) metaSet.end = target.end;
  } else {
    if ((meta.start ?? null) !== (target.start ?? null)) metaSet.start = target.start ?? null;
    if ((meta.end ?? null) !== (target.end ?? null)) metaSet.end = target.end ?? null;
    if (meta.dayCount !== targetDays(target)) metaSet.dayCount = targetDays(target);
  }
  if (Object.keys(metaSet).length) writes.push({ t: 'meta', id: 'meta', set: metaSet });

  const byNewDate = new Map(final.filter((day) => day.date).map((day) => [day.date, day.id]));
  let moved = 0;
  final.forEach((day, index) => {
    if (!day.existing) { writes.push({ t: 'day', id: day.id, put: { date: day.date, order: keys[index] } }); return; }
    const set = {};
    if ((day.existing.date ?? null) !== day.date) set.date = day.date;
    if (day.existing.order !== keys[index]) set.order = keys[index];
    if (Object.keys(set).length) { writes.push({ t: 'day', id: day.id, set }); if ('date' in set) moved += 1; }
  });
  for (const id of removed) writes.push({ t: 'day', id, del: true });

  const removedVisits = new Set();
  for (const visit of visits) {
    if (removed.has(visit.dayId)) { writes.push({ t: 'visit', id: visit.id, del: true }); removedVisits.add(visit.id); }
    else if (visit.endDayId && removed.has(visit.endDayId)) writes.push({ t: 'visit', id: visit.id, unset: ['endDayId'] });
  }
  let removedNotes = 0;
  for (const note of notes) if (removed.has(note.dayId)) { writes.push({ t: 'dayNote', id: note.id, del: true }); removedNotes += 1; }

  // Where a booking's day reference lands: the day now on its (possibly shifted) date, or the same undated day.
  const shift = bookings === 'shift' && dated(meta) && dated(target) ? daysBetween(meta.start, target.start) : 0;
  const remap = (dayId) => {
    if (!oldDate.has(dayId)) return dayId;
    const date = oldDate.get(dayId);
    if (date && dated(target)) return byNewDate.get(shiftDate(date, shift)) ?? null;
    return next.has(dayId) ? dayId : null;
  };
  const finalDays = final.map((day) => ({ id: day.id, date: day.date, order: day.order }));
  const cancelled = [];
  let shifted = 0;
  let unassigned = 0;
  for (const item of res) {
    const dates = shiftPatch(item, shift);
    const set = { ...dates?.set };
    const unset = [];
    if (dates) shifted += 1;
    if (plainObject(item.dayPos) && Object.keys(item.dayPos).length) {
      const positions = {};
      let changed = false;
      for (const [dayId, position] of Object.entries(item.dayPos)) {
        const target = remap(dayId);
        if (target !== dayId) changed = true;
        if (target && !Object.hasOwn(positions, target)) positions[target] = position;
      }
      if (changed) {
        if (Object.keys(positions).length) set.dayPos = positions; else unset.push('dayPos');
        if (Object.keys(positions).length < Object.keys(item.dayPos).length) unassigned += 1;
      }
    }
    const hadDays = plainObject(item.stay) && Boolean(item.stay.fromDayId || item.stay.toDayId);
    let lost = false;
    if (isLodging(item.type) && dated(target) && isDate(item.start?.date)) {
      // A dated stay follows its (possibly shifted) dates onto the new days.
      const patch = stayDaysPatch({ ...item, ...set }, finalDays);
      if (patch?.set) set.stay = patch.set.stay;
      else if (patch?.unset) unset.push('stay');
      lost = hadDays && Boolean(patch) && !patch.set?.stay.fromDayId;
    } else if (hadDays) {
      const stay = { ...item.stay };
      for (const field of ['fromDayId', 'toDayId']) {
        if (!stay[field]) continue;
        const target = remap(stay[field]);
        if (target) stay[field] = target; else { delete stay[field]; lost = true; }
      }
      if (lost || stay.fromDayId !== item.stay.fromDayId || stay.toDayId !== item.stay.toDayId) set.stay = stay;
    }
    if (lost && item.status !== 'cancelled') { set.status = 'cancelled'; cancelled.push({ id: item.id, title: item.title }); }
    if (item.visitId && removedVisits.has(item.visitId)) unset.push('visitId');
    if (Object.keys(set).length || unset.length) writes.push({ t: 'res', id: item.id, ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
  }
  return {
    writes,
    impact: {
      removedDays: [...days].sort(byOrder).filter((day) => removed.has(day.id)).map((day) => ({ id: day.id, date: day.date ?? null, title: day.title ?? '' })),
      created: fresh.length, moved, removedVisits: removedVisits.size, removedNotes, cancelled, shifted, unassigned, delta,
    },
  };
}

const idList = (value, max) => Array.isArray(value) && value.length <= max && value.every(isId) && new Set(value).size === value.length;

export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => ARG_KEYS.includes(key)), 'invalid_args');
    for (const field of ['start', 'end']) invariant(args[field] === undefined || args[field] === null || isDate(args[field]), 'invalid_args');
    invariant(args.dayCount === undefined || (Number.isSafeInteger(args.dayCount) && args.dayCount >= 1 && args.dayCount <= LIMITS.tripDays), 'invalid_args');
    if (dated(args)) {
      const span = daysBetween(args.start, args.end);
      invariant(span >= 0 && span < LIMITS.tripDays, 'invalid_date_range');
    }
    invariant(args.bookings === undefined || ['keep', 'shift'].includes(args.bookings), 'invalid_args');
    invariant(idList(args.days, LIMITS.days) && idList(args.visits ?? [], MAX_READS) && idList(args.notes ?? [], MAX_READS) && idList(args.res ?? [], MAX_READS), 'invalid_args');
    invariant(plainObject(args.newIds ?? {}) && Object.keys(args.newIds ?? {}).every((key) => key === 'day') && idList(args.newIds?.day ?? [], LIMITS.tripDays), 'invalid_args');
    const reads = 1 + args.days.length + (args.visits?.length ?? 0) + (args.notes?.length ?? 0) + (args.res?.length ?? 0) + (args.newIds?.day?.length ?? 0);
    invariant(reads <= MAX_READS, 'too_many_reads', 413);
  },
  reads: (args) => [
    { t: 'meta', id: 'meta' },
    ...args.days.map((id) => ({ t: 'day', id })),
    ...(args.visits ?? []).map((id) => ({ t: 'visit', id })),
    ...(args.notes ?? []).map((id) => ({ t: 'dayNote', id })),
    ...(args.res ?? []).map((id) => ({ t: 'res', id })),
    ...(args.newIds?.day ?? []).map((id) => ({ t: 'day', id })),
  ],
  plan({ args, can, get }) {
    invariant(can('trip.edit'), 'forbidden', 403);
    const live = (t, ids) => (ids ?? []).map((id) => get(t, id)).filter(Boolean);
    const newIds = args.newIds?.day ?? [];
    invariant(newIds.every((id) => !get('day', id)), 'already_exists', 409);
    const { writes } = planRedate({
      meta: get('meta', 'meta'), days: live('day', args.days), visits: live('visit', args.visits), notes: live('dayNote', args.notes),
      res: live('res', args.res), target: { start: args.start ?? null, end: args.end ?? null, dayCount: args.dayCount }, bookings: args.bookings ?? 'keep', newIds,
    });
    invariant(writes.length <= LIMITS.commitWrites, 'too_many_writes', 413);
    if (writes.some((write) => ['day', 'visit', 'dayNote'].includes(write.t))) invariant(can('plan.edit'), 'forbidden', 403);
    if (writes.some((write) => write.t === 'res')) invariant(can('res.edit'), 'forbidden', 403);
    return writes;
  },
});
