// Journey entry rules beyond the shared schema. Only touched fields are checked, so older entries stay editable.
import { DomainError } from '../../../src/shared/errors.js';
import { touchedFields } from '../trip/place.js';

// Match src/views/journey/constants.js (tests/worker/journey.test.js checks them).
export const ENTRY_TYPES = Object.freeze(['moment', 'day', 'checkin', 'highlight', 'suggestion']);
export const MOODS = Object.freeze(['great', 'good', 'okay', 'meh', 'bad']);
export const WEATHER = Object.freeze(['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'thunder', 'wind']);
export const VISIBILITY = Object.freeze(['public', 'members']);
export const ENTRY_LIMITS = Object.freeze({ title: 300, tags: 30, tag: 50, list: 20, item: 200 });
const reject = (code) => { throw new DomainError(code, 400); };
const oneOf = (list, value, code) => { if (value !== undefined && !list.includes(value)) reject(code); };

function checkList(items) {
  if (items === undefined) return;
  if (items.length > ENTRY_LIMITS.list) reject('invalid_list');
  for (const item of items) if (!item.trim() || item.length > ENTRY_LIMITS.item) reject('invalid_list');
}

export default Object.freeze({
  check({ op, after }) {
    if (!after) return;
    const touched = touchedFields(op);
    if (touched.has('type')) oneOf(ENTRY_TYPES, after.type, 'invalid_type');
    if ((touched.has('type') || touched.has('src')) && after.type === 'suggestion' && !after.src?.trip) reject('invalid_source');
    if (touched.has('title') && after.title.trim().length > ENTRY_LIMITS.title) reject('title_too_long');
    if (touched.has('mood')) oneOf(MOODS, after.mood, 'invalid_mood');
    if (touched.has('weather')) oneOf(WEATHER, after.weather, 'invalid_weather');
    if (touched.has('vis')) oneOf(VISIBILITY, after.vis, 'invalid_visibility');
    if (touched.has('tags') && after.tags) {
      if (after.tags.length > ENTRY_LIMITS.tags) reject('invalid_tag');
      const seen = new Set();
      for (const tag of after.tags) {
        const key = tag.trim().toLocaleLowerCase();
        if (!key || tag.length > ENTRY_LIMITS.tag) reject('invalid_tag');
        if (seen.has(key)) reject('duplicate_tag');
        seen.add(key);
      }
    }
    if (touched.has('pros')) checkList(after.pros);
    if (touched.has('cons')) checkList(after.cons);
    if (touched.has('media') && after.media && new Set(after.media).size !== after.media.length) reject('duplicate_media');
    if (touched.has('loc') && after.loc && Object.hasOwn(after.loc, 'lat') !== Object.hasOwn(after.loc, 'lng')) reject('invalid_location');
    if (touched.has('src') && after.src?.trip && after.src.trip.k !== 'trip') reject('invalid_source');
  },
});
