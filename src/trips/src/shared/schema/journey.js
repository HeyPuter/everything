import { s } from './dsl.js';
import * as f from './fields.js';
import { tripSchemas } from './trip.js';
import { isId } from '../ids.js';

const o = s.optional;
const bool = s.boolean();
// Photo-book elements: geometry is a fraction of the page (or spread) trim box. Value lists live in worker/ops/journey/bookPage.js.
const word = s.string(32);
const bookElement = s.object({
  k: word, x: s.number(-1, 2), y: s.number(-1, 2), w: s.number(0, 3), h: s.number(0, 3), z: s.integer(0, 100_000), lock: o(bool),
  file: o(f.id), fit: o(word), fx: o(s.number(0, 1)), fy: o(s.number(0, 1)), zoom: o(s.number(1, 5)), filter: o(word),
  radius: o(s.number(0, 200)), frame: o(s.number(0, 50)), frameColor: o(word), opacity: o(s.number(0, 1)),
  text: o(s.string(4000)), style: o(word), size: o(s.number(4, 400)), align: o(word), font: o(word), bold: o(bool), italic: o(bool),
  color: o(word), fill: o(word), stroke: o(s.number(0, 50)), shape: o(word), icon: o(f.icon), cc: o(s.string(2, { pattern: /^[A-Z]{2}$/ })),
  scope: o(word), stat: o(word), entry: o(f.id),
});
export const journeySchemas = Object.freeze({
  meta: s.object({
    title: f.name, subtitle: o(f.short), cover: o(f.cover), status: o(f.short),
    trips: o(s.array(f.ref, 500)), fields: o(s.object({ mood: o(bool), weather: o(bool), prosCons: o(bool) })), showTracks: o(bool),
    share: o(s.object({ on: o(bool), exp: o(s.nullable(f.nonnegative)), timeline: o(bool), gallery: o(bool), map: o(bool), newestFirst: o(bool), since: o(f.nonnegative) })),
  }),
  entry: s.object({
    type: f.short, date: f.date, time: o(f.time), title: f.name, story: o(f.text),
    loc: o(s.object({ name: o(f.short), lat: o(s.number(-90, 90)), lng: o(s.number(-180, 180)), cc: o(s.string(2, { pattern: /^[A-Z]{2}$/ })) })),
    mood: o(f.short), weather: o(f.short), tags: o(f.tags), pros: o(s.array(f.short, 100)), cons: o(s.array(f.short, 100)),
    vis: o(f.short), order: f.order, excluded: o(bool), dismissed: o(bool),
    src: o(s.object({ trip: o(f.ref), placeId: o(f.id), visitId: o(f.id) })), media: o(s.array(f.id, 200)),
  }),
  book: s.object({
    title: o(f.short), fmt: o(word), w: o(s.number(50, 600)), h: o(s.number(50, 600)), font: o(word), bg: o(word), fileId: o(f.id),
  }),
  bookPage: s.object({ book: f.id, kind: word, order: f.order, layout: o(word), bg: o(word), els: o(s.record(bookElement, isId, 80)) }),
  file: tripSchemas.file,
  member: s.object({ name: f.name, role: f.role, color: o(f.color), avatar: o(f.web) }),
});
