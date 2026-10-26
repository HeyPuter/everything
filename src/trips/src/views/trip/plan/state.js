// Shared UI state for the Plan tab's panes (days, places, map). Created by the plan view, passed as `context.plan`.
// State: day (selected day id, null = whole trip), place, visit (selected ids), hover ({t, id} or null).
// Events: locate {t, id} (show on map), pickLocation {lat, lng, name?, address?, osm?} (open the place form),
// openPlace {id}, addToDay {placeId, dayId}.
export function createPlanState(initial = {}) {
  let state = Object.freeze({ day: null, place: null, visit: null, hover: null, ...initial });
  const subscribers = new Set();
  const listeners = new Map();
  return {
    get: () => state,
    set(patch) {
      if (Object.keys(patch).every((key) => Object.is(patch[key], state[key]))) return;
      state = Object.freeze({ ...state, ...patch });
      for (const fn of [...subscribers]) fn(state, patch);
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    emit(name, detail) { for (const fn of [...(listeners.get(name) ?? [])]) fn(detail); },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
  };
}
