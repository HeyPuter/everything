// Apple Wallet passes (.pkpass), read locally into the same item shape the AI extraction returns.
import { readZip } from './zip.js';

export class PassError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const TRANSIT = {
  PKTransitTypeAir: 'flight', PKTransitTypeTrain: 'train', PKTransitTypeBus: 'bus', PKTransitTypeBoat: 'ferry', PKTransitTypeGeneric: 'transport',
};
const STYLES = ['boardingPass', 'eventTicket', 'coupon', 'storeCard', 'generic'];
const FIELD_GROUPS = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** `{date, time?, at?}` from an ISO 8601 string; `at` (epoch ms) only when the string carries an offset. */
export function parseIsoPoint(value) {
  const match = typeof value === 'string' ? ISO.exec(value.trim()) : null;
  if (!match) return null;
  const [, date, hours, minutes, , offset] = match;
  const point = { date };
  if (hours !== undefined) point.time = `${hours}:${minutes}`;
  if (offset && hours !== undefined) {
    const at = Date.parse(value.trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isFinite(at)) point.at = at;
  }
  return point;
}

function decodeStrings(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  const text = new TextDecoder(encoding).decode(bytes);
  const map = new Map();
  const unescape = (value) => value.replace(/\\(.)/g, (_, char) => (char === 'n' ? '\n' : char));
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)) map.set(unescape(match[1]), unescape(match[2]));
  return map;
}

const clean = (value, max = 500) => {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
};

function fieldsOf(style, strings) {
  const local = (value) => (typeof value === 'string' && strings.has(value) ? strings.get(value) : value);
  const list = [];
  for (const group of FIELD_GROUPS) {
    for (const field of Array.isArray(style?.[group]) ? style[group] : []) {
      if (!field || typeof field !== 'object') continue;
      list.push({ group, key: String(field.key ?? '').toLowerCase(), label: clean(local(field.label)) ?? '', value: local(field.value), dated: Boolean(field.dateStyle || field.timeStyle) });
    }
  }
  return list;
}

/** First field whose key or label matches, as `{label, value}`. */
function finder(fields) {
  return (pattern, { groups } = {}) => fields.find((field) => (!groups || groups.includes(field.group))
    && (pattern.test(field.key) || pattern.test(field.label.toLowerCase())) && clean(field.value) !== undefined);
}

function endpoint(code, name, airport) {
  const result = {};
  const text = clean(code, 32);
  if (text && (!airport || /^[A-Za-z]{3}$/.test(text))) result.code = text.toUpperCase();
  else if (text && !name) result.name = text;
  const label = clean(name);
  if (label) result.name = label;
  return result;
}

function pointFrom(...values) {
  for (const value of values) {
    const point = parseIsoPoint(value);
    if (point) return point;
  }
  return null;
}

function boardingItem(pass, style, fields, find) {
  const type = TRANSIT[style.transitType] ?? 'transport';
  const airport = type === 'flight';
  const sem = pass.semantics && typeof pass.semantics === 'object' ? pass.semantics : {};
  const primary = fields.filter((field) => field.group === 'primaryFields');
  const origin = find(/^(origin|from|depart|departure)/, { groups: ['primaryFields'] }) ?? primary[0];
  const destination = find(/^(destination|to|arrive|arrival)/, { groups: ['primaryFields'] }) ?? primary[1];
  const from = endpoint(sem.departureAirportCode ?? origin?.value, sem.departureAirportName ?? sem.departureStationName ?? origin?.label, airport);
  const to = endpoint(sem.destinationAirportCode ?? destination?.value, sem.destinationAirportName ?? sem.destinationStationName ?? destination?.label, airport);
  const depField = fields.find((field) => field.dated && /depart|boarding|date|time/.test(field.key));
  const arrField = fields.find((field) => field.dated && /arriv/.test(field.key));
  const dep = pointFrom(sem.currentDepartureDate, sem.originalDepartureDate, depField?.value, pass.relevantDate);
  const arr = pointFrom(sem.currentArrivalDate, sem.originalArrivalDate, arrField?.value);
  const code = clean(sem.confirmationNumber, 64) ?? clean(find(/pnr|confirmation|booking|reservation|record|locator/)?.value, 64);
  const flight = clean(sem.flightCode ?? (sem.airlineCode && sem.flightNumber ? `${sem.airlineCode}${sem.flightNumber}` : undefined), 32)
    ?? clean(find(/flight|train|service|trip|route|number/)?.value, 32);
  const seat = clean(sem.seats?.[0]?.seatNumber ?? sem.seats?.[0]?.seatIdentifier, 32) ?? clean(find(/seat/)?.value, 32);
  const gate = clean(sem.departureGate, 32) ?? clean(find(/gate/)?.value, 32);
  const group = clean(sem.boardingGroup, 32) ?? clean(find(/group|zone/)?.value, 32);
  const leg = {
    from, to,
    dep: dep ? { date: dep.date, ...(dep.time ? { time: dep.time } : {}), ...(dep.at ? { at: dep.at } : {}) } : undefined,
    arr: arr ? { date: arr.date, ...(arr.time ? { time: arr.time } : {}), ...(arr.at ? { at: arr.at } : {}) } : undefined,
    carrier: clean(sem.transitProvider ?? pass.organizationName),
    number: flight,
    seat,
    cls: clean(find(/class|cabin|fare/)?.value, 64),
    platform: clean(sem.departurePlatform, 32) ?? clean(find(/platform|track/)?.value, 32),
    coach: clean(sem.carNumber, 32) ?? (type === 'train' ? clean(find(/coach|car\b|wagon/)?.value, 32) : undefined),
    code,
  };
  const passenger = sem.passengerName && typeof sem.passengerName === 'object'
    ? clean([sem.passengerName.givenName, sem.passengerName.familyName].filter(Boolean).join(' '))
    : clean(find(/passenger|traveller|traveler|^name$/)?.value);
  const extras = [gate && { key: 'gate', value: gate }, group && { key: 'group', value: group }].filter(Boolean);
  return {
    type, status: 'confirmed', provider: clean(pass.organizationName), code, legs: [leg],
    ...(passenger ? { travelers: [passenger] } : {}), ...(extras.length ? { extras } : {}),
  };
}

function eventItem(pass, fields, find) {
  const sem = pass.semantics && typeof pass.semantics === 'object' ? pass.semantics : {};
  const start = pointFrom(sem.eventStartDate, fields.find((field) => field.dated && !/end/.test(field.key))?.value, pass.relevantDate);
  const end = pointFrom(sem.eventEndDate, fields.find((field) => field.dated && /end/.test(field.key))?.value);
  const venue = clean(sem.venueName) ?? clean(find(/venue|location|place|stadium|theat/)?.value);
  const coords = sem.venueLocation ?? pass.locations?.[0];
  const extras = ['section', 'row', 'seat', 'gate', 'entrance']
    .map((key) => ({ key, value: clean(find(new RegExp(key))?.value, 32) })).filter((extra) => extra.value);
  const location = venue || Number.isFinite(coords?.latitude) ? {
    ...(venue ? { name: venue } : {}),
    ...(clean(sem.venueAddress) ? { address: clean(sem.venueAddress, 2000) } : {}),
    ...(Number.isFinite(coords?.latitude) && Number.isFinite(coords?.longitude) ? { lat: coords.latitude, lng: coords.longitude } : {}),
  } : undefined;
  return {
    type: 'event', status: 'confirmed', provider: clean(pass.organizationName),
    title: clean(sem.eventName) ?? clean(find(/event|show|match|title/, { groups: ['primaryFields', 'secondaryFields'] })?.value) ?? clean(pass.description),
    code: clean(sem.confirmationNumber, 64) ?? clean(find(/confirmation|order|booking|reservation/)?.value, 64),
    start: start ? { date: start.date, ...(start.time ? { time: start.time } : {}), ...(start.at ? { at: start.at } : {}) } : undefined,
    end: end ? { date: end.date, ...(end.time ? { time: end.time } : {}), ...(end.at ? { at: end.at } : {}) } : undefined,
    ...(location ? { location } : {}),
    ...(extras.length ? { extras } : {}),
  };
}

function genericItem(pass, find) {
  const start = pointFrom(pass.relevantDate);
  if (!start) throw new PassError('pkpass_not_booking');
  return {
    type: 'other', status: 'confirmed', provider: clean(pass.organizationName), title: clean(pass.description) ?? clean(pass.organizationName),
    code: clean(find(/confirmation|booking|reservation/)?.value, 64),
    start: { date: start.date, ...(start.time ? { time: start.time } : {}), ...(start.at ? { at: start.at } : {}) },
  };
}

/** Item from a parsed `pass.json` object and an optional localization map. */
export function passToItem(pass, strings = new Map()) {
  if (!pass || typeof pass !== 'object') throw new PassError('pkpass_invalid');
  const styleName = STYLES.find((name) => pass[name] && typeof pass[name] === 'object');
  if (!styleName) throw new PassError('pkpass_invalid');
  const style = pass[styleName];
  const fields = fieldsOf(style, strings);
  const find = finder(fields);
  if (styleName === 'boardingPass') return boardingItem(pass, style, fields, find);
  if (styleName === 'eventTicket') return eventItem(pass, fields, find);
  if (styleName === 'generic') return genericItem(pass, find);
  throw new PassError('pkpass_not_booking');
}

/** Reads a .pkpass archive (Blob, ArrayBuffer or bytes) into an extraction item. */
export async function parsePkpass(input) {
  let entries;
  try { entries = await readZip(input, { maxEntryBytes: 1024 * 1024 }); }
  catch { throw new PassError('pkpass_invalid'); }
  const passEntry = entries.find((entry) => entry.name === 'pass.json');
  if (!passEntry) throw new PassError('pkpass_invalid');
  let pass;
  try { pass = JSON.parse(new TextDecoder().decode(await passEntry.read())); }
  catch { throw new PassError('pkpass_invalid'); }
  const stringsEntry = entries.find((entry) => entry.name === 'en.lproj/pass.strings') ?? entries.find((entry) => /^[\w-]+\.lproj\/pass\.strings$/.test(entry.name));
  let strings = new Map();
  if (stringsEntry) { try { strings = decodeStrings(await stringsEntry.read()); } catch { /* Labels stay as keys. */ } }
  return passToItem(pass, strings);
}
