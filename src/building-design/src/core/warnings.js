/**
 * Model checks: problems worth a look, each with the elements involved.
 * Returns [{ message, ids }], most serious first.
 */
import { openingSize } from './model.js';
import { sub, dot, norm, cross, len } from './geom.js';

export function modelWarnings(doc, scene) {
  const out = [];
  const add = (message, ids) => out.push({ message, ids });

  // Rooms and areas.
  const regions = new Map();
  for (const r of doc.all('room')) {
    const reg = scene.rooms.room(r);
    if (!reg) add('A room is not in a properly enclosed region', [r.id]);
    else {
      const key = `${r.levelId}|${reg.outer[0]}|${reg.outer.length}`;
      if (regions.has(key)) add('Multiple rooms are in the same enclosed region', [regions.get(key), r.id]);
      else regions.set(key, r.id);
    }
  }
  for (const a of doc.all('area')) if (!scene.areas.area(a)) add('An area is not in a properly enclosed region', [a.id]);

  // Walls that overlap along the same line.
  const walls = doc.all('wall');
  const byLevel = new Map();
  for (const w of walls) {
    if (!byLevel.has(w.levelId)) byLevel.set(w.levelId, []);
    byLevel.get(w.levelId).push(w);
  }
  for (const list of byLevel.values()) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (overlapLength(list[i], list[j]) > 10) add('Walls overlap. One of them may be ignored when room boundaries are found', [list[i].id, list[j].id]);
      }
  }

  // Openings that overlap in their wall.
  for (const w of walls) {
    const hosted = doc.filter((el) => el.hostId === w.id && (el.kind === 'door' || el.kind === 'window' || el.kind === 'opening'));
    for (let i = 0; i < hosted.length; i++)
      for (let j = i + 1; j < hosted.length; j++) {
        const a = hosted[i];
        const b = hosted[j];
        const wa = openingSize(doc, a).width;
        const wb = openingSize(doc, b).width;
        if (Math.abs(a.t - b.t) < (wa + wb) / 2 - 1) add('Openings overlap in the same wall', [a.id, b.id]);
      }
  }

  // Duplicate marks.
  for (const kind of ['door', 'window']) {
    const seen = new Map();
    for (const el of doc.all(kind)) {
      if (!el.mark) continue;
      if (!seen.has(el.mark)) seen.set(el.mark, []);
      seen.get(el.mark).push(el.id);
    }
    for (const [m, ids] of seen) if (ids.length > 1) add(`${ids.length} ${kind}s have the same Mark (${m})`, ids);
  }
  const roomNumbers = new Map();
  for (const r of doc.all('room')) {
    if (!r.number) continue;
    const k = `${r.levelId}|${r.number}`;
    if (!roomNumbers.has(k)) roomNumbers.set(k, []);
    roomNumbers.get(k).push(r.id);
  }
  for (const [k, ids] of roomNumbers) if (ids.length > 1) add(`${ids.length} rooms have the same number (${k.split('|')[1]})`, ids);

  // References to missing items.
  for (const el of doc.items.values()) {
    if (el.hostId && !doc.has(el.hostId)) add('An element has lost its host', [el.id]);
    if (el.levelId && !doc.has(el.levelId) && !el.kind.endsWith('Type')) add('An element is on a level that no longer exists', [el.id]);
  }
  return out;
}

/** Length over which two walls lie on the same line. */
function overlapLength(a, b) {
  const d = sub(a.b, a.a);
  const L = len(d);
  if (L < 1) return 0;
  const u = norm(d);
  // Both ends of b within a few millimetres of a's line.
  if (Math.abs(cross(u, sub(b.a, a.a))) > 5 || Math.abs(cross(u, sub(b.b, a.a))) > 5) return 0;
  const s0 = dot(sub(b.a, a.a), u);
  const s1 = dot(sub(b.b, a.a), u);
  return Math.max(0, Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)));
}
