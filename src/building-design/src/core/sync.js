/**
 * Element-level three-way merge for projects that several people edit.
 *
 * `base` is the shared state this copy last synchronized with (a Map of
 * id -> item), `doc` is the local document and `remote` is the latest
 * shared state. Changes made only remotely come in, changes made only
 * locally stay, and when both sides changed the same element differently
 * the local version wins (it is written back on the next save) and the
 * element is reported as a conflict.
 */

const json = (x) => (x == null ? null : JSON.stringify(x));

export function sameItem(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return json(a) === json(b);
}

/** Ids that changed locally since `base` (items are immutable, so references tell). */
export function localChanges(base, doc) {
  const out = [];
  for (const [id, it] of doc.items) if (base.get(id) !== it) out.push(id);
  for (const id of base.keys()) if (!doc.items.has(id)) out.push(id);
  return out;
}

/**
 * Compare `doc` with `remote` relative to `base`. Returns
 *   incoming: [[id, item | null]]  remote changes to apply locally
 *   conflicts: [id]                 changed on both sides, local kept
 *   nextBase: Map                   the new shared state to compare against
 *   pending: number                 local changes not yet in the shared copy
 */
export function mergeRemote(base, doc, remote) {
  const incoming = [];
  const conflicts = [];
  const nextBase = new Map();
  const ids = new Set([...base.keys(), ...remote.keys(), ...doc.items.keys()]);
  let pending = 0;
  for (const id of ids) {
    const b = base.get(id) ?? null;
    const l = doc.items.get(id) ?? null;
    let r = remote.get(id) ?? null;
    const remoteChanged = !sameItem(r, b);
    // Keep the base object when nothing changed, so reference checks keep working.
    if (!remoteChanged) r = b;
    const localChanged = l !== b;
    if (remoteChanged && !localChanged) {
      incoming.push([id, r]);
    } else if (remoteChanged && localChanged) {
      if (sameItem(l, r)) r = l;
      else if (!l) {
        // Deleted here but edited by someone else: keep their element.
        incoming.push([id, r]);
        conflicts.push(id);
      } else {
        conflicts.push(id);
        pending++;
      }
    } else if (localChanged) pending++;
    if (r) nextBase.set(id, r);
  }
  return { incoming, conflicts, nextBase, pending };
}

/** Items of a decoded document as a Map. */
export function itemMap(doc) {
  return new Map(doc.items);
}
