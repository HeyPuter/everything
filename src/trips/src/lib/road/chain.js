import { isTime, timeMinutes } from '../../shared/dates.js';
import { ARRIVAL_BUFFER, DEPARTURE_BUFFER, bookingDwell, visitDwell } from '../schedule/dwell.js';
import { distance } from './geo.js';
import { resEnd, resStart } from '../route-plan/model.js';

// The whole trip as one chain of stops and legs, built from the route planner's per-day stop sequences
// (`createTripModel().dayStops`), so the order matches the days view.

/** Hire vehicles you drive yourself: their pick-up and drop-off are stops, and the drive goes on between them. */
export const RENTALS = Object.freeze(['car', 'bike']);
const LEG_MODES = ['walk', 'bike', 'transit'];
// Rough km/h when a booked transport has no arrival time.
const TRANSPORT_SPEED = Object.freeze({ flight: 700, train: 100, bus: 60, taxi: 50, cruise: 30, ferry: 30, transit: 30, transport: 50 });
const SAME_PLACE = 30;

const minutes = (time) => (isTime(time) ? timeMinutes(time) : null);

/**
 * `{model, vias}` → `{nodes, legs, unlocated}`.
 *
 * Nodes: `{key, kind, t, id, entity, day, leaveDay, dayId, point, name, fixed, until, dwell, buffer, post, pinned,
 * service, fill, nights}`. `kind` is visit | booking | stay | depart | arrive | pickup | dropoff. `day` is the day
 * index the node is planned on; a stay's `leaveDay` is the morning you leave it. `fixed` is a time of day (minutes)
 * the node is anchored to, `until` the latest arrival (check-in), `buffer` minutes to be there before `fixed`.
 *
 * Legs: `{key, index, from, to, kind, res, vias, dayIndex, dayId, estimate}` between consecutive nodes. `kind` is
 * drive, transport (a booked flight, train or ferry) or the visit's own walk/bike/transit mode. `dayIndex` is the day
 * the leg is driven: the later of its start's leaving day and its end's day. `vias` are route points (`via` entities
 * after the leg's first visit), `estimate` the transport minutes when the booking has no times.
 */
export function buildChain({ model, vias = [] }) {
  const nodes = []; const unlocated = [];
  const days = model.days;
  const name = (res) => res?.title ?? '';
  const push = (node) => { nodes.push({ fixed: null, until: null, dwell: 0, buffer: 0, post: 0, pinned: false, service: null, fill: null, nights: 0, ...node, leaveDay: node.leaveDay ?? node.day }); };

  days.forEach((day, index) => {
    const stops = model.dayStops(day.id);
    if (!stops) return;
    const stay = (entry, morning) => {
      const res = entry.res; const last = nodes.at(-1);
      if (last?.kind === 'stay' && last.id === res.id) { last.leaveDay = morning ? index : index + 1; if (!morning) last.nights += 1; return; }
      push({
        key: `stay:${res.id}@${index}`, kind: 'stay', t: 'res', id: res.id, entity: res, day: index, leaveDay: morning ? index : index + 1, dayId: day.id,
        point: entry.point, name: name(res), until: minutes(res.stay?.checkInUntil), nights: morning ? 0 : 1, morning,
      });
    };
    if (stops.start) stay(stops.start, true);
    for (const item of stops.items) {
      const res = item.t === 'res' ? item.entity : null;
      if (item.t === 'visit') {
        if (!item.point) { unlocated.push({ dayId: day.id, visit: item.entity }); continue; }
        const visit = item.entity; const place = visit.placeId ? model.place(visit.placeId) : null;
        const fixed = (visit.pinned || isTime(visit.start)) && item.entity.endDayId == null ? minutes(visit.start) : null;
        push({
          key: `visit:${visit.id}`, kind: 'visit', t: 'visit', id: visit.id, entity: visit, place, day: index, dayId: day.id, point: item.point,
          name: place?.name ?? visit.title ?? '', fixed, pinned: visit.pinned === true, dwell: visitDwell(visit, place).minutes,
          service: place?.stop?.type ?? null, fill: Number.isFinite(place?.stop?.fill) ? place.stop.fill : null,
        });
      } else if (item.kind === 'booking') {
        if (!item.point) continue;
        const start = minutes(resStart(res)?.time); const end = minutes(resEnd(res)?.time);
        push({
          key: `booking:${res.id}@${index}`, kind: 'booking', t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.point, name: name(res),
          fixed: start, dwell: start !== null && end !== null && end > start ? end - start : bookingDwell(res.type) || 60,
        });
      } else if (item.kind === 'transport') {
        const time = minutes(resStart(res)?.time);
        if (RENTALS.includes(res.type)) {
          if (item.from) push({ key: `pickup:${res.id}@${index}`, kind: 'pickup', t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.from, name: name(res), fixed: time, dwell: bookingDwell(res.type) });
          const sameDay = !resEnd(res)?.date || resEnd(res).date === resStart(res)?.date;
          if (item.to && sameDay) push({ key: `dropoff:${res.id}@${index}`, kind: 'dropoff', t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.to, name: name(res), fixed: minutes(resEnd(res)?.time), dwell: bookingDwell(res.type) });
          continue;
        }
        if (item.from) push({ key: `depart:${res.id}@${index}`, kind: 'depart', t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.from, name: name(res), fixed: time, buffer: DEPARTURE_BUFFER[res.type] ?? 0 });
        const sameDay = !resEnd(res)?.date || resEnd(res).date === resStart(res)?.date;
        if (item.to && sameDay) push({ key: `arrive:${res.id}@${index}`, kind: 'arrive', t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.to, name: name(res), fixed: minutes(resEnd(res)?.time), post: ARRIVAL_BUFFER[res.type] ?? 0 });
      } else if (item.kind === 'arrival') {
        if (!item.point) continue;
        const kind = RENTALS.includes(res.type) ? 'dropoff' : 'arrive';
        push({ key: `${kind}:${res.id}@${index}`, kind, t: 'res', id: res.id, entity: res, day: index, dayId: day.id, point: item.point, name: name(res), fixed: minutes(resEnd(res)?.time), post: kind === 'arrive' ? ARRIVAL_BUFFER[res.type] ?? 0 : 0, dwell: kind === 'dropoff' ? bookingDwell(res.type) : 0 });
      }
    }
    if (stops.end) stay(stops.end, false);
  });

  const viaList = [...vias].filter((via) => Number.isFinite(via.lat) && Number.isFinite(via.lng))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  const legs = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const from = nodes[i]; const to = nodes[i + 1];
    if (from.kind === 'stay' && to.kind === 'stay' && from.id === to.id) continue;
    const transport = from.kind === 'depart' && to.kind === 'arrive' && from.id === to.id;
    let kind = 'drive';
    if (transport) kind = 'transport';
    else if (from.kind === 'visit' && LEG_MODES.includes(from.entity.legMode)) kind = from.entity.legMode;
    else if (to.kind === 'visit' && LEG_MODES.includes(to.entity.inMode)) kind = to.entity.inMode;
    else if (distance(from.point, to.point) < SAME_PLACE) kind = 'none';
    // A drive to a stop planned on a later day is driven that day (the night falls at its start unless placed).
    const dayIndex = Math.max(from.leaveDay, to.day);
    const leg = {
      key: `${from.key}>${to.key}`, index: legs.length, from: i, to: i + 1, kind, res: transport ? from.entity : null,
      vias: from.kind === 'visit' ? viaList.filter((via) => via.after === from.id).map((via) => ({ id: via.id, point: [via.lng, via.lat] })) : [],
      dayIndex, dayId: days[Math.min(dayIndex, days.length - 1)]?.id ?? from.dayId, estimate: null,
    };
    if (transport && (from.fixed === null || to.fixed === null)) {
      const speed = TRANSPORT_SPEED[from.entity.type] ?? 50;
      leg.estimate = Math.round(distance(from.point, to.point) / 1000 / speed * 60);
    }
    legs.push(leg);
  }
  return { nodes, legs, unlocated };
}

/** The leg a `dayEnd` refers to (by the entity ids at its ends), preferring one that starts on its day. */
export function legForDayEnd(chain, dayEnd, dayIndexOf) {
  const matches = chain.legs.filter((leg) => chain.nodes[leg.from].id === dayEnd.fromVisit && chain.nodes[leg.to].id === dayEnd.toVisit);
  if (matches.length <= 1) return matches[0] ?? null;
  const day = dayIndexOf?.(dayEnd.day);
  return matches.find((leg) => chain.nodes[leg.from].day === day) ?? matches[0];
}

/** Drive legs, in order, that can be routed as one request: consecutive drive legs leaving on the same day. */
export function driveRuns(chain) {
  const runs = []; let current = null;
  for (const leg of chain.legs) {
    if (leg.kind !== 'drive') { current = null; continue; }
    if (!current || current.dayIndex !== leg.dayIndex || current.legs.at(-1).to !== leg.from) {
      current = { dayIndex: leg.dayIndex, dayId: leg.dayId, legs: [] };
      runs.push(current);
    }
    current.legs.push(leg);
  }
  return runs;
}

/** The nearest drive leg to a point, given leg lines (`Map<legKey, line>`): `{leg, fraction, distance}` or null. */
export function detectLeg(chain, lines, point, project) {
  let best = null;
  for (const leg of chain.legs) {
    if (leg.kind !== 'drive') continue;
    const line = lines.get(leg.key) ?? [chain.nodes[leg.from].point, ...leg.vias.map((via) => via.point), chain.nodes[leg.to].point];
    const near = project(line, point);
    if (near && (!best || near.distance < best.distance)) best = { leg, fraction: near.fraction, distance: near.distance };
  }
  return best;
}
