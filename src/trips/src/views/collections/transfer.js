// Writes that cross spaces: copy or move to another collection, add to a trip, mark visited in every collection.
import { el } from '../../ui/dom.js';
import { button, emptyState } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';
import { newId } from '../../shared/ids.js';
import { DomainError } from '../../shared/errors.js';
import { isBuiltin } from '../../lib/categories.js';
import { appendOrders, copySaved, fold, samePlace, toPlace } from './model.js';
import { collectionBadge } from './metaform.js';
import { icon } from './icons.js';
import { canWrite, listCollections, listSpaces, peekMeta, sameRef, withSpace } from './spaces.js';

const forbidden = () => new DomainError('forbidden', 403);

/** A list of spaces to pick from. Resolves the chosen entry, `'new'` for the create option, or null. */
export function pickSpace({ title, entries, kind = 'collection', allowNew = false, emptyText }) {
  return new Promise((resolve) => {
    let result = null;
    const choose = (value) => { result = value; dialog.close('chosen'); };
    const items = entries.map((entry) => el('li', {}, el('button.col-pick', { type: 'button', onclick: () => choose(entry) },
      kind === 'collection' ? collectionBadge(entry.meta, 32) : el('span.col-badge.col-badge-trip', { 'aria-hidden': 'true' }, icon('plane', 16)),
      el('span.col-pick-name', {}, entry.title || t(kind === 'collection' ? 'collections.untitled' : 'collections.untitledTrip')), icon('chevronRight', 16))));
    const content = el('div.col-pick-list', {},
      items.length ? el('ul.col-picks', {}, items) : emptyState({ title: emptyText, icon: kind === 'collection' ? 'heart' : 'plane' }),
      allowNew && button(t('collections.newCollectionOption'), { icon: 'plus', variant: 'outline', onclick: () => choose('new') }));
    const dialog = openModal({ title, content, onClose: () => resolve(result) });
  });
}

/** Collections the caller can add to, other than `except`. */
export async function writableCollections(context, except = null) {
  const entries = (await listCollections(context)).filter((entry) => canWrite(entry.role) && !sameRef(entry.ref, except));
  const info = await peekMeta(context, entries);
  return entries.map((entry) => ({ ...entry, meta: info.get(entry.ref.s)?.meta ?? null }));
}
export async function writableTrips(context) {
  return (await listSpaces(context, 'trip')).filter((entry) => canWrite(entry.role)).sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
}

/**
 * Copies saved places into `target` (labels matched by name, places already there skipped). With `move`, the
 * originals are deleted only once the copy reached the worker. Resolves `{added, skipped, moved, queued}`.
 */
export async function copyToCollection(context, { space, ids, target, move = false, uid }) {
  const items = ids.map((id) => space.get('saved', id)).filter(Boolean);
  const sourceLabels = space.select.label.all();
  const { value, flush } = await withSpace(context, target, async (dest) => {
    if (!dest.can('plan.edit')) throw forbidden();
    const ops = [];
    const byName = new Map(dest.select.label.all().map((label) => [fold(label.name), label.id]));
    const labelIds = new Map();
    const needed = sourceLabels.filter((label) => items.some((item) => item.labels?.includes(label.id)));
    const missing = needed.filter((label) => !byName.has(fold(label.name)));
    const labelOrders = appendOrders(dest.select.label.all(), missing.length);
    for (const label of needed) {
      let id = byName.get(fold(label.name));
      if (!id) {
        id = newId();
        ops.push(dest.ops.create('label', { name: label.name, ...(label.color !== undefined ? { color: label.color } : {}), order: labelOrders[missing.indexOf(label)] }, { id }));
        byName.set(fold(label.name), id);
      }
      labelIds.set(label.id, id);
    }
    const existing = dest.select.saved.all();
    const fresh = items.filter((item) => !existing.some((other) => samePlace(other, item)));
    const orders = appendOrders(existing, fresh.length);
    fresh.forEach((item, index) => ops.push(dest.ops.create('saved', copySaved(item, { uid, order: orders[index], labelIds }))));
    if (ops.length) await dest.apply(ops);
    return { added: fresh.length, skipped: items.length - fresh.length };
  }, { pull: true, open: [space] });
  if (flush?.status === 'rejected') throw forbidden();
  const sent = flush?.status === 'sent' || (!value.added && flush?.status !== 'queued');
  if (move && sent) await space.apply(items.map((item) => space.ops.remove('saved', item.id)));
  return { ...value, moved: move && sent, queued: flush?.status === 'queued' };
}

/** Adds saved places to a trip's places, with photo links and the caller's tags and rating. Skips places already there. */
export async function addToTrip(context, { items, trip, uid }) {
  const { value, flush } = await withSpace(context, trip, async (dest) => {
    if (!dest.can('plan.edit')) throw forbidden();
    const places = dest.select.place.all();
    const fresh = items.filter((item) => !places.some((place) => samePlace(place, item)));
    if (fresh.length) await dest.apply(fresh.map((item) => dest.ops.create('place', toPlace(item, { uid, builtin: isBuiltin }))));
    return { added: fresh.length, skipped: items.length - fresh.length };
  }, { pull: true });
  if (flush?.status === 'rejected') throw forbidden();
  return { ...value, queued: flush?.status === 'queued' };
}

/**
 * Marks every saved copy of `item` visited in all the caller's collections: the shared status where they may
 * edit, and their own visited flag everywhere. Resolves the number of places changed.
 */
export async function markVisitedEverywhere(context, { item, current, uid, onProgress }) {
  const entries = await listCollections(context);
  let changed = 0;
  for (const [index, entry] of entries.entries()) {
    onProgress?.(index + 1, entries.length);
    try {
      await withSpace(context, entry.ref, async (dest) => {
        const ops = [];
        const editable = dest.can('plan.edit');
        for (const saved of dest.select.saved.all()) {
          if (!samePlace(saved, item)) continue;
          const set = {};
          if (editable && saved.status !== 'visited') set.status = 'visited';
          if (saved.visited?.[uid] !== true) set[`visited.${uid}`] = true;
          if (Object.keys(set).length) ops.push(dest.ops.patch('saved', saved.id, { set }));
        }
        changed += ops.length;
        if (ops.length) await dest.apply(ops);
      }, { open: [current] });
    } catch { /* an unreachable collection keeps its status; the others still change */ }
  }
  return changed;
}
