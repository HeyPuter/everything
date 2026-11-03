// Time-aware day scheduling: dwell, travel, anchors and warnings. Pure; the plan view feeds it timelines and legs.
export { scheduleDay, schedulePatches, clearablePatches, legsByStop, LATE_TOLERANCE } from './engine.js';
export { visitDwell, defaultDwell, bookingDwell, CATEGORY_DWELL, BOOKING_DWELL, ITEM_DWELL, DEPARTURE_BUFFER, ARRIVAL_BUFFER, MAX_DWELL } from './dwell.js';
export { createClock, roundUp, MINUTE } from './clock.js';
export { openDuring, openRanges } from './opening.js';
