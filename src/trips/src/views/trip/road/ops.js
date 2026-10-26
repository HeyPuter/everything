import { t } from '../../../lib/i18n/index.js';
import { placeAt } from '../../../lib/timeline/index.js';
import { ROAD_PREFS_ID, prefsChange } from '../../../lib/road/index.js';
import { orderBetween } from '../../../shared/order.js';
import { createActions, timelineOf } from '../plan/ops.js';

// Places found along the route: plan category and service-stop type per search category.
export const RESULT_PLACE = Object.freeze({
  fuel: { cat: 'transport', stop: 'fuel', dwell: 15 }, charging: { cat: 'transport', stop: 'charge', dwell: 40 }, rest: { cat: 'transport', stop: 'rest' },
  camping: { cat: 'hotel' }, lodging: { cat: 'hotel' }, food: { cat: 'restaurant' }, sights: { cat: 'attraction' },
});

/** Road-trip writes. Each resolves after the change is applied locally; worker refusals become conflicts. */
export function createRoadOps(space) {
  const actions = createActions(space, { label: (key) => t(`plan.history.${key}`) });
  const history = (key) => ({ history: t(`road.history.${key}`) });
  const rowsOf = (dayId) => timelineOf(space).byDay.get(dayId)?.rows ?? [];
  const keep = (writes) => writes.filter((write) => write.t !== 'res' || space.can('res.edit'));
  const patches = (writes) => keep(writes).map((write) => space.ops.patch(write.t, write.id, { set: write.set, unset: write.unset }));
  const rowIndex = (rows, node) => rows.findIndex((row) => row.primary && row.id === node.id && (node.kind === 'visit' ? row.kind === 'visit' : row.kind === 'res'));

  async function setPrefs(changes, { label = true } = {}) {
    const stored = space.get('rtPrefs', ROAD_PREFS_ID);
    const change = prefsChange(stored, changes);
    if (!change) return;
    // A create stays out of undo: a redone create would get a new id, and only the fixed id is accepted.
    if (change.create) await space.apply([space.ops.create('rtPrefs', change.create, { id: ROAD_PREFS_ID })]);
    else await space.apply([space.ops.patch('rtPrefs', ROAD_PREFS_ID, { set: change.set, unset: change.unset })], label ? history('prefs') : {});
  }

  /** Turns road-trip mode on or off; turning it on also makes walking days (the default mode) driving days. */
  async function setMode(on) {
    const ops = [space.ops.patch('meta', 'meta', { set: { 'settings.addons.roadtrip': on } })];
    if (on && space.can('plan.edit')) {
      for (const day of space.select.day.all()) if (!day.mode || day.mode === 'walk') ops.push(space.ops.patch('day', day.id, { set: { mode: 'drive' } }));
    }
    await space.apply(ops, history(on ? 'modeOn' : 'modeOff'));
  }

  /** Puts the night of a leg at `fraction`, updating the day end already there. */
  async function placeNight(chain, leg, fraction, existingId = null) {
    const value = Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 1000;
    if (existingId && space.get('dayEnd', existingId)) {
      await space.apply([space.ops.patch('dayEnd', existingId, { set: { fraction: value } })], history('night'));
      return;
    }
    const from = chain.nodes[leg.from]; const to = chain.nodes[leg.to];
    await space.apply([space.ops.create('dayEnd', { day: from.dayId, fromVisit: from.id, toVisit: to.id, fraction: value })], history('night'));
  }
  const removeEntity = (type, id) => space.apply([space.ops.remove(type, id)]);

  /** Moves the visits after `node` on its day to the start of the next day, in one undoable step. */
  async function endDayHere(view, node) {
    const days = view.days;
    const index = days.findIndex((day) => day.id === node.dayId);
    const next = days[index + 1];
    if (!next) return false;
    const rows = rowsOf(node.dayId);
    const at = rowIndex(rows, node);
    const moving = rows.slice(at + 1).filter((row) => row.kind === 'visit' && row.primary && row.phase === null).map((row) => row.entity);
    if (!moving.length) return false;
    const { orders, writes } = placeAt(rowsOf(next.id), 0, next.id, { count: moving.length });
    const ops = moving.map((visit, position) => space.ops.domain('visit.move', { visit: visit.id, day: next.id, order: orders[position] }));
    const inverse = moving.map((visit) => ({ do: 'visit.move', args: { visit: visit.id, day: visit.dayId, order: visit.order } }));
    await space.apply([...ops, ...patches(writes)], { ...history('endDay'), inverse });
    return moving.length;
  }

  /**
   * The day and timeline index where a stop on `leg` goes: after its start on the start's day, or before its end on the
   * end's day when the leg leaves a night's stay or the stop lies after the leg's night (`fraction` ≥ `night`).
   */
  function slotFor(chain, leg, { fraction = 0, night = null } = {}) {
    const from = chain.nodes[leg.from]; const to = chain.nodes[leg.to];
    const afterNight = leg.dayIndex > from.day && (night === null || fraction >= night);
    if (from.kind !== 'stay' && !afterNight) {
      const dayId = from.dayId; const rows = rowsOf(dayId); const at = rowIndex(rows, from);
      return { dayId, index: at === -1 ? rows.length : at + 1 };
    }
    const dayId = to.dayId; const rows = rowsOf(dayId); const at = rowIndex(rows, to);
    return { dayId, index: at === -1 ? 0 : at };
  }

  /** Adds a found place (or an existing one) as a stop on `leg`. */
  async function insertStop(chain, leg, { result = null, placeId = null, prefs, fraction, night }) {
    const { dayId, index } = slotFor(chain, leg, { fraction, night });
    const ops = [];
    let id = placeId;
    const kind = result ? RESULT_PLACE[result.category] ?? {} : {};
    if (!id) {
      const fields = {
        name: result.name || t(`road.category.${result.category}`), lat: Number(result.lat.toFixed(6)), lng: Number(result.lng.toFixed(6)), src: 'road',
        ...(result.address ? { address: result.address.slice(0, 2000) } : {}), ...(kind.cat ? { cat: kind.cat } : {}),
        ...(kind.stop ? { stop: { type: kind.stop } } : {}), ...(result.osm ? { ids: { osm: `${result.osm.type}/${result.osm.id}` } } : {}),
        ...(/^[A-Z]{2}$/.test(result.country ?? '') ? { cc: result.country } : {}),
      };
      const create = space.ops.create('place', fields);
      ops.push(create); id = create.id;
    }
    const { order, writes } = placeAt(rowsOf(dayId), index, dayId);
    const dwell = kind.stop === 'rest' ? prefs?.pause || 20 : kind.dwell;
    ops.push(space.ops.create('visit', { dayId, placeId: id, order, ...(dwell ? { dwell } : {}) }), ...patches(writes));
    await space.apply(ops, history('addStop'));
    return { dayId, placeId: id };
  }

  /** A route point on `leg` (which must leave a visit), after the leg's other points. */
  async function addVia(chain, leg, point) {
    const from = chain.nodes[leg.from];
    if (from.kind !== 'visit') return false;
    const last = space.select.via.all().filter((via) => via.after === from.id).map((via) => via.order).sort().at(-1) ?? null;
    await space.apply([space.ops.create('via', { dayId: from.dayId, after: from.id, order: orderBetween(last, null), lat: Number(point[1].toFixed(6)), lng: Number(point[0].toFixed(6)) })], history('via'));
    return true;
  }

  const setDwell = (visit, minutes) => space.apply([space.ops.patch('visit', visit.id, minutes === null ? { unset: ['dwell'] } : { set: { dwell: minutes } })], history('stay'));

  function setService(place, type, fill = null) {
    if (!type) return space.apply([space.ops.patch('place', place.id, { unset: ['stop'] })], history('service'));
    return space.apply([space.ops.patch('place', place.id, { set: { stop: { type, ...(fill === null ? {} : { fill }) } } })], history('service'));
  }

  /** A day's route choice: an `ALTERNATIVES` avoid list, or null for the trip default. */
  async function setDayRoute(dayId, avoid) {
    const stored = space.get('rtPrefs', ROAD_PREFS_ID);
    if (avoid === null) {
      if (stored?.dayAvoid && Object.hasOwn(stored.dayAvoid, dayId)) await space.apply([space.ops.patch('rtPrefs', ROAD_PREFS_ID, { unset: [`dayAvoid.${dayId}`] })], history('route'));
      return;
    }
    if (!stored) await space.apply([space.ops.create('rtPrefs', { dayAvoid: { [dayId]: avoid } }, { id: ROAD_PREFS_ID })]);
    else await space.apply([space.ops.patch('rtPrefs', ROAD_PREFS_ID, { set: { [`dayAvoid.${dayId}`]: avoid } })], history('route'));
  }

  async function setDayTrack(dayId, placeId, strayKm) {
    const current = space.select.dayTrack.all().find((item) => item.dayId === dayId);
    if (!placeId) { if (current) await removeEntity('dayTrack', current.id); return; }
    if (current) await space.apply([space.ops.patch('dayTrack', current.id, { set: { placeId, strayKm } })], history('track'));
    else await space.apply([space.ops.create('dayTrack', { dayId, placeId, strayKm })], history('track'));
  }

  /** Moves a visit stop before `before` (a node on `dayId`), or to the end of that day. */
  async function moveNode(node, dayId, before = null) {
    const row = rowsOf(node.dayId).find((item) => item.kind === 'visit' && item.id === node.id && item.primary);
    if (!row) return;
    const rows = rowsOf(dayId).filter((item) => item.key !== row.key);
    // Stays are not timeline rows: a morning stay opens the day and an evening one closes it.
    const at = !before ? -1 : before.kind === 'stay' ? (before.morning || before.leaveDay === before.day ? 0 : -1) : rowIndex(rows, before);
    await actions.moveRow(row, node.dayId, dayId, at === -1 ? rows.length : at);
  }

  return { setPrefs, setMode, placeNight, removeEntity, endDayHere, insertStop, slotFor, addVia, setDwell, setService, setDayRoute, setDayTrack, moveNode };
}
