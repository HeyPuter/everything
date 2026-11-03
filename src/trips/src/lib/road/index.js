// Road trips: the trip as one chain of drives, scheduled against driving limits, with range, costs and hazards.
// Pure; the road-trip view (views/trip/road) feeds it the route planner's stops and routed legs.
export { ROAD_PREFS_ID, FUELS, AVOIDS, CORRIDORS, DEFAULT_PREFS, DEFAULT_RANGE, readPrefs, rangeKm, rangeKnown, refillTypes, refillCategories, dayAvoid, prefsChange } from './prefs.js';
export { buildChain, legForDayEnd, driveRuns, detectLeg, RENTALS } from './chain.js';
export { scheduleRoad, splitTime, DAY } from './schedule.js';
export { planFuel } from './fuel.js';
export { fuelEstimate, fuelUnit, routeFlags, expenseDraft } from './costs.js';
export { hazardsNearRoute, hazardRadius, levelRank, inPolygons, HAZARD_RADIUS } from './hazards.js';
export { cumulative, lineLength, pointAt, slice, project, splitAtWaypoints, densify, downsample, corridorBoxes, withinCorridor, distance } from './geo.js';
