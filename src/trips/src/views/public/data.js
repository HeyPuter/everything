import { createSelectors } from '../../lib/store/query.js';
import { validateEntity } from '../../shared/schema/index.js';
import { isId, isUuid } from '../../shared/ids.js';
import { isDate } from '../../shared/dates.js';
import { isCurrency } from '../../shared/money.js';
import { safeURL } from '../../ui/dom.js';
import { ROAD_PREFS_ID } from '../../shared/schema/trip.js';
import { cleanJourneyLink } from './combined/index.js';

/** Entity types a public trip projection may carry. Anything else is dropped. */
export const PUBLIC_TYPES = Object.freeze(['day', 'visit', 'place', 'dayNote', 'cat', 'guest', 'res', 'exp', 'settle', 'costCat', 'pack', 'bag', 'listMeta', 'msg', 'rtPrefs', 'via', 'dayEnd']);
const TOGGLES = ['plan', 'map', 'bookings', 'codes', 'packing', 'costs', 'chat', 'files', 'road'];
const MIME = /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

function cleanMeta(meta) {
  const value = meta && typeof meta === 'object' ? meta : {};
  const out = { title: text(value.title, 500) || '', currency: isCurrency(value.currency) ? value.currency : null };
  if (typeof value.description === 'string') out.description = value.description.slice(0, 100_000);
  if (isDate(value.start)) out.start = value.start;
  if (isDate(value.end)) out.end = value.end;
  if (Number.isInteger(value.dayCount) && value.dayCount > 0) out.dayCount = value.dayCount;
  if (Array.isArray(value.tags)) out.tags = value.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.slice(0, 100)).slice(0, 100);
  if (value.settings?.addons?.roadtrip === true) out.settings = { addons: { roadtrip: true } };
  if (isId(value.cover)) out.cover = value.cover;
  else if (safeURL(value.cover?.url)) out.cover = { url: safeURL(value.cover.url), ...(typeof value.cover.credit === 'string' ? { credit: value.cover.credit.slice(0, 500) } : {}) };
  return out;
}

function cleanShare(share) {
  const value = share && typeof share === 'object' ? share : {};
  const out = Object.fromEntries(TOGGLES.map((key) => [key, value[key] === true]));
  out.cur = isCurrency(value.cur) ? value.cur : null;
  out.exp = Number.isSafeInteger(value.exp) ? value.exp : null;
  return out;
}

function cleanFile(entity) {
  if (!isId(entity.id) || typeof entity.name !== 'string' || !entity.name || !MIME.test(entity.mime ?? '') || !Number.isSafeInteger(entity.size)) return null;
  const links = Array.isArray(entity.links) ? entity.links.filter((link) => typeof link?.t === 'string' && typeof link?.id === 'string').map(({ t, id }) => ({ t, id })) : [];
  return Object.freeze({ t: 'file', id: entity.id, name: entity.name.slice(0, 500), mime: entity.mime, size: entity.size, links });
}

/** Validates an entity against the trip schema; projections omit stamps, so only `id`, `t` and `cr` are added back. */
function cleanEntity(entity) {
  if (!entity || typeof entity !== 'object' || !PUBLIC_TYPES.includes(entity.t) || !isId(entity.id) || (entity.t === 'rtPrefs' && entity.id !== ROAD_PREFS_ID)) return null;
  const { t, id, cr, ...fields } = entity;
  try { validateEntity('trip', t, fields); } catch { return null; }
  return Object.freeze({ ...fields, t, id, ...(Number.isSafeInteger(cr) ? { cr } : {}) });
}

/**
 * The `GET /pub` body checked as untrusted input (the worker belongs to the trip owner): known types that pass the
 * schema, http(s) cover links and plain people. Returns `{rev, at, share, meta, members, ents, files}`.
 */
export function cleanProjection(data) {
  const value = data && typeof data === 'object' ? data : {};
  const ents = [];
  const files = new Map();
  for (const entity of Array.isArray(value.ents) ? value.ents : []) {
    if (entity?.t === 'file') { const file = cleanFile(entity); if (file) files.set(file.id, file); continue; }
    const clean = cleanEntity(entity);
    if (clean) ents.push(clean);
  }
  const servable = new Set((Array.isArray(value.files) ? value.files : []).filter((id) => isId(id) && files.has(id)));
  const members = (Array.isArray(value.members) ? value.members : [])
    .filter((member) => isUuid(member?.id) && typeof member.name === 'string')
    .map((member) => Object.freeze({ id: member.id, uid: member.id, name: member.name.slice(0, 500), ...(Number.isInteger(member.color) ? { color: member.color } : {}) }));
  return Object.freeze({
    rev: Number.isSafeInteger(value.rev) ? value.rev : 0,
    at: Number.isSafeInteger(value.at) ? value.at : 0,
    share: Object.freeze(cleanShare(value.share)),
    meta: Object.freeze(cleanMeta(value.meta)),
    members: Object.freeze(members),
    ents: Object.freeze(ents),
    files: Object.freeze([...files.values()].filter((file) => servable.has(file.id))),
    journey: cleanJourneyLink(value.journey),
  });
}

const reject = () => Promise.reject(Object.assign(new Error('read_only'), { code: 'read_only', status: 403 }));
const noop = () => () => {};

/**
 * A read-only stand-in for an `openSpace` handle over a projection, enough for the planner map and the shared
 * selectors: `select`, `get`, `members`, `can` (always false) and inert subscriptions. Writes reject.
 */
export function readOnlySpace(projection, ref) {
  const byType = new Map();
  const index = new Map();
  for (const entity of [...projection.ents, ...projection.files]) {
    if (!byType.has(entity.t)) byType.set(entity.t, []);
    byType.get(entity.t).push(entity);
    index.set(`${entity.t}:${entity.id}`, entity);
  }
  for (const [type, list] of byType) byType.set(type, Object.freeze(list));
  const empty = Object.freeze([]);
  const source = (type) => byType.get(type) ?? empty;
  const meta = Object.freeze({ ...projection.meta, t: 'meta', id: 'meta' });
  const get = (type, id) => (type === 'meta' ? (id === 'meta' ? meta : undefined) : index.get(`${type}:${id}`));
  const members = Object.freeze(projection.members.map((member) => Object.freeze({ ...member, role: 'viewer', active: false })));
  const state = Object.freeze({ path: 'public', sync: 'synced', issue: null, skipped: 0, rev: projection.rev, pending: 0, conflicts: empty, handles: null });
  const history = Object.freeze({ canUndo: false, canRedo: false, label: () => '', undo: reject, redo: reject, subscribe: noop });
  const refuse = () => { throw Object.assign(new Error('read_only'), { code: 'read_only' }); };
  return Object.freeze({
    ref, kind: 'trip', role: 'viewer', public: true, state, history,
    select: createSelectors({ kind: 'trip', source, get, subscribe: noop }),
    get, query: (type) => source(type), members: () => members,
    can: () => false, subscribe: noop, onState: noop, overlay: () => ({ pending: false, local: false, conflict: null }),
    conflicts: () => empty, resolveConflict: reject, apply: reject, flush: () => {}, setView: () => {},
    ops: Object.freeze({ create: refuse, patch: refuse, remove: refuse, domain: refuse }),
  });
}

/** Display name for a person id in a projection: member, guest or former member. */
export function personName(space, id, { former, guest }) {
  const member = space.members().find((item) => item.id === id);
  if (member) return member.name;
  const found = space.get('guest', id);
  return found ? guest(found.name) : former;
}
