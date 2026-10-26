import { s, safeKey } from './dsl.js';
import { isId, isUuid } from '../ids.js';
import { isOrder } from '../order.js';
import { isDate, isTime, isTimeZone } from '../dates.js';
import { isCurrency } from '../money.js';
import { validatePermissions } from '../perms.js';
import { isLinkKey } from '../file-links.js';

export const optional = s.optional;
export const name = s.string(500, { nonempty: true });
export const text = s.string(100_000);
export const short = s.string(500);
export const id = s.custom(isId, 'id');
export const uid = s.custom(isUuid, 'uuid');
export const person = s.custom((value) => isId(value) || isUuid(value), 'person');
export const order = s.custom(isOrder, 'order');
export const date = s.custom(isDate, 'date');
export const time = s.custom(isTime, 'time');
export const tz = s.custom(isTimeZone, 'timezone');
export const currency = s.custom(isCurrency, 'currency');
export const amount = s.integer();
export const nonnegative = s.integer(0);
export const color = s.union(s.integer(1, 8), s.string(32, { pattern: /^(?:#[0-9a-fA-F]{6}|[a-z][a-z0-9-]{0,30})$/ }));
export const role = s.enum('owner', 'editor', 'viewer');
export const transport = s.enum('walk', 'drive', 'bike', 'transit', 'plugin');
export const web = s.custom((value) => {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020]/.test(value)) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'url');
export const icon = s.string(64, { pattern: /^[a-z][a-z0-9-]{0,63}$/ });
export const rate = s.nullable(s.custom((value) => typeof value === 'string' && value.length <= 80
  && /^(?:0|[1-9]\d{0,50})(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value), 'rate'));
export const people = s.array(person, 50);
export const tags = s.array(s.string(100, { nonempty: true }), 100);
export const perUser = (value) => s.record(value, isUuid, 50);
export const point = s.object({ name: optional(short), address: optional(s.string(2000)), lat: optional(s.number(-90, 90)), lng: optional(s.number(-180, 180)) }, {
  refine: (value) => Object.hasOwn(value, 'lat') === Object.hasOwn(value, 'lng'),
});
export const localDateTime = s.object({ date, time: optional(time), tz: optional(tz) });
export const ref = s.object({ w: s.string(16, { pattern: /^trips-[a-z0-9]{10}$/ }), s: id, k: s.enum('trip', 'collection', 'journey') });
export const entityLink = s.object({ t: s.string(32, { pattern: /^[a-z][a-zA-Z0-9]*$/ }), id: s.union(id, uid, s.literal('meta')) });
export const links = s.array(entityLink, 200);
/** File links as one path per link, `{<t>_<id>: true}` (src/shared/file-links.js). */
export const linkSet = s.record(s.literal(true), isLinkKey, 200);
export const cover = s.union(id, s.object({ url: web, credit: optional(short) }));
export const permissions = s.custom((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) return false;
  try { return validatePermissions(value); } catch { return false; }
}, 'permissions');
export const namedRecord = (value, max = 100) => s.record(value, safeKey, max);

export const placeFields = {
  name, desc: optional(text), notes: optional(text), address: optional(s.string(2000)),
  lat: optional(s.number(-90, 90)), lng: optional(s.number(-180, 180)), tz: optional(tz),
  cc: optional(s.string(2, { pattern: /^[A-Z]{2}$/ })), admin1: optional(s.string(32)),
  cat: optional(s.union(id, s.string(64, { pattern: /^[a-z][a-z0-9-]*$/ }))),
  tags: optional(perUser(tags)), price: optional(s.object({ amount, currency })),
  web: optional(web), phone: optional(s.string(100)),
  img: optional(s.union(s.object({ fileId: id }), s.object({ url: web, credit: optional(short), license: optional(short) }))),
  ids: optional(s.object({ osm: optional(short), wikidata: optional(short), google: optional(short), photon: optional(short) })),
  src: optional(short),
  track: optional(s.object({ fileId: id, color: optional(color), km: optional(s.number(0, 100_000)) })),
  stop: optional(s.object({ type: s.enum('fuel', 'charge', 'rest'), fill: optional(s.number(0, 1)) })),
  rating: optional(perUser(s.integer(1, 5))), visited: optional(perUser(s.literal(true))),
};
