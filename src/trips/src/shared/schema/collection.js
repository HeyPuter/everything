import { s } from './dsl.js';
import * as f from './fields.js';
import { tripSchemas } from './trip.js';

const o = s.optional;
export const collectionSchemas = Object.freeze({
  meta: s.object({ name: f.name, desc: o(f.text), color: o(f.color), icon: o(f.icon), cover: o(f.cover), links: o(f.links),
    urls: o(s.array(s.object({ url: f.web, title: o(f.short) }), 50)), share: o(s.object({ on: o(s.boolean()), exp: o(s.nullable(f.nonnegative)) })) }),
  saved: s.object({
    ...f.placeFields,
    status: s.enum('idea', 'want', 'visited', 'revisit'), labels: o(s.array(f.id, 100)),
    src: o(s.object({ trip: f.ref, placeId: f.id })), links: o(f.links), order: f.order,
  }, { refine: (value) => Object.hasOwn(value, 'lat') === Object.hasOwn(value, 'lng') }),
  label: s.object({ name: f.name, color: o(f.color), order: f.order }),
  file: tripSchemas.file,
  member: s.object({ name: f.name, role: f.role, color: o(f.color), avatar: o(f.web) }),
});
