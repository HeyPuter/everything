// Links between reservations and other entities. File links (`file.linked` and `file.links`, src/shared/file-links.js)
// and `exp.links` are the only stores of those links.
import { fileLinkPatch, hasFileLink } from '../../shared/file-links.js';

/** Whether an expense, or a file in either link form, links to `{t, id}`. */
export const hasLink = (entity, t, id) => hasFileLink(entity, { t, id });
export const withoutLink = (links = [], t, id) => links.filter((link) => !(link.t === t && link.id === id));

/** Trip files (not trashed, user-visible) attached to a reservation. */
export const attachedFiles = (files, resId) => files.filter((file) => file.kind === 'user' && !file.trashed && hasLink(file, 'res', resId));
export const linkedExpenses = (exps, resId) => exps.filter((exp) => hasLink(exp, 'res', resId));
/** Expenses whose only link is this reservation: deleting the booking asks whether to delete them too. */
export const soleExpenses = (exps, resId) => linkedExpenses(exps, resId).filter((exp) => exp.links.length === 1);

/** `{set}` or `{unset}` for a new links array (an empty list is removed). */
export const linksPatch = (links) => (links.length ? { set: { links } } : { unset: ['links'] });

/** Patches attaching and detaching files: `{fileId: {set?, unset?}}` for every file whose links change. */
export function fileLinkChanges(files, resId, wanted) {
  const changes = {};
  const target = { t: 'res', id: resId };
  for (const file of files) {
    const patch = fileLinkPatch(file, wanted.has(file.id) ? { add: [target] } : { remove: [target] });
    if (patch) changes[file.id] = patch;
  }
  return changes;
}

/**
 * Ops that go with deleting a reservation, for the permissions the caller has (`can(action)`): unlink its files
 * and expenses, delete the expenses listed in `deleteExpenses`, and clear `stayId` on visits and bookings that
 * pointed at a deleted lodging. Links the caller may not change stay; readers ignore links to missing entities.
 */
export function removalOps({ res, files = [], exps = [], visits = [], reservations = [], ops, can, deleteExpenses = [] }) {
  const list = [ops.remove('res', res.id, { base: true })];
  if (can('files.edit')) {
    for (const file of files) {
      const patch = fileLinkPatch(file, { remove: [{ t: 'res', id: res.id }] });
      if (patch) list.push(ops.patch('file', file.id, patch));
    }
  }
  if (can('costs.edit')) {
    const drop = new Set(deleteExpenses);
    for (const exp of linkedExpenses(exps, res.id)) {
      if (drop.has(exp.id) && exp.links.length === 1) list.push(ops.remove('exp', exp.id, { base: true }));
      else list.push(ops.patch('exp', exp.id, linksPatch(withoutLink(exp.links, 'res', res.id)), { base: true }));
    }
  }
  if (res.type === 'lodging') {
    if (can('plan.edit')) for (const visit of visits) if (visit.stayId === res.id) list.push(ops.patch('visit', visit.id, { unset: ['stayId'] }));
    for (const other of reservations) if (other.id !== res.id && other.stayId === res.id) list.push(ops.patch('res', other.id, { unset: ['stayId'] }));
  }
  return list;
}
