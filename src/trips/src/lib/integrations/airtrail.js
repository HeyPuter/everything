// AirTrail: the user's flight log on their own server. REST `/api/v1` with a bearer key; servers without it
// answer 404 there and still have the older `/api/flight/list`.
import { addDays, isDate, isTime, isTimeZone, zonedParts } from '../../shared/dates.js';
import { normalizeRes, resIssues, resPatch, suggestTitle } from '../res/model.js';
import { compareBookings, fillMissing } from '../ai/import/dedupe.js';
import { createClient, stableHash } from './client.js';
import { IntegrationError } from './errors.js';

export const AIRTRAIL_PAGE = 100;
const MAX_PAGES = 50;
const SERVICE = 'airtrail';
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined);
const text = (value, max = 500) => (typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : typeof value === 'number' ? String(value) : undefined);
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

export function airtrailClient(puter, config) {
  if (!config?.url || !config?.key) throw new IntegrationError('not_configured', { service: SERVICE });
  return createClient({ puter, url: config.url, service: SERVICE, headers: { authorization: `Bearer ${config.key}` } });
}

const userOf = (value) => (plain(value) && value.id != null ? { id: String(value.id), name: text(value.displayName ?? value.username ?? value.name, 200) ?? '' } : null);

/** Checks the URL and key: `{user}` from `/api/v1/me`, or `{user: null, legacy: true}` on an older server. */
export async function verifyAirtrail(client, { signal } = {}) {
  try {
    const { data } = await client.request('/api/v1/me', { signal });
    return { user: userOf(data?.data?.user ?? data?.data ?? data) };
  } catch (error) { if (error.code !== 'not_found') throw error; }
  await client.request('/api/flight/list', { signal });
  return { user: null, legacy: true };
}

async function listLegacy(client, { signal }) {
  const { data } = await client.request('/api/flight/list', { signal });
  const items = Array.isArray(data) ? data : Array.isArray(data?.flights) ? data.flights : Array.isArray(data?.data) ? data.data : null;
  if (!items) throw new IntegrationError('bad_response', { service: SERVICE });
  return { flights: items, truncated: false };
}

/** Every flight the key can read, following cursors (at most 5,000). `{flights, truncated}`. */
export async function listFlights(client, { signal } = {}) {
  const flights = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response;
    try { response = await client.request('/api/v1/flights', { query: { limit: AIRTRAIL_PAGE, cursor }, signal }); }
    catch (error) { if (page === 0 && error.code === 'not_found') return listLegacy(client, { signal }); throw error; }
    const items = response.data?.data;
    if (!Array.isArray(items)) throw new IntegrationError('bad_response', { service: SERVICE });
    flights.push(...items);
    const next = response.data?.page?.nextCursor;
    if (typeof next !== 'string' || !next || next === cursor) return { flights, truncated: false };
    cursor = next;
  }
  return { flights, truncated: true };
}

function airport(value) {
  if (typeof value === 'string') return /^[A-Za-z0-9]{3,4}$/.test(value.trim()) ? { code: value.trim().toUpperCase() } : compact({ name: text(value) });
  if (!plain(value)) return {};
  const lat = finite(value.lat ?? value.latitude);
  const lng = finite(value.lon ?? value.lng ?? value.longitude);
  const located = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const zone = value.tz ?? value.timezone;
  return compact({
    name: text(value.name), code: text(value.iata ?? value.code ?? value.icao, 16)?.toUpperCase(),
    lat: located ? lat : undefined, lng: located ? lng : undefined, tz: isTimeZone(zone) ? zone : undefined,
  });
}

/** A local `{date, time}` from an ISO instant: in `zone` when known, else the wall time as written. */
export function localPoint(iso, zone, fallbackDate) {
  if (typeof iso === 'string' && iso.trim()) {
    const epoch = Date.parse(iso);
    if (Number.isFinite(epoch) && zone) { const { date, time } = zonedParts(epoch, zone); return { date, time }; }
    const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(iso.trim());
    if (match && isDate(match[1])) return compact({ date: match[1], time: isTime(match[2]) ? match[2] : undefined });
  }
  return isDate(fallbackDate) ? { date: fallbackDate } : null;
}

function pickSeat(flight, me) {
  const seats = Array.isArray(flight.passengers) ? flight.passengers : Array.isArray(flight.seats) ? flight.seats : [];
  const mine = me ? seats.find((seat) => plain(seat) && seat.userId != null && String(seat.userId) === String(me)) : null;
  return mine ?? seats.find((seat) => plain(seat) && seat.userId != null) ?? seats.find(plain) ?? null;
}

/** The AirTrail-owned part of a booking; `src.hash` is its hash at the last import. */
export const ownedFields = (res) => compact({ title: res.title, legs: res.legs, notes: res.notes });
export const ownedHash = (res) => stableHash(ownedFields(res));

/**
 * A flight as a stored booking draft: `{ext, fields, hash}` with `fields.src = {kind: 'airtrail', ext, hash}`, or
 * null when it has no usable date or would not validate. `me` picks the user's seat; `classLabel` names the cabin.
 */
export function flightDraft(flight, { me = null, classLabel = (value) => value, fallbackTitle = 'Flight' } = {}) {
  if (!plain(flight) || flight.id == null || String(flight.id).length > 100) return null;
  const from = airport(flight.from);
  const to = airport(flight.to);
  const date = isDate(flight.date) ? flight.date : undefined;
  const dep = localPoint(flight.departure ?? flight.departureScheduled, from.tz, date);
  if (!dep) return null;
  const arrived = localPoint(flight.arrival ?? flight.arrivalScheduled, to.tz, null);
  const arr = arrived && arrived.date >= dep.date && arrived.date <= addDays(dep.date, 3) ? arrived : { date: dep.date };
  const seat = pickSeat(flight, me);
  const airline = plain(flight.airline) ? flight.airline : null;
  const cabin = text(seat?.seatClass, 40);
  const leg = compact({
    from, to, dep, arr,
    carrier: text(airline?.name) ?? text(airline?.iata ?? airline?.icao, 16) ?? (typeof flight.airline === 'string' ? text(flight.airline) : undefined),
    number: text(flight.flightNumber, 40), seat: text(seat?.seatNumber, 40), cls: cabin ? text(classLabel(cabin), 100) : undefined,
  });
  const base = normalizeRes({ type: 'flight', title: '', status: 'confirmed', legs: [leg], notes: text(flight.note, 100_000) });
  base.title = suggestTitle(base) || fallbackTitle;
  const ext = String(flight.id);
  const hash = ownedHash(base);
  const fields = { ...base, src: { kind: 'airtrail', ext, hash } };
  return resIssues(fields).length ? null : { ext, fields, hash };
}

const depDate = (fields) => fields.legs?.[0]?.dep?.date ?? fields.start?.date;
const arrDate = (fields) => fields.legs?.at(-1)?.arr?.date ?? depDate(fields);

/** Whether a draft's flight touches the trip's dates. Undated trips match nothing. */
export function inTrip(fields, { start, end } = {}) {
  if (!isDate(start)) return false;
  const last = isDate(end) && end >= start ? end : start;
  const from = depDate(fields); const to = arrDate(fields);
  return Boolean(from) && from <= last && (to ?? from) >= start;
}

/**
 * What a pull means for one trip: `add` (new flights in the trip's dates, each with any `duplicate` booking added by
 * other means), `update` (flights already imported whose AirTrail data changed), plus counts. With `all`, flights
 * outside the dates are offered too. `dismissed` holds external ids the user set aside.
 */
export function planFlightSync(drafts, reservations, { start, end, dismissed = new Set(), all = false } = {}) {
  const live = reservations.filter((res) => res && !res.deleted);
  // Bookings sent from Trips (`p:<id>,…`, airtrail-push.js) own their details, so a pull never updates them.
  const linked = new Map();
  for (const res of live.filter((item) => item.src?.kind === 'airtrail' && item.src.ext)) {
    const pushed = res.src.ext.startsWith('p:');
    for (const ext of (pushed ? res.src.ext.slice(2) : res.src.ext).split(',')) if (ext) linked.set(ext, { res, pushed });
  }
  const others = live.filter((res) => res.src?.kind !== 'airtrail');
  const plan = { add: [], update: [], unchanged: 0, outside: 0, dismissed: 0 };
  for (const draft of drafts) {
    if (!draft) continue;
    const hit = linked.get(draft.ext);
    if (hit) {
      const { res } = hit;
      if (hit.pushed || res.src.hash === draft.hash) plan.unchanged += 1; else plan.update.push({ draft, res, edited: ownedHash(res) !== res.src.hash });
      continue;
    }
    if (!all && !inTrip(draft.fields, { start, end })) { plan.outside += 1; continue; }
    if (!all && dismissed.has(draft.ext)) { plan.dismissed += 1; continue; }
    const match = others.map((other) => ({ other, match: compareBookings(draft.fields, other) })).find((entry) => entry.match);
    plan.add.push({ draft, duplicate: match ? match.other : null, dismissed: dismissed.has(draft.ext) });
  }
  const when = (entry) => depDate(entry.draft.fields) ?? '';
  plan.add.sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
  return plan;
}

/**
 * The patch that brings an imported booking up to date. Untouched since the import: title, legs and notes are
 * replaced. Edited by someone: only the flight details in the legs change, and each leg keeps its booking code.
 */
export function updatePatch(res, draft) {
  const edited = ownedHash(res) !== res.src?.hash;
  const legs = draft.fields.legs.map((leg, index) => compact({ ...leg, code: leg.code ?? res.legs?.[index]?.code }));
  const next = edited
    ? { ...res, legs, src: draft.fields.src }
    : { ...res, title: draft.fields.title, legs, notes: draft.fields.notes, src: draft.fields.src };
  if (next.notes === undefined) delete next.notes;
  return resPatch(res, normalizeRes(next));
}

/**
 * The patch that links a booking added by hand to its AirTrail flight, filling the fields it lacks. `src.hash` is the
 * flight as AirTrail has it now, so later pulls offer it again only when it changes there.
 */
export function linkPatch(res, draft) {
  const filled = fillMissing(res, draft.fields);
  return resPatch(res, normalizeRes({ ...filled, review: res.review, src: { kind: 'airtrail', ext: draft.ext, hash: draft.hash } }));
}
