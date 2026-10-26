// Values the worker checks (worker/ops/journey/*.js; tests/worker/journey.test.js keeps both lists equal).
export const JOURNEY_STATUSES = Object.freeze(['upcoming', 'ongoing', 'completed']);
export const ENTRY_TYPES = Object.freeze(['moment', 'day', 'checkin', 'highlight', 'suggestion']);
/** Types a member picks; `suggestion` only comes from linked trips. */
export const WRITABLE_TYPES = Object.freeze(['moment', 'day', 'checkin', 'highlight']);
export const MOODS = Object.freeze(['great', 'good', 'okay', 'meh', 'bad']);
export const WEATHER = Object.freeze(['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'thunder', 'wind']);
export const VISIBILITY = Object.freeze(['public', 'members']);
export const ENTRY_LIMITS = Object.freeze({ title: 300, tags: 30, tag: 50, list: 20, item: 200 });
export const META_LIMITS = Object.freeze({ title: 200, subtitle: 300, trips: 20 });
export const LINK_TYPES = Object.freeze(['entry', 'meta']);
export const SHARE_TOGGLES = Object.freeze(['timeline', 'gallery', 'map', 'newestFirst']);
