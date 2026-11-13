import { uid, reserveId } from '../lib/util.js';

/** Allocate fresh note IDs against an existing list and earlier allocations. */
export function noteIdGenerator(notes = []) {
  const used = new Set(notes.map((n) => n.id));
  return () => reserveId(used, uid(6));
}
