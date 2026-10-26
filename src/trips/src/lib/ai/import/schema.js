// The extraction contract: the JSON schema sent to the model, and the coercion of untrusted items into reservation drafts.
import { isDate, isTime, isTimeZone } from '../../../shared/dates.js';
import { RES_TYPES, isLodging, isTransport, normalizeRes, resIssues, suggestTitle } from '../../res/index.js';

const point = (what) => ({
  type: 'object', additionalProperties: false, required: ['date'],
  properties: {
    date: { type: 'string', description: `Local ${what} date as YYYY-MM-DD.` },
    time: { type: 'string', description: `Local ${what} time as HH:mm (24-hour), only when stated.` },
    tz: { type: 'string', description: 'IANA time zone of this local time, only when certain.' },
  },
});
const endpoint = {
  type: 'object', additionalProperties: false,
  properties: {
    code: { type: 'string', description: 'IATA airport code for flights (3 letters); station code otherwise.' },
    name: { type: 'string', description: 'Airport, station, port or place name.' },
  },
};
const text = (description) => ({ type: 'string', description });

export const EXTRACTION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['bookings'],
  properties: {
    bookings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'title'],
        properties: {
          type: { type: 'string', enum: [...RES_TYPES], description: 'transport: flight, train, bus, car (rental), taxi, bike, cruise, ferry, transit, transport; bookings: lodging, restaurant, event, tour, parking, other.' },
          title: text('Short title, such as "Lisbon → New York" or the hotel name.'),
          status: { type: 'string', enum: ['confirmed', 'pending', 'cancelled'] },
          provider: text('Airline, rail company, hotel, agency or venue that issued the booking.'),
          code: text('Booking reference or confirmation number.'),
          start: point('start or check-in'),
          end: point('end or check-out'),
          location: { type: 'object', additionalProperties: false, properties: { name: text('Place name.'), address: text('Street address.') } },
          legs: {
            type: 'array', description: 'Transport segments in travel order; required for transport types.',
            items: {
              type: 'object', additionalProperties: false, required: ['from', 'to', 'dep'],
              properties: {
                from: endpoint, to: endpoint, dep: point('departure'), arr: point('arrival'),
                carrier: text('Operating carrier.'), number: text('Flight or train number.'), seat: text('Seat.'), cls: text('Cabin or class.'),
                code: text('Segment booking code if different.'), platform: text('Platform or gate.'), coach: text('Coach or car number.'),
              },
            },
          },
          travelers: { type: 'array', items: { type: 'string' }, description: 'Passenger or guest names.' },
          checkIn: text('Lodging check-in time, HH:mm.'),
          checkOut: text('Lodging check-out time, HH:mm.'),
          url: text('Manage-booking link, only an https URL from the document.'),
          notes: text('Other useful details, plain text, short.'),
        },
      },
    },
  },
});

const TYPE_ALIASES = {
  air: 'flight', plane: 'flight', airline: 'flight', rail: 'train', railway: 'train', coach: 'bus', rental: 'car', car_rental: 'car',
  'car rental': 'car', cab: 'taxi', boat: 'ferry', ship: 'cruise', metro: 'transit', subway: 'transit', tram: 'transit',
  hotel: 'lodging', hostel: 'lodging', apartment: 'lodging', accommodation: 'lodging', stay: 'lodging', airbnb: 'lodging',
  dinner: 'restaurant', lunch: 'restaurant', concert: 'event', ticket: 'event', show: 'event', museum: 'event', activity: 'tour', excursion: 'tour',
};
const STATUS_ALIASES = { confirmed: 'confirmed', booked: 'confirmed', paid: 'confirmed', ticketed: 'confirmed', pending: 'pending', tentative: 'pending', cancelled: 'cancelled', canceled: 'cancelled' };
const LEG_TEXT = ['carrier', 'number', 'seat', 'cls', 'code', 'platform', 'coach'];

/** Trimmed text without control characters, capped; undefined when empty or not text. */
export function str(value, max = 500) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/[ \t]+/g, ' ').trim();
  return result ? result.slice(0, max) : undefined;
}

export function coerceDate(value) {
  const text = str(value, 40);
  if (!text) return undefined;
  const date = text.slice(0, 10);
  return isDate(date) ? date : undefined;
}

/** `HH:mm` from 24-hour or AM/PM spellings ("7:05 pm", "19h05", "07:05:00"); undefined otherwise. */
export function coerceTime(value) {
  const text = str(value, 20)?.toLowerCase().replace(/\s+/g, ' ');
  if (!text) return undefined;
  let match = /^(\d{1,2})(?:[:.h](\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m?\.?$/.exec(text);
  if (match) {
    let hours = Number(match[1]);
    if (hours < 1 || hours > 12) return undefined;
    if (match[3] === 'p' && hours !== 12) hours += 12;
    if (match[3] === 'a' && hours === 12) hours = 0;
    const time = `${String(hours).padStart(2, '0')}:${match[2] ?? '00'}`;
    return isTime(time) ? time : undefined;
  }
  match = /^(\d{1,2})[:.h](\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
  if (!match) return undefined;
  const time = `${match[1].padStart(2, '0')}:${match[2]}`;
  return isTime(time) ? time : undefined;
}

export const coerceZone = (value) => (typeof value === 'string' && isTimeZone(value.trim()) ? value.trim() : undefined);

export function coerceType(value) {
  const text = str(value, 40)?.toLowerCase();
  if (!text) return 'other';
  if (RES_TYPES.includes(text)) return text;
  return TYPE_ALIASES[text] ?? TYPE_ALIASES[text.replace(/[-\s]+/g, '_')] ?? 'other';
}

function webUrl(value) {
  const text = str(value, 2048);
  if (!text || /[\s]/.test(text)) return undefined;
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function coercePoint(value, { trusted = false } = {}) {
  if (!value || typeof value !== 'object') return undefined;
  const date = coerceDate(value.date);
  if (!date) return undefined;
  const result = { date };
  const time = coerceTime(value.time);
  if (time) result.time = time;
  const tz = coerceZone(value.tz);
  if (tz) result.tz = tz;
  return { point: result, at: trusted && Number.isFinite(value.at) ? value.at : undefined };
}

function coerceEndpoint(value, airport) {
  if (!value || typeof value !== 'object') return {};
  const code = str(value.code, 16)?.toUpperCase();
  const name = str(value.name);
  const result = {};
  if (code && (!airport || /^[A-Z]{3}$/.test(code))) result.code = code;
  else if (code && !name) result.name = code;
  if (name) result.name = name;
  const tz = coerceZone(value.tz);
  if (tz) result.tz = tz;
  if (Number.isFinite(value.lat) && Number.isFinite(value.lng) && Math.abs(value.lat) <= 90 && Math.abs(value.lng) <= 180) Object.assign(result, { lat: value.lat, lng: value.lng });
  return result;
}

const fold = (name) => String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Member uuid or guest id for a traveler name, when exactly one person matches. */
export function matchPerson(name, people) {
  const words = fold(name);
  if (!words.length) return null;
  const scored = people.map((person) => {
    const own = fold(person.name);
    if (!own.length) return [person, 0];
    if (own.join(' ') === words.join(' ')) return [person, 3];
    if (own.every((word) => words.includes(word))) return [person, 2];
    if (own[0] === words[0]) return [person, 1];
    return [person, 0];
  }).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
  if (!scored.length || (scored[1] && scored[1][1] === scored[0][1])) return null;
  return scored[0][0].id;
}

/**
 * A review candidate from one extraction item (AI output or a local parser). Untrusted input: every field is
 * coerced, unknown fields are dropped, and the result is checked against the shared `res` schema. Returns
 * `{draft, provider, hints, issues, warnings}`; `issues` lists schema problems the user must fix before import.
 * Options: `people` ([{id, name}] members and guests), `kind` ('ai'|'pkpass'), `hash`, `trusted` (accept the
 * parser's absolute-time hints), `fallbackTitle(type)` and `label(key)` for note lines.
 */
export function candidateFromItem(item, { people = [], kind = 'ai', hash, trusted = false, fallbackTitle = (type) => type, label = (key) => key } = {}) {
  const input = item && typeof item === 'object' ? item : {};
  const type = coerceType(input.type);
  const transport = isTransport(type);
  const warnings = [];
  const hints = {};
  const draft = { type, status: STATUS_ALIASES[str(input.status, 20)?.toLowerCase()] ?? 'pending' };
  const provider = str(input.provider, 200);
  const code = str(input.code, 64);
  if (code) draft.code = code;

  const legs = Array.isArray(input.legs) ? input.legs.slice(0, 20) : [];
  if (transport) {
    const start = coercePoint(input.start, { trusted });
    const end = coercePoint(input.end, { trusted });
    const source = legs.length ? legs : [{ from: {}, to: {}, dep: input.start, arr: input.end }];
    draft.legs = source.map((leg, index) => {
      const dep = coercePoint(leg?.dep, { trusted }) ?? (index === 0 ? start : undefined);
      const arr = coercePoint(leg?.arr, { trusted }) ?? (index === source.length - 1 && legs.length ? end : undefined);
      if (dep?.at !== undefined || arr?.at !== undefined) (hints.legs ??= [])[index] = { depAt: dep?.at, arrAt: arr?.at };
      const result = {
        from: coerceEndpoint(leg?.from, type === 'flight'), to: coerceEndpoint(leg?.to, type === 'flight'),
        dep: dep ? { date: dep.point.date, ...(dep.point.time ? { time: dep.point.time } : {}) } : { date: '' },
        arr: arr ? { date: arr.point.date, ...(arr.point.time ? { time: arr.point.time } : {}) } : { date: dep?.point.date ?? '' },
      };
      if (dep?.point.tz && !result.from.tz) result.from.tz = dep.point.tz;
      if (arr?.point.tz && !result.to.tz) result.to.tz = arr.point.tz;
      for (const key of LEG_TEXT) { const value = str(leg?.[key], key === 'carrier' ? 200 : 64); if (value) result[key] = value; }
      if (type === 'flight' && !result.carrier && provider) result.carrier = provider;
      return result;
    });
  } else {
    const start = coercePoint(input.start, { trusted }) ?? coercePoint(legs[0]?.dep, { trusted });
    const end = coercePoint(input.end, { trusted }) ?? coercePoint(legs.at(-1)?.arr, { trusted });
    if (start) { draft.start = start.point; if (start.at !== undefined) hints.startAt = start.at; }
    if (end) { draft.end = end.point; if (end.at !== undefined) hints.endAt = end.at; }
    if (draft.end && draft.start && !draft.end.tz && draft.start.tz) draft.end.tz = draft.start.tz;
    if (draft.start && draft.end && draft.start.tz && draft.end.tz && draft.start.tz !== draft.end.tz) draft.end.tz = draft.start.tz;
    const location = input.location && typeof input.location === 'object' ? input.location : {};
    const name = str(location.name) ?? (isLodging(type) || ['restaurant', 'event', 'tour', 'parking'].includes(type) ? provider : undefined);
    const address = str(location.address, 2000);
    const located = Number.isFinite(location.lat) && Number.isFinite(location.lng) && Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180;
    if (name || address || located) draft.location = { ...(name ? { name } : {}), ...(address ? { address } : {}), ...(located ? { lat: location.lat, lng: location.lng } : {}) };
    if (isLodging(type)) {
      const checkIn = coerceTime(input.checkIn);
      const checkOut = coerceTime(input.checkOut);
      if (checkIn || checkOut) draft.stay = { ...(checkIn ? { checkInFrom: checkIn } : {}), ...(checkOut ? { checkOut } : {}) };
    }
  }

  const travelers = (Array.isArray(input.travelers) ? input.travelers : []).map((name) => str(name, 200)).filter(Boolean).slice(0, 50);
  const matched = new Set();
  const unmatched = [];
  for (const name of travelers) {
    const id = matchPerson(name, people);
    if (id) matched.add(id); else unmatched.push(name);
  }
  if (matched.size) draft.people = [...matched];

  const url = webUrl(input.url);
  if (url) draft.url = url;
  const lines = [];
  const notes = str(input.notes, 4000);
  if (notes) lines.push(notes);
  for (const extra of Array.isArray(input.extras) ? input.extras.slice(0, 20) : []) {
    const value = str(extra?.value, 200);
    const key = str(extra?.key, 40);
    if (value && key) lines.push(`${label(key)}: ${value}`);
  }
  if (provider && !transport && draft.location?.name !== provider) lines.push(`${label('provider')}: ${provider}`);
  if (unmatched.length) lines.push(`${label('travelers')}: ${unmatched.join(', ')}`);
  if (lines.length) draft.notes = lines.join('\n').slice(0, 8000);

  draft.title = str(input.title, 200) ?? '';
  draft.review = true;
  draft.src = { kind, ...(hash ? { hash: String(hash).slice(0, 128) } : {}) };
  const fields = finalize(draft, { provider, fallbackTitle });
  return { draft: fields, provider, hints, warnings, issues: resIssues(fields) };
}

/** Normalizes a draft for storage and fills an empty title from its content. */
export function finalize(draft, { provider, fallbackTitle = (type) => type } = {}) {
  const fields = normalizeRes({ ...draft, review: true });
  if (!fields.title) fields.title = (suggestTitle(fields) || provider || fallbackTitle(fields.type)).slice(0, 500);
  return fields;
}

/** The first JSON object in a model reply (tolerates code fences and prose around it). */
export function parseJson(text) {
  if (text && typeof text === 'object') return text;
  const source = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(source); } catch { /* Look for an embedded object. */ }
  const start = source.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (char === '\\') i += 1; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/** Items from a model reply: `{bookings: [...]}` or a bare array, at most 50. Throws `unreadable` otherwise. */
export function extractionItems(reply) {
  const data = parseJson(reply);
  const items = Array.isArray(data) ? data : Array.isArray(data?.bookings) ? data.bookings : null;
  if (!items) { const error = new Error('unreadable'); error.code = 'unreadable'; throw error; }
  return items.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 50);
}
