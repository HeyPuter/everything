// Changes the assistant proposes. A proposal is planned against the replica as it is now and carries both the preview
// rows the user approves and the writes that apply it. Approval plans it again: if the preview would differ (someone
// changed the trip meanwhile), the new one is shown instead of applying writes the user has not seen.
import { buildTimeline, indexForTime, placeAt } from '../../timeline/index.js';
import { registerDomainAdapter } from '../../store/index.js';
import { inverseOps } from '../../store/history.js';
import { t } from '../../i18n/index.js';
import { validateEntity } from '../../../shared/schema/index.js';
import { addDays, daysBetween, isDate } from '../../../shared/dates.js';
import { newId } from '../../../shared/ids.js';
import { LIMITS } from '../../../shared/limits.js';
import { distanceMeters } from '../../../shared/geo.js';
import visitMove from '../../../../worker/ops/trip/domain/visitMove.js';
import { planImport, normName } from '../../../views/trip/lists/model.js';
import { guessCategory, isBuiltin } from '../../categories.js';
import { clip } from './data.js';

// The worker's own plan on the local replica, as the Plan tab registers it; registering again replaces it.
registerDomainAdapter('visit.move', (args, { get }) => visitMove.plan({ args, get: (type, id) => get(type, id) ?? null, can: () => true }));

const PERMISSION = Object.freeze({
  propose_add_visits: 'plan.edit', propose_move_visits: 'plan.edit', propose_add_places: 'plan.edit',
  propose_add_packing_items: 'lists.edit', propose_add_todos: 'lists.edit', propose_redate: 'trip.edit',
});
export const proposalPermission = (tool) => PERMISSION[tool] ?? null;

class PlanError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PlanError(code, message); };
const normal = (value) => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

function planData(space) {
  return { days: space.select.day.all(), visits: space.select.visit.all(), notes: space.select.dayNote.all(), reservations: space.select.res.all() };
}
function dayInfo(space, ref) {
  const days = space.select.day.all();
  const index = days.findIndex((day) => day.id === ref || (isDate(ref) && day.date === ref));
  if (index < 0) fail('day_not_found', `No day matches "${clip(ref, 40)}". Use a day id or the date of an existing day.`);
  return { day: days[index], label: { n: index + 1, date: days[index].date ?? null } };
}
const visitName = (space, visit) => clip(visit.placeId ? space.get('place', visit.placeId)?.name ?? visit.title : visit.title, 100) ?? '';

/**
 * Inserts new items into one day's rows. `items` are `{time}`; `position` puts them in a row at that index, otherwise
 * each goes to its slot by time or at the end. Returns the order key per item and the patches that give unpositioned
 * bookings a key (`{t, id, set}`, merged by target).
 */
function insertRows(rows, dayId, items, position) {
  const working = [...rows];
  const patches = new Map();
  const orders = [];
  items.forEach((item, index) => {
    const at = Number.isInteger(position) ? position + index : item.time ? indexForTime(working, item.time) : working.length;
    const { order, writes } = placeAt(working, at, dayId);
    for (const write of writes) {
      patches.set(`${write.t}:${write.id}`, write);
      const target = working.find((row) => row.primary && `${row.kind === 'note' ? 'dayNote' : row.kind}:${row.id}` === `${write.t}:${write.id}`);
      if (target) target.order = Object.values(write.set)[0];
    }
    working.splice(Math.min(at, working.length), 0, { key: `new:${index}`, kind: 'visit', id: `new:${index}`, order, time: item.time ?? null, phase: null, primary: true });
    orders.push(order);
  });
  return { orders, patches: [...patches.values()] };
}
const rowsOf = (data, dayId) => buildTimeline(data).byDay.get(dayId)?.rows.map((row) => ({ ...row })) ?? [];
// Bookings' day positions need booking rights; without them the booking keeps its place by time.
const allowedPatches = (space, patches) => patches.filter((write) => write.t !== 'res' || space.can('res.edit'));

function visitWrites(space, { dayId, items, position, makeId, data = planData(space) }) {
  const { orders, patches } = insertRows(rowsOf(data, dayId), dayId, items.map((item) => ({ time: item.start })), position);
  const creates = items.map((item, index) => {
    const put = { dayId, placeId: item.placeId ?? null, order: orders[index] };
    if (!item.placeId) put.title = item.title;
    for (const key of ['start', 'end', 'notes']) if (item[key] !== undefined) put[key] = item[key];
    return { t: 'visit', id: makeId(), put };
  });
  return [...creates, ...allowedPatches(space, patches)];
}

const builders = {
  propose_add_visits(space, args, env) {
    const { day, label } = dayInfo(space, args.day);
    const items = args.items.map((item) => {
      if (item.place) {
        const place = space.get('place', item.place);
        if (!place) fail('place_not_found', `No place with id ${item.place}. Use list_places, or propose_add_places for a new one.`);
        return { ...item, placeId: place.id, name: clip(place.name, 100) };
      }
      if (!item.title?.trim()) fail('missing_title', 'Each item needs a place id or a title.');
      return { ...item, name: clip(item.title, 100) };
    });
    for (const item of items) if (item.start && item.end && item.end < item.start) fail('end_before_start', `"${item.name}" ends before it starts.`);
    const rowCount = rowsOf(planData(space), day.id).length;
    if (args.position !== undefined && args.position > rowCount) fail('bad_position', `Day ${label.n} has ${rowCount} items; position must be 0 to ${rowCount}.`);
    return {
      title: { key: 'assistant.preview.addVisits', values: { day: label, count: items.length } },
      rows: items.map((item) => ({ sign: 'add', key: item.placeId ? 'assistant.row.visit' : 'assistant.row.item', values: { name: item.name, time: item.start, end: item.end } })),
      writes: visitWrites(space, { dayId: day.id, items, position: args.position, makeId: env.makeId }),
      history: 'assistant.history.addVisits',
    };
  },

  propose_move_visits(space, args) {
    const data = planData(space);
    // Working copies, so later moves see earlier ones (and the booking positions they assigned).
    const visits = data.visits.map((visit) => ({ ...visit }));
    const reservations = data.reservations.map((res) => ({ ...res, dayPos: { ...res.dayPos } }));
    const seen = new Set();
    const writes = [];
    const rows = [];
    const inverse = [];
    for (const move of args.moves) {
      if (seen.has(move.visit)) fail('duplicate_visit', 'A visit is listed more than once.');
      seen.add(move.visit);
      const visit = visits.find((item) => item.id === move.visit);
      if (!visit) fail('visit_not_found', `No visit with id ${move.visit}. Read the day with get_day for visit ids.`);
      const from = dayInfo(space, visit.dayId);
      const to = dayInfo(space, move.day);
      const same = from.day.id === to.day.id;
      const key = `visit:${visit.id}`;
      const dayRows = rowsOf({ ...data, visits, reservations }, to.day.id);
      const others = dayRows.filter((row) => row.key !== key).length;
      const index = move.position ?? others;
      if (index > others) fail('bad_position', `Day ${to.label.n} has ${others} other items; position must be 0 to ${others}.`);
      const { order, writes: patches } = placeAt(dayRows, index, to.day.id, { skip: same ? key : null });
      const original = space.get('visit', visit.id);
      if (same) writes.push({ t: 'visit', id: visit.id, set: { order } });
      else {
        writes.push({ do: 'visit.move', args: { visit: visit.id, day: to.day.id, order } });
        inverse.unshift({ do: 'visit.move', args: { visit: visit.id, day: original.dayId, order: original.order } }, ...(original.endDayId === to.day.id ? [{ t: 'visit', id: visit.id, set: { endDayId: original.endDayId } }] : []));
      }
      for (const write of allowedPatches(space, patches)) {
        if (write.t === 'visit' && write.id === visit.id) continue;
        writes.push(write);
        const res = write.t === 'res' && reservations.find((item) => item.id === write.id);
        if (res) res.dayPos[to.day.id] = Object.values(write.set)[0];
      }
      Object.assign(visit, { dayId: to.day.id, order });
      if (visit.endDayId === to.day.id) delete visit.endDayId;
      rows.push(same
        ? { sign: 'move', key: 'assistant.row.reorder', values: { name: visitName(space, original), day: to.label, position: index + 1 } }
        : { sign: 'move', key: 'assistant.row.move', values: { name: visitName(space, original), from: from.label, to: to.label, position: index + 1 } });
    }
    return { title: { key: 'assistant.preview.moveVisits', values: { count: rows.length } }, rows, writes, inverse, history: 'assistant.history.moveVisits' };
  },

  propose_add_places(space, args, env) {
    const rows = [];
    const writes = [];
    const scheduled = new Map();
    const names = new Set();
    for (const item of args.places) {
      if (names.has(normal(item.name))) fail('duplicate_place', `"${clip(item.name, 60)}" is listed more than once.`);
      names.add(normal(item.name));
      let placeId = item.existing ?? null;
      const name = clip(item.name, 100);
      if (placeId) {
        if (!space.get('place', placeId)) fail('place_changed', 'A place this proposal reused was deleted; propose again.');
        rows.push({ sign: 'skip', key: 'assistant.row.placeExists', values: { name: clip(space.get('place', placeId).name, 100) } });
      } else {
        placeId = env.makeId();
        const found = item.found;
        const cat = item.category && (isBuiltin(item.category) || space.get('cat', item.category)) ? item.category : guessCategory(found?.kind) ?? undefined;
        const put = { name: item.name.trim() };
        if (found) Object.assign(put, { address: found.address || undefined, lat: found.lat, lng: found.lng, tz: found.tz, cc: found.country || undefined, ids: found.ids });
        if (cat) put.cat = cat;
        if (item.notes) put.notes = item.notes;
        put.src = 'ai';
        const fields = Object.fromEntries(Object.entries(put).filter(([, value]) => value !== undefined));
        try { validateEntity('trip', 'place', fields); } catch { fail('invalid_place', `"${name}" could not be saved as a place.`); }
        writes.push({ t: 'place', id: placeId, put: fields });
        rows.push(found
          ? { sign: 'add', key: 'assistant.row.place', values: { name, address: clip(found.address, 120) ?? '' } }
          : { sign: 'warn', key: 'assistant.row.placeNoLocation', values: { name } });
      }
      if (item.day) {
        const { day, label } = dayInfo(space, item.day);
        if (!scheduled.has(day.id)) scheduled.set(day.id, { label, items: [] });
        scheduled.get(day.id).items.push({ placeId, start: item.start, end: item.end, name });
      }
    }
    // New places are not in the replica yet, so their visits are planned on the day rows as they are now.
    for (const [dayId, { label, items }] of scheduled) {
      writes.push(...visitWrites(space, { dayId, items, makeId: env.makeId }));
      for (const item of items) rows.push({ sign: 'add', key: 'assistant.row.schedule', values: { name: item.name, day: label, time: item.start, end: item.end } });
    }
    return { title: { key: 'assistant.preview.addPlaces', values: { count: args.places.length } }, rows, writes, history: 'assistant.history.addPlaces' };
  },

  propose_add_packing_items: (space, args, env) => listProposal(space, 'pack', args, env),
  propose_add_todos: (space, args, env) => listProposal(space, 'todo', args, env),

  propose_redate(space, args) {
    const meta = space.get('meta', 'meta') ?? {};
    const length = isDate(meta.start) ? (isDate(meta.end) ? daysBetween(meta.start, meta.end) + 1 : 1) : Math.max(1, space.select.day.all().length || meta.dayCount || 1);
    const end = args.end ?? addDays(args.start, length - 1);
    if (end < args.start) fail('end_before_start', 'The end date is before the start date.');
    if (daysBetween(args.start, end) >= LIMITS.tripDays) fail('too_long', `A trip can be at most ${LIMITS.tripDays} days.`);
    if (args.start === meta.start && end === meta.end) fail('unchanged', 'Those are already the trip dates.');
    const notes = [];
    if (isDate(meta.start) && args.start !== meta.start) notes.push({ key: 'assistant.note.shift', values: { days: daysBetween(meta.start, args.start) } });
    const next = daysBetween(args.start, end) + 1;
    if (next !== length) notes.push({ key: 'assistant.note.length', values: { from: length, to: next } });
    return {
      title: { key: 'assistant.preview.redate', values: {} },
      rows: [{ sign: 'change', key: isDate(meta.start) ? 'assistant.row.dates' : 'assistant.row.datesNew', values: { fromStart: meta.start ?? null, fromEnd: meta.end ?? null, toStart: args.start, toEnd: end } }],
      notes, writes: [], suggestion: { start: args.start, end }, history: null,
    };
  },
};

function listProposal(space, kind, args, env) {
  const existing = space.select[kind].all();
  const metas = space.select.listMeta.all().filter((meta) => meta.kind === kind);
  const known = new Set(existing.map((item) => `${normName(item.list)}\u0000${normName(item.name)}`));
  const rows = [];
  const fresh = [];
  for (const item of args.items) {
    const key = `${normName(item.list)}\u0000${normName(item.name)}`;
    if (known.has(key)) { rows.push({ sign: 'skip', key: `assistant.row.${kind}Exists`, values: { name: clip(item.name, 100), list: clip(item.list, 80) } }); continue; }
    known.add(key);
    fresh.push(item);
  }
  if (!fresh.length) fail('nothing_new', 'Every item is already on the list.');
  // planImport returns items grouped by list in order of first appearance; group them the same way first.
  const groups = new Map();
  for (const item of fresh) groups.set(normName(item.list), [...(groups.get(normName(item.list)) ?? []), item]);
  fresh.splice(0, fresh.length, ...[...groups.values()].flat());
  const plan = planImport(fresh.map((item) => ({ name: item.name, list: item.list ?? '', qty: item.qty, prio: item.priority })), { kind, metas, items: existing, bags: [], makeId: env.makeId, createBags: false, withBags: false });
  const writes = [
    ...plan.moves.map((move) => ({ t: move.type, id: move.item.id, set: { order: move.order } })),
    ...plan.lists.map((list) => ({ t: 'listMeta', id: env.makeId(), put: list })),
    ...plan.items.map((fields, index) => {
      const source = fresh[index];
      const put = { ...fields };
      if (kind === 'pack') {
        put.owner = env.uid;
        if (args.assignToMe) Object.assign(put, { vis: 'people', for: [env.uid] });
      } else {
        if (source.due) put.due = source.due;
        if (source.notes) put.desc = source.notes;
      }
      return { t: kind, id: env.makeId(), put };
    }),
  ];
  for (const list of plan.lists) rows.push({ sign: 'add', key: 'assistant.row.newList', values: { name: clip(list.name, 80) } });
  plan.items.forEach((fields, index) => rows.push({
    sign: 'add', key: `assistant.row.${kind}`,
    values: { name: clip(fields.name, 100), qty: fields.qty, list: clip(fields.list, 80), due: fresh[index].due, assigned: kind === 'pack' && args.assignToMe ? true : undefined },
  }));
  return {
    title: { key: kind === 'pack' ? 'assistant.preview.addPacking' : 'assistant.preview.addTodos', values: { count: plan.items.length } },
    rows, writes, history: kind === 'pack' ? 'assistant.history.addPacking' : 'assistant.history.addTodos',
  };
}

/** Network lookups a proposal needs before it can be planned (places on the map). Returns resolved arguments. */
export async function resolveProposal(tool, args, env) {
  if (tool !== 'propose_add_places') return args;
  const { space, services, reader, signal } = env;
  const places = space.select.place.all();
  const center = reader.center();
  const out = [];
  for (const item of args.places) {
    const same = places.find((place) => normal(place.name) === normal(item.name));
    if (same) { out.push({ ...item, existing: same.id }); continue; }
    let found = null;
    if (services?.geocode?.search) {
      try {
        const result = await services.geocode.search(item.query ? `${item.name}, ${item.query}` : item.name, { ...(center ? { bias: { lat: center.lat, lng: center.lng, zoom: 10 } } : {}), signal });
        const hit = result?.data?.find((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lng));
        if (hit) {
          const osm = hit.osm?.type && hit.osm?.id ? `${hit.osm.type}/${hit.osm.id}` : undefined;
          const ids = osm || hit.wikidata ? { ...(osm ? { osm } : {}), ...(hit.wikidata ? { wikidata: hit.wikidata } : {}) } : undefined;
          found = { name: clip(hit.name, 200), address: clip(hit.address, 500), lat: hit.lat, lng: hit.lng, country: /^[A-Z]{2}$/.test(hit.country ?? '') ? hit.country : undefined, ids, kind: hit.kind };
          try { found.tz = services.tz ? await services.tz.zoneAt(hit.lat, hit.lng) : undefined; } catch { found.tz = undefined; }
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
      }
    }
    const near = found && places.find((place) => (found.ids?.osm && place.ids?.osm === found.ids.osm)
      || (Number.isFinite(place.lat) && normal(place.name) === normal(found.name) && distanceMeters(place, found) < 150));
    out.push(near ? { ...item, existing: near.id } : { ...item, found });
  }
  return { ...args, places: out };
}

/** `{ok: true, proposal}` or `{ok: false, code, error}` (a message for the model). Synchronous; no lookups. */
export function buildProposal(tool, args, env) {
  const permission = PERMISSION[tool];
  if (!permission || !builders[tool]) return { ok: false, code: 'unknown_tool', error: `There is no tool called ${tool}.` };
  if (!env.space.can(permission)) return { ok: false, code: 'not_allowed', error: 'The user cannot make this change in this trip with their role.' };
  try {
    const plan = builders[tool](env.space, args, { ...env, makeId: env.makeId ?? newId });
    if (!plan.writes.length && !plan.suggestion) return { ok: false, code: 'nothing_to_do', error: 'This would change nothing.' };
    return { ok: true, proposal: Object.freeze({ tool, args, notes: [], ...plan, signature: JSON.stringify([plan.title, plan.rows, plan.notes ?? []]) }) };
  } catch (error) {
    if (error instanceof PlanError) return { ok: false, code: error.code, error: error.message };
    throw error;
  }
}

/** Resolves and plans in one go. */
export async function planProposal(tool, args, env) {
  if (!PERMISSION[tool]) return { ok: false, code: 'unknown_tool', error: `There is no tool called ${tool}.` };
  if (!env.space.can(PERMISSION[tool])) return { ok: false, code: 'not_allowed', error: 'The user cannot make this change in this trip with their role.' };
  return buildProposal(tool, await resolveProposal(tool, args, env), env);
}

/** The proposal's writes as store ops, with undo ops when it includes domain ops. */
export function proposalOps(space, proposal) {
  const ops = proposal.writes.map((write) => {
    if (write.do) return space.ops.domain(write.do, write.args);
    if (write.put) return space.ops.create(write.t, write.put, { id: write.id });
    return space.ops.patch(write.t, write.id, { set: write.set, unset: write.unset });
  });
  if (!proposal.writes.some((write) => write.do)) return { ops };
  const generic = ops.filter((op) => !op.do);
  const back = inverseOps(generic, (type, id) => space.get(type, id));
  return { ops, inverse: back ? [...(proposal.inverse ?? []), ...back] : undefined };
}

/** New entities by type, for the model: `{place: [{id, name}], visit: [...]}`. */
export function createdIds(proposal) {
  const out = {};
  for (const write of proposal.writes) {
    if (!write.put) continue;
    (out[write.t] ??= []).push({ id: write.id, name: clip(write.put.name ?? write.put.title, 80) });
  }
  return out;
}

/**
 * Applies an approved proposal as one undoable step. Plans it again first: `{status: 'changed', proposal}` when the
 * preview would differ, `{status: 'failed', error}` when it no longer applies, otherwise `{status: 'applied', created}`.
 */
export async function applyProposal(proposal, env) {
  const again = buildProposal(proposal.tool, proposal.args, env);
  if (!again.ok) return { status: 'failed', code: again.code, error: again.error };
  if (again.proposal.signature !== proposal.signature) return { status: 'changed', proposal: again.proposal };
  const next = again.proposal;
  if (next.suggestion) return { status: 'suggested', suggestion: next.suggestion };
  const { ops, inverse } = proposalOps(env.space, next);
  await env.space.apply(ops, { history: t(next.history), ...(inverse ? { inverse } : {}) });
  return { status: 'applied', proposal: next, created: createdIds(next) };
}
