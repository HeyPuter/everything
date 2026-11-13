import { uid, reserveId } from '../lib/util.js';

/** Allocate fresh note IDs against an existing list and earlier allocations. */
export function noteIdGenerator(notes = []) {
  const used = new Set(notes.map((n) => n.id));
  return () => reserveId(used, uid(6));
}

/** Preserve supplied identities, replacing only missing or conflicting IDs. */
export function uniqueNoteIds(notes, existing = []) {
  const used = new Set(existing.map((n) => n.id));
  return notes.map((n) => {
    const id = reserveId(used, n.id || uid(6));
    return id === n.id ? n : { ...n, id };
  });
}
