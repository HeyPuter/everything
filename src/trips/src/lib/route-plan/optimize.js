import { distance } from '../../services/route.js';
import { orderKeys } from '../../shared/order.js';

/** Length in meters of a polyline of `[lng, lat]` points. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

const cost = (points, order, start, end) => pathLength([...(start ? [start] : []), ...order.map((i) => points[i]), ...(end ? [end] : [])]);

function nearestNeighbour(points, first, start) {
  const order = []; const left = new Set(points.keys());
  let current = start;
  if (first !== undefined) { order.push(first); left.delete(first); current = points[first]; }
  while (left.size) {
    let best = -1, bestDistance = Infinity;
    for (const i of left) {
      const d = distance(current, points[i]);
      if (d < bestDistance - 1e-9) { best = i; bestDistance = d; }
    }
    order.push(best); left.delete(best); current = points[best];
  }
  return order;
}

function twoOpt(points, order, start, end) {
  const path = (i) => points[order[i]];
  let improved = true; let rounds = 0;
  while (improved && rounds++ < 100) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const before = i === 0 ? start : path(i - 1);
        const after = k === order.length - 1 ? end : path(k + 1);
        const oldCost = (before ? distance(before, path(i)) : 0) + (after ? distance(path(k), after) : 0);
        const newCost = (before ? distance(before, path(k)) : 0) + (after ? distance(path(i), after) : 0);
        if (newCost < oldCost - 1e-6) {
          order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return order;
}

/**
 * Shortest visiting order (nearest neighbour, then 2-opt) for `points` as indexes, between optional fixed
 * `start` and `end` points. Returns the identity order unless the new one is shorter.
 */
export function optimizeOpenPath(points, { start = null, end = null } = {}) {
  const identity = [...points.keys()];
  if (points.length < 2 || (points.length === 2 && !start && !end)) return identity;
  const candidates = start ? [nearestNeighbour(points, undefined, start)] : identity.map((first) => nearestNeighbour(points, first, null));
  let best = null, bestCost = Infinity;
  for (const order of candidates) {
    const value = cost(points, order, start, end);
    if (value < bestCost - 1e-6) { best = order; bestCost = value; }
  }
  best = twoOpt(points, [...best], start, end);
  return cost(points, best, start, end) < cost(points, identity, start, end) - 0.5 ? best : identity;
}

const fixedItem = (item) => item.t !== 'visit' || !item.point || Boolean(item.entity.pinned) || Boolean(item.entity.start) || Boolean(item.entity.endDayId);
const exitPoint = (item) => (item.kind === 'transport' ? item.to : item.point) ?? null;
const entryPoint = (item) => (item.kind === 'transport' ? item.from : item.point) ?? null;

/**
 * Proposes a shorter stop order for a day (`dayStops` from the trip model). Pinned, timed, multi-day and
 * unlocated visits and every booking stay in place; the free visits between them are reordered.
 * `anchorHotel` starts the first run at the morning stay and ends the last run at the evening stay.
 * Returns `{changed, before, after, order: [visitId], sequence: [item], patches: [{id, order}]}`, distances in meters
 * (straight line); `sequence` is the proposed day order including fixed items.
 */
export function proposeOrder(stops, { anchorHotel = false } = {}) {
  const items = stops.items;
  const result = [...items];
  const runs = [];
  let run = null;
  items.forEach((item, index) => {
    if (fixedItem(item)) { run = null; return; }
    if (!run) runs.push(run = { from: index, items: [] });
    run.items.push(item);
  });
  const morning = anchorHotel ? stops.start?.point ?? null : null;
  const evening = anchorHotel ? stops.end?.point ?? null : null;
  const patches = [];
  for (const entry of runs) {
    const previous = items[entry.from - 1];
    const next = items[entry.from + entry.items.length];
    const start = previous ? exitPoint(previous) : morning;
    const end = next ? entryPoint(next) : evening;
    const order = optimizeOpenPath(entry.items.map((item) => item.point), { start, end });
    const reordered = order.map((from) => entry.items[from]);
    reordered.forEach((item, i) => { result[entry.from + i] = item; });
    const left = items.slice(0, entry.from).findLast((item) => item.key !== undefined)?.key ?? null;
    const right = items.slice(entry.from + entry.items.length).find((item) => item.key !== undefined)?.key ?? null;
    if (reordered.some((item, i) => item !== entry.items[i])) patches.push(...orderPatches(entry.items, reordered, { left, right }));
  }
  const length = (list) => {
    let total = 0; let last = morning;
    for (const item of list) {
      const enter = entryPoint(item);
      if (last && enter) total += pathLength([last, enter]);
      last = exitPoint(item) ?? last;
    }
    if (last && evening) total += pathLength([last, evening]);
    return total;
  };
  const changed = result.some((item, i) => item !== items[i]);
  return { changed, before: length(items), after: length(result), order: result.filter((item) => item.t === 'visit').map((item) => item.id), sequence: result, patches };
}

/**
 * Order-key patches that turn a run of visits (`items`, current order) into `next`. The run reuses its own keys,
 * so fixed items and other days keep theirs; duplicate keys get fresh keys between the `left` and `right` neighbours.
 */
export function orderPatches(items, next, { left = null, right = null } = {}) {
  const keys = items.map((item) => item.entity.order);
  let assigned = keys;
  if (new Set(keys).size !== keys.length) {
    try { assigned = orderKeys(keys.length, left, right); } catch { assigned = keys; }
  }
  return next.flatMap((item, i) => (item.entity.order === assigned[i] ? [] : [{ id: item.id, order: assigned[i] }]));
}
