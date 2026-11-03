import { DomainError, invariant } from '../../../../src/shared/errors.js';
import { isId } from '../../../../src/shared/ids.js';
import { isHlc } from '../../../../src/shared/hlc.js';
import { LIMITS } from '../../../../src/shared/limits.js';
import { fileLinkPatch } from '../../../../src/shared/file-links.js';

const LISTS = ['files', 'exps', 'moved', 'visits', 'stays'];
const idList = (value) => Array.isArray(value) && value.every(isId) && new Set(value).size === value.length;
const linked = (entity, id) => (entity?.links ?? []).some((link) => link.t === 'res' && link.id === id);
const linksWithout = (links, id) => links.filter((link) => !(link.t === 'res' && link.id === id)).map((link) => ({ t: link.t, id: link.id }));
const unlink = (t, entity, id) => {
  const links = linksWithout(entity.links, id);
  return { t, id: entity.id, ...(links.length ? { set: { links } } : { unset: ['links'] }) };
};

/**
 * The source half of moving a booking to another trip, sent once the copy exists there:
 * `{res, base?, files, exps, moved, visits, stays}`. Deletes the booking, unlinks the listed files and expenses (the
 * `moved` expenses, copied with it, are deleted while this booking is still their only link), and clears `stayId` on
 * listed visits and bookings that pointed at it. Links the caller may not edit are left; readers ignore them.
 * `base` is the version the copy was made from: a newer booking answers 409 `stale` so the copy is refreshed first.
 */
export default Object.freeze({
  kinds: ['trip'],
  validate(args) {
    invariant(Object.keys(args).every((key) => key === 'res' || key === 'base' || LISTS.includes(key)) && isId(args.res), 'invalid_args');
    invariant(args.base === undefined || isHlc(args.base), 'invalid_args');
    for (const key of LISTS) invariant(args[key] === undefined || idList(args[key]), 'invalid_args');
    invariant((args.moved ?? []).every((id) => args.exps?.includes(id)) && !(args.stays ?? []).includes(args.res), 'invalid_args');
    invariant(['files', 'exps', 'visits', 'stays'].reduce((sum, key) => sum + (args[key]?.length ?? 0), 1) <= LIMITS.commitWrites, 'move_too_large', 413);
  },
  reads: (args) => [
    { t: 'res', id: args.res },
    ...(args.files ?? []).map((id) => ({ t: 'file', id })),
    ...(args.exps ?? []).map((id) => ({ t: 'exp', id })),
    ...(args.visits ?? []).map((id) => ({ t: 'visit', id })),
    ...(args.stays ?? []).map((id) => ({ t: 'res', id })),
  ],
  plan({ args, can, get }) {
    invariant(can('res.edit'), 'forbidden', 403);
    const res = get('res', args.res);
    invariant(res, 'gone', 409);
    if (args.base !== undefined && res.v !== args.base) throw Object.assign(new DomainError('stale', 409), { extra: { server: res } });
    const writes = [{ t: 'res', id: res.id, del: true }];
    if (can('files.edit')) {
      for (const id of args.files ?? []) {
        const file = get('file', id);
        const patch = file ? fileLinkPatch(file, { remove: [{ t: 'res', id: res.id }] }) : null;
        if (patch) writes.push({ t: 'file', id, ...patch });
      }
    }
    const moved = new Set(args.moved ?? []);
    const expenses = (args.exps ?? []).map((id) => get('exp', id)).filter((exp) => linked(exp, res.id));
    invariant(!expenses.length || !moved.size || can('costs.edit'), 'forbidden', 403);
    if (can('costs.edit')) {
      for (const exp of expenses) writes.push(moved.has(exp.id) && exp.links.length === 1 ? { t: 'exp', id: exp.id, del: true } : unlink('exp', exp, res.id));
    }
    if (res.type === 'lodging') {
      if (can('plan.edit')) for (const id of args.visits ?? []) if (get('visit', id)?.stayId === res.id) writes.push({ t: 'visit', id, unset: ['stayId'] });
      for (const id of args.stays ?? []) if (get('res', id)?.stayId === res.id) writes.push({ t: 'res', id, unset: ['stayId'] });
    }
    return writes;
  },
});
