import { createRoutePlanner } from '../../../../lib/route-plan/index.js';
import { timelineOf } from '../ops.js';

const planners = new WeakMap();

const TYPES = ['day', 'visit', 'dayNote', 'res'];

/**
 * The day order of the plan timeline for the route planner: `timeline(dayId) → [{t, id}]`, each booking once.
 * Null (the planner's own merge) for a space without every plan selector.
 */
export function timelineOrder(space) {
  let cache = null;
  return (dayId) => {
    if (!TYPES.every((type) => typeof space.select?.[type]?.all === 'function')) return null;
    const inputs = TYPES.map((type) => space.select[type].all());
    if (!cache || cache.inputs.some((value, index) => value !== inputs[index])) cache = { inputs, timeline: timelineOf(space), orders: new Map() };
    if (!cache.orders.has(dayId)) {
      const seen = new Set();
      const order = [];
      for (const row of cache.timeline.byDay.get(dayId)?.rows ?? []) {
        const key = `${row.kind}:${row.id}`;
        if (row.kind === 'note' || !row.primary || seen.has(key)) continue;
        seen.add(key);
        order.push({ t: row.kind, id: row.id });
      }
      cache.orders.set(dayId, order);
    }
    return cache.orders.get(dayId);
  };
}

/** One route planner per open trip, shared by the map and the scheduler so each day is routed once. */
export function tripPlanner(space, route = null) {
  const known = planners.get(space);
  if (known && known.route === route) return known.planner;
  const planner = createRoutePlanner({ space, route, timeline: timelineOrder(space) });
  planners.set(space, { route, planner });
  return planner;
}
