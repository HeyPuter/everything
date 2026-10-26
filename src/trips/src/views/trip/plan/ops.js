import { registerDomainAdapter } from '../../../lib/store/index.js';
import { buildTimeline, indexForTime, placeAt } from '../../../lib/timeline/index.js';
import { addDays, dateRange, daysBetween, isDate } from '../../../shared/dates.js';
import { orderBetween, orderKeys } from '../../../shared/order.js';
import { LIMITS } from '../../../shared/limits.js';
import { SERVER_FIELDS } from '../../../shared/schema/index.js';
import { dayRemovalImpact } from '../../../lib/res/shift.js';
import dayRemove from '../../../../worker/ops/trip/domain/dayRemove.js';
import visitMove from '../../../../worker/ops/trip/domain/visitMove.js';

// The worker's own plans run on the local replica, so a domain op shows exactly what the worker will do.
const adapter = (def) => (args, { get }) => def.plan({ args, get: (type, id) => get(type, id) ?? null, can: () => true });
registerDomainAdapter('day.remove', adapter(dayRemove));
registerDomainAdapter('visit.move', adapter(visitMove));

const CHUNK = LIMITS.commitWrites;
const TYPE = { visit: 'visit', note: 'dayNote', res: 'res' };

export function planData(space) {
  return { days: space.select.day.all(), visits: space.select.visit.all(), notes: space.select.dayNote.all(), reservations: space.select.res.all() };
}
// Selector arrays keep their identity until their type changes, so the timeline is rebuilt only then.
const timelines = new WeakMap();
export function timelineOf(space) {
  const data = planData(space);
  const cached = timelines.get(space);
  if (cached && cached.days === data.days && cached.visits === data.visits && cached.notes === data.notes && cached.reservations === data.reservations) return cached.timeline;
  const timeline = buildTimeline(data);
  timelines.set(space, { ...data, timeline });
  return timeline;
}
export const rowType = (row) => TYPE[row.kind];
const stripServer = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !SERVER_FIELDS.includes(key)));

/** The next date that would extend a dated trip, or null when there is none or the trip is at its length limit. */
export function nextDate(space) {
  const meta = space.get('meta', 'meta');
  const last = [meta?.end, ...space.select.day.all().map((day) => day.date)].filter(isDate).sort().at(-1);
  if (!last || !isDate(meta?.start)) return null;
  const next = addDays(last, 1);
  return daysBetween(meta.start, next) < LIMITS.tripDays ? next : null;
}

/** The patch that brings an undated trip's `dayCount` in line with its days (after adds, removals, undo or remote edits), or []. */
export function dayCountPatch(space) {
  const meta = space.get('meta', 'meta');
  const count = Math.min(space.select.day.all().length, LIMITS.tripDays);
  if (!meta || isDate(meta.start) || count < 1 || meta.dayCount === count || !space.can('trip.edit')) return [];
  return [space.ops.patch('meta', 'meta', { set: { dayCount: count } })];
}

/** Trip dates without a day yet (a dated trip whose days were never laid out, or only partly). */
export function missingDates(space) {
  const meta = space.get('meta', 'meta');
  if (!isDate(meta?.start)) return [];
  const end = isDate(meta.end) && meta.end >= meta.start ? meta.end : meta.start;
  if (daysBetween(meta.start, end) >= LIMITS.tripDays) return [];
  const taken = new Set(space.select.day.all().map((day) => day.date));
  return dateRange(meta.start, end).filter((date) => !taken.has(date));
}

const linksVisit = (entity, ids) => (entity.links ?? []).some((link) => link.t === 'visit' && ids.has(link.id));

/**
 * What removing a day does: the worker's own plan run on the local replica over every candidate entity, so the preview
 * matches the commit. `args(exps)` builds the `day.remove` arguments with the expenses the user chose to delete.
 */
export function dayImpact(space, dayId) {
  const day = space.get('day', dayId);
  if (!day) return null;
  const { days, visits, notes, reservations } = planData(space);
  const bookings = dayRemovalImpact(reservations, days, dayId).filter((item) => item.patch);
  const removed = new Set(visits.filter((visit) => visit.dayId === dayId).map((visit) => visit.id));
  const stayDays = bookings.flatMap(({ res }) => [res.stay?.fromDayId, res.stay?.toDayId]);
  const later = isDate(day.date) ? days.filter((other) => isDate(other.date) && other.date > day.date).map((other) => other.id) : [];
  const lists = {
    visits: visits.filter((visit) => visit.dayId === dayId || visit.endDayId === dayId).map((visit) => visit.id),
    notes: notes.filter((note) => note.dayId === dayId).map((note) => note.id),
    res: bookings.map(({ res }) => res.id),
    days: [...new Set([...later, ...stayDays])].filter((id) => id && id !== dayId && space.get('day', id)),
    files: removed.size ? (space.select.file?.all() ?? []).filter((file) => linksVisit(file, removed)).map((file) => file.id) : [],
    unlink: removed.size ? space.select.exp.all().filter((exp) => linksVisit(exp, removed)).map((exp) => exp.id) : [],
  };
  const writes = dayRemove.plan({ args: { day: dayId, ...lists }, get: (type, id) => space.get(type, id) ?? null, can: () => true });
  const of = (type, test) => writes.filter((write) => write.t === type && test(write));
  const kind = (action) => bookings.filter((item) => item.action === action).map((item) => item.res);
  const cancelled = kind('cancel');
  const cancelledIds = new Set(cancelled.map((res) => res.id));
  const args = (exps = []) => {
    const out = { day: dayId };
    for (const [key, value] of Object.entries(lists)) if (value.length) out[key] = value;
    if (exps.length) out.exps = exps;
    return out;
  };
  return {
    day,
    visits: of('visit', (write) => write.del).length,
    spanning: of('visit', (write) => write.unset).length,
    notes: of('dayNote', (write) => write.del).length,
    unassigned: kind('unassign').length,
    cancelled,
    shortened: kind('shorten'),
    expenses: space.select.exp.all().filter((exp) => exp.links?.some((link) => link.t === 'res' && cancelledIds.has(link.id))),
    shifted: of('day', (write) => write.set?.date).length,
    end: writes.find((write) => write.t === 'meta')?.set.end ?? null,
    removedVisits: [...removed],
    needs: { res: writes.some((write) => write.t === 'res'), trip: writes.some((write) => write.t === 'meta') },
    tooLarge: Object.values(lists).reduce((sum, list) => sum + list.length, 2) + cancelled.length > LIMITS.commitWrites,
    args,
  };
}

/** Plan writes. Each returns a promise that rejects only on local validation; worker refusals surface as conflicts. */
export function createActions(space, { label }) {
  const keep = (writes, row) => writes.filter((write) => (write.t !== 'res' || space.can('res.edit')) && !(row && write.t === rowType(row) && write.id === row.id));
  const patches = (writes) => writes.map((write) => space.ops.patch(write.t, write.id, { set: write.set, unset: write.unset }));
  const apply = (ops, history, options = {}) => (ops.length ? space.apply(ops, history ? { history: label(history), ...options } : options) : Promise.resolve());
  const rowsOf = (dayId) => timelineOf(space).byDay.get(dayId)?.rows ?? [];

  async function addDay({ dated = false } = {}) {
    const days = space.select.day.all();
    const order = orderBetween(days.at(-1)?.order ?? null, null);
    const date = dated ? nextDate(space) : null;
    const create = space.ops.create('day', { order, date });
    const meta = space.get('meta', 'meta');
    const extend = date && (!isDate(meta?.end) || meta.end < date) ? [space.ops.patch('meta', 'meta', { set: { end: date } })] : [];
    await apply([create, ...extend], 'addDay');
    return create.id;
  }

  /** Creates days for trip dates that have none, in date order among existing days, or `dayCount` undated days. */
  async function setUpDays() {
    const days = [...space.select.day.all()];
    const meta = space.get('meta', 'meta');
    const ops = [];
    const dates = missingDates(space);
    if (!dates.length && !days.length) {
      const keys = orderKeys(Math.min(meta?.dayCount ?? 7, LIMITS.tripDays));
      keys.forEach((order) => ops.push(space.ops.create('day', { order, date: null })));
    }
    for (const date of dates) {
      const before = days.findLastIndex((day) => isDate(day.date) && day.date < date);
      const after = before === -1 ? days.findIndex((day) => isDate(day.date)) : before + 1;
      let index = after === -1 ? days.length : after;
      let order;
      try { order = orderBetween(days[index - 1]?.order ?? null, days[index]?.order ?? null); } catch {
        index = days.length;
        order = orderBetween(days.at(-1)?.order ?? null, null);
      }
      const create = space.ops.create('day', { order, date });
      days.splice(index, 0, { id: create.id, order, date });
      ops.push(create);
    }
    for (let start = 0; start < ops.length; start += CHUNK) await apply(ops.slice(start, start + CHUNK));
  }

  const editDay = (day, set = {}, unset = []) => apply([space.ops.patch('day', day.id, { set, unset })], 'editDay');

  /** Moves a day to `index` (among the other days). Dated days keep their dates in position order, so content moves to another date. */
  async function moveDay(dayId, index) {
    const days = space.select.day.all();
    const day = days.find((item) => item.id === dayId);
    if (!day) return;
    const rest = days.filter((item) => item.id !== dayId);
    const at = Math.max(0, Math.min(index, rest.length));
    const final = [...rest.slice(0, at), day, ...rest.slice(at)];
    const sets = new Map();
    const put = (id, values) => sets.set(id, { ...sets.get(id), ...values });
    try { put(dayId, { order: orderBetween(rest[at - 1]?.order ?? null, rest[at]?.order ?? null) }); } catch {
      orderKeys(final.length).forEach((order, position) => { if (final[position].order !== order) put(final[position].id, { order }); });
    }
    const dated = final.filter((item) => isDate(item.date));
    const dates = dated.map((item) => item.date).sort();
    dated.forEach((item, position) => { if (item.date !== dates[position]) put(item.id, { date: dates[position] }); });
    await apply([...sets].map(([id, set]) => space.ops.patch('day', id, { set })), 'moveDay');
  }

  /** The op covers shared entities; the caller's own private expenses drop their links to the deleted visits here. */
  async function removeDay(impact, exps = []) {
    await space.apply([space.ops.domain('day.remove', impact.args(exps))]);
    const removed = new Set(impact.removedVisits ?? []);
    if (!removed.size) return;
    let own = [];
    try { own = space.privateItems('exp').list(); } catch { return; }
    for (const exp of own.filter((item) => linksVisit(item, removed))) {
      const links = exp.links.filter((link) => !(link.t === 'visit' && removed.has(link.id)));
      await space.privateItems('exp').patch(exp.id, { links: links.length ? links : undefined }).catch(() => {});
    }
  }

  async function addVisits(dayId, placeIds, { index = -1 } = {}) {
    if (!placeIds.length) return;
    const { orders, writes } = placeAt(rowsOf(dayId), index, dayId, { count: placeIds.length });
    await apply([...placeIds.map((placeId, position) => space.ops.create('visit', { dayId, placeId, order: orders[position] })), ...patches(keep(writes))], 'addVisits');
  }

  async function addItem(dayId, fields) {
    const rows = rowsOf(dayId);
    const { order, writes } = placeAt(rows, indexForTime(rows, fields.start), dayId);
    await apply([space.ops.create('visit', { ...fields, dayId, placeId: null, order }), ...patches(keep(writes))], 'addItem');
  }

  // A new time moves the item to its slot by time; otherwise it keeps its manual position.
  function retime(type, entity, time, set) {
    const rows = rowsOf(entity.dayId);
    const key = `${type === 'visit' ? 'visit' : 'note'}:${entity.id}`;
    const { order, writes } = placeAt(rows, indexForTime(rows, time, { skip: key }), entity.dayId, { skip: key });
    set.order = order;
    return patches(keep(writes, { kind: type === 'visit' ? 'visit' : 'note', id: entity.id }));
  }

  async function editVisit(visit, set = {}, unset = []) {
    const extra = set.start && set.start !== visit.start ? retime('visit', visit, set.start, set) : [];
    await apply([space.ops.patch('visit', visit.id, { set, unset }, { base: true }), ...extra], 'editVisit');
  }

  async function addNote(dayId, fields) {
    const rows = rowsOf(dayId);
    const { order, writes } = placeAt(rows, indexForTime(rows, fields.time), dayId);
    await apply([space.ops.create('dayNote', { ...fields, dayId, order }), ...patches(keep(writes))], 'addNote');
  }

  async function editNote(note, set = {}, unset = []) {
    const extra = set.time && set.time !== note.time ? retime('dayNote', note, set.time, set) : [];
    await apply([space.ops.patch('dayNote', note.id, { set, unset }), ...extra], 'editNote');
  }

  /** Deletes are not in history; `restore()` puts back a copy under a new id. */
  async function remove(type, entity) {
    await space.apply([space.ops.remove(type, entity.id, { base: type === 'visit' })]);
    return { restore: () => space.apply([space.ops.create(type, stripServer(entity))]) };
  }

  /** Moves a timeline row to `index` on `toDayId`. Visits change day through `visit.move`; the undo moves them back. */
  async function moveRow(row, fromDayId, toDayId, index) {
    const same = fromDayId === toDayId;
    const { order, writes } = placeAt(rowsOf(toDayId), index, toDayId, { skip: same ? row.key : null });
    const extra = patches(keep(writes, row));
    if (row.kind === 'visit' && !same) {
      const visit = row.entity;
      const inverse = [{ do: 'visit.move', args: { visit: visit.id, day: visit.dayId, order: visit.order } }];
      if (visit.endDayId === toDayId) inverse.push({ t: 'visit', id: visit.id, set: { endDayId: visit.endDayId } });
      await apply([space.ops.domain('visit.move', { visit: visit.id, day: toDayId, order }), ...extra], 'moveVisit', { inverse });
    } else if (row.kind === 'visit') await apply([space.ops.patch('visit', row.id, { set: { order } }), ...extra], 'reorder');
    else if (row.kind === 'note') await apply([space.ops.patch('dayNote', row.id, { set: same ? { order } : { order, dayId: toDayId } }), ...extra], same ? 'reorder' : 'moveNote');
    else {
      const unset = !same && Object.hasOwn(row.entity.dayPos ?? {}, fromDayId) ? [`dayPos.${fromDayId}`] : [];
      await apply([space.ops.patch('res', row.id, { set: { [`dayPos.${toDayId}`]: order }, unset }), ...extra], 'reorder');
    }
  }

  async function duplicateVisit(visit, dayId) {
    const { order, writes } = placeAt(rowsOf(dayId), -1, dayId);
    const fields = visit.placeId ? { placeId: visit.placeId } : { placeId: null, title: visit.title };
    await apply([space.ops.create('visit', { ...fields, dayId, order }), ...patches(keep(writes))], 'addVisits');
  }

  const setLegMode = (visit, mode) => apply([space.ops.patch('visit', visit.id, mode ? { set: { legMode: mode } } : { unset: ['legMode'] })], 'editVisit');

  return { addDay, setUpDays, editDay, moveDay, removeDay, addVisits, addItem, editVisit, addNote, editNote, remove, moveRow, duplicateVisit, setLegMode };
}
