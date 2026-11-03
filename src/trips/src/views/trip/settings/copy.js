// Copying a trip's content into a new trip: new ids, remapped references, no other members' data.
import { addDays, isDate } from '../../../shared/dates.js';
import { isUuid } from '../../../shared/ids.js';
import { plainObject } from '../../../shared/schema/dsl.js';

export const COPY_GROUPS = Object.freeze(['days', 'places', 'bookings', 'packing', 'todos', 'collab']);
const SERVER = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'deleted']);
const strip = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !SERVER.has(key)));
const shiftPoint = (value, delta) => (plainObject(value) && isDate(value.date) && delta ? { ...value, date: addDays(value.date, delta) } : value);

/**
 * `source(type)` lists the source trip's entities. Returns `[{t, id, put}]` creates for the groups in `include`
 * (days pull in places, since visits point at them), with dates moved by `delta` days.
 */
export function copyEntities(source, include, { uid, delta = 0, makeId }) {
  const want = new Set(include);
  if (want.has('days')) want.add('places');
  const maps = new Map();
  const map = (type, id) => maps.get(type)?.get(id) ?? null;
  const out = [];
  const add = (t, old, put) => { out.push({ t, id: maps.get(t).get(old.id), put }); };
  const plan = (t, list) => { maps.set(t, new Map(list.map((item) => [item.id, makeId()]))); return list; };

  const guests = plan('guest', source('guest'));
  // People fields keep the copier and copied guests; other members are not part of the new trip.
  const person = (value) => (value === uid ? uid : isUuid(value) ? null : map('guest', value));
  const people = (list) => (Array.isArray(list) ? [...new Set(list.map(person).filter(Boolean))] : undefined);
  const withPeople = (put, ...fields) => {
    for (const field of fields) {
      if (!Object.hasOwn(put, field)) continue;
      const kept = people(put[field]);
      if (kept?.length) put[field] = kept; else delete put[field];
    }
    return put;
  };
  for (const guest of guests) add('guest', guest, strip(guest));

  const days = want.has('days') ? plan('day', source('day')) : [];
  const places = want.has('places') ? plan('place', source('place')) : [];
  const cats = want.has('places') ? plan('cat', source('cat')) : [];
  const res = want.has('bookings') ? plan('res', source('res')) : [];
  const visits = want.has('days') ? plan('visit', source('visit').filter((visit) => maps.get('day').has(visit.dayId))) : [];
  const notes = want.has('days') ? plan('dayNote', source('dayNote').filter((note) => maps.get('day').has(note.dayId))) : [];
  const bags = want.has('packing') ? plan('bag', source('bag')) : [];
  const packs = want.has('packing') ? plan('pack', source('pack')) : [];
  const lists = plan('listMeta', source('listMeta').filter((item) => (item.kind === 'pack' && want.has('packing')) || (item.kind === 'todo' && want.has('todos')) || (item.kind === 'note' && want.has('collab'))));
  const todos = want.has('todos') ? plan('todo', source('todo')) : [];
  const collabNotes = want.has('collab') ? plan('note', source('note')) : [];
  const links = want.has('collab') ? plan('link', source('link')) : [];

  for (const cat of cats) add('cat', cat, strip(cat));
  for (const day of days) add('day', day, { ...strip(day), date: isDate(day.date) ? addDays(day.date, delta) : day.date ?? null });
  for (const place of places) {
    const put = strip(place);
    delete put.rating; delete put.visited; delete put.track;
    if (put.tags) { if (put.tags[uid]) put.tags = { [uid]: put.tags[uid] }; else delete put.tags; }
    if (put.img?.fileId) delete put.img;
    if (put.cat && maps.get('cat').has(put.cat)) put.cat = map('cat', put.cat);
    add('place', place, put);
  }
  for (const visit of visits) {
    const put = strip(visit);
    put.dayId = map('day', visit.dayId);
    put.placeId = visit.placeId ? map('place', visit.placeId) : null;
    if (!put.placeId && !put.title?.trim()) continue;
    if (put.endDayId) { const end = map('day', put.endDayId); if (end) put.endDayId = end; else delete put.endDayId; }
    if (put.stayId) { const stay = map('res', put.stayId); if (stay) put.stayId = stay; else delete put.stayId; }
    delete put.alt;
    add('visit', visit, withPeople(put, 'people'));
  }
  for (const note of notes) add('dayNote', note, { ...strip(note), dayId: map('day', note.dayId) });
  for (const item of res) {
    const put = strip(item);
    for (const field of ['placeId', 'visitId', 'stayId']) {
      if (!put[field]) continue;
      const target = map(field === 'placeId' ? 'place' : field === 'visitId' ? 'visit' : 'res', put[field]);
      if (target) put[field] = target; else delete put[field];
    }
    if (put.start) put.start = shiftPoint(put.start, delta);
    if (put.end) put.end = shiftPoint(put.end, delta);
    if (Array.isArray(put.legs)) put.legs = put.legs.map((leg) => ({ ...leg, dep: shiftPoint(leg.dep, delta), arr: shiftPoint(leg.arr, delta) }));
    if (put.stay) {
      const stay = { ...put.stay };
      for (const field of ['fromDayId', 'toDayId']) if (stay[field]) { const day = map('day', stay[field]); if (day) stay[field] = day; else delete stay[field]; }
      put.stay = stay;
    }
    if (put.dayPos) {
      const positions = Object.fromEntries(Object.entries(put.dayPos).flatMap(([dayId, order]) => (map('day', dayId) ? [[map('day', dayId), order]] : [])));
      if (Object.keys(positions).length) put.dayPos = positions; else delete put.dayPos;
    }
    delete put.review;
    add('res', item, withPeople(put, 'people'));
  }
  for (const bag of bags) add('bag', bag, withPeople(strip(bag), 'people'));
  for (const pack of packs) {
    const put = strip(pack);
    delete put.doneBy; delete put.bring; put.done = false;
    if (put.bagId) put.bagId = map('bag', put.bagId);
    if (put.owner) { const owner = person(put.owner); if (owner) put.owner = owner; else delete put.owner; }
    add('pack', pack, withPeople(put, 'for'));
  }
  for (const item of lists) add('listMeta', item, withPeople(strip(item), 'assignees'));
  for (const todo of todos) {
    const put = { ...strip(todo), done: false };
    if (put.who) { const who = person(put.who); if (who) put.who = who; else delete put.who; }
    add('todo', todo, put);
  }
  for (const note of collabNotes) add('note', note, strip(note));
  for (const link of links) add('link', link, strip(link));
  return out;
}
