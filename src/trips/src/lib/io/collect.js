// Reads what an export needs from an open space (`openSpace`): entities, members and the viewer's private items.
import { schemas } from '../../shared/schema/index.js';
import { PRIVATE_TYPES } from './space-format.js';

/** Every entity of the space's kind, by type, as the replica holds them (meta and members excluded). */
export function spaceEntities(space, kind = space.ref?.k ?? 'trip') {
  const out = {};
  for (const type of Object.keys(schemas[kind] ?? {})) {
    if (type === 'meta' || type === 'member') continue;
    const list = space.select?.[type]?.all() ?? space.query?.(type) ?? [];
    if (list.length) out[type] = list;
  }
  return out;
}

/** The viewer's own private packing items and expenses for this trip. */
export function ownPrivateItems(space) {
  const out = {};
  if (space.ref?.k !== 'trip') return out;
  for (const type of PRIVATE_TYPES) {
    try { out[type] = space.privateItems(type).list(); } catch { /* no personal store */ }
  }
  return out;
}

/** Members as `{id, name, role, color}`. */
export const spaceMembers = (space) => (space.members?.() ?? []).map((member) => ({ id: member.uid, name: member.name, role: member.role, color: member.color }));

/** The arrays `tripGeo` reads. */
export function tripData(space) {
  const all = (type) => space.select?.[type]?.all() ?? [];
  return { places: all('place'), days: all('day'), visits: all('visit'), reservations: all('res'), notes: all('dayNote') };
}
