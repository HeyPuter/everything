import { invariant } from '../../../../src/shared/errors.js';
import { isId } from '../../../../src/shared/ids.js';
import { addDays, isDate } from '../../../../src/shared/dates.js';
import { LIMITS } from '../../../../src/shared/limits.js';
import { dayRemovalImpact } from '../../../../src/lib/res/shift.js';

const LISTS = ['visits', 'notes', 'res', 'days', 'exps', 'files', 'unlink'];
const idList = (value) => Array.isArray(value) && value.every(isId) && new Set(value).size === value.length;
const byOrder = (a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order < b.order ? -1 : 1);
const linksTo = (entity, ids) => (entity?.links ?? []).some((link) => link.t === 'visit' && ids.has(link.id));
function unlinkVisits(t, entity, ids) {
  const links = entity.links.filter((link) => !(link.t === 'visit' && ids.has(link.id))).map((link) => ({ t: link.t, id: link.id }));
  return { t, id: entity.id, ...(links.length ? { set: { links } } : { unset: ['links'] }) };
}

/**
 * `{day, visits, notes, res, days, exps, files, unlink}`. The client lists what it believes is affected (the worker
 * cannot list) and the worker re-checks each entity:
 * - visits and notes on the day are deleted, and the listed `files` and expenses (`unlink`) lose their links to them;
 * - bookings follow `dayRemovalImpact` (src/lib/res);
 * - later dated days among `days` (and the trip end) move up a day. `days` also carries the check-in and check-out
 *   days of listed stays, which placement needs;
 * - `exps` are expenses the user chose to delete with a cancelled stay.
 * Removing a day is a `plan.edit` action, including the trip end it moves (data-model §5). Link changes the caller
 * may not make are left; readers ignore links to missing entities.
 */
export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => key === 'day' || LISTS.includes(key)) && isId(args.day), 'invalid_args');
    for (const key of LISTS) invariant(args[key] === undefined || idList(args[key]), 'invalid_args');
    invariant(!(args.days ?? []).includes(args.day), 'invalid_args');
    invariant(LISTS.reduce((sum, key) => sum + (args[key]?.length ?? 0), 2) <= LIMITS.commitWrites, 'day_too_large', 413);
  },
  reads: (args) => [
    { t: 'meta', id: 'meta' }, { t: 'day', id: args.day },
    ...(args.visits ?? []).map((id) => ({ t: 'visit', id })),
    ...(args.notes ?? []).map((id) => ({ t: 'dayNote', id })),
    ...(args.res ?? []).map((id) => ({ t: 'res', id })),
    ...(args.days ?? []).map((id) => ({ t: 'day', id })),
    ...[...new Set([...(args.exps ?? []), ...(args.unlink ?? [])])].map((id) => ({ t: 'exp', id })),
    ...(args.files ?? []).map((id) => ({ t: 'file', id })),
  ],
  plan({ args, can, get }) {
    invariant(can('plan.edit'), 'forbidden', 403);
    const day = get('day', args.day);
    invariant(day, 'gone', 409);
    const writes = [{ t: 'day', id: day.id, del: true }];
    const removed = new Set();
    for (const id of args.visits ?? []) {
      const visit = get('visit', id);
      if (visit?.dayId === day.id) { writes.push({ t: 'visit', id, del: true }); removed.add(id); }
      else if (visit?.endDayId === day.id) writes.push({ t: 'visit', id, unset: ['endDayId'] });
    }
    for (const id of args.notes ?? []) if (get('dayNote', id)?.dayId === day.id) writes.push({ t: 'dayNote', id, del: true });

    const others = (args.days ?? []).map((id) => get('day', id)).filter(Boolean);
    const days = [day, ...others].sort(byOrder);
    const reservations = (args.res ?? []).map((id) => get('res', id)).filter(Boolean);
    const cancelled = new Set();
    let bookings = false;
    for (const { res, action, patch } of dayRemovalImpact(reservations, days, day.id)) {
      if (!patch) continue;
      if (action === 'cancel') cancelled.add(res.id);
      writes.push({ t: 'res', id: res.id, ...patch });
      bookings = true;
    }
    invariant(!bookings || can('res.edit'), 'forbidden', 403);
    const dropped = new Set((args.exps ?? []).filter((id) => get('exp', id)?.links?.some((link) => link.t === 'res' && cancelled.has(link.id))));
    invariant(!dropped.size || can('costs.edit'), 'forbidden', 403);
    for (const id of dropped) writes.push({ t: 'exp', id, del: true });
    if (removed.size && can('files.edit')) {
      for (const id of args.files ?? []) { const file = get('file', id); if (linksTo(file, removed)) writes.push(unlinkVisits('file', file, removed)); }
    }
    if (removed.size && can('costs.edit')) {
      for (const id of args.unlink ?? []) {
        const exp = get('exp', id);
        if (!dropped.has(id) && linksTo(exp, removed)) writes.push(unlinkVisits('exp', exp, removed));
      }
    }
    if (isDate(day.date)) {
      for (const later of others) if (isDate(later.date) && later.date > day.date) writes.push({ t: 'day', id: later.id, set: { date: addDays(later.date, -1) } });
      const meta = get('meta', 'meta');
      if (isDate(meta?.end) && meta.end >= day.date && (!isDate(meta.start) || (meta.start <= day.date && meta.start < meta.end))) {
        writes.push({ t: 'meta', id: 'meta', set: { end: addDays(meta.end, -1) } });
      }
    }
    return writes;
  },
});
