// AirTrail write-back (spec §22 [3]): flights booked in Trips go to the user's AirTrail as one flight per leg. A sent
// booking keeps `src: {kind: 'airtrail', ext: 'p:<id>[,<id>…]', hash}`: the `p:` marks Trips as the owner of its
// details, so pulls never overwrite it, and `hash` is its own content at the last send, so later edits can go out too.
import { isDate, isTime, isTimeZone, zonedInstant } from '../../shared/dates.js';
import { offsetAt } from '../ics/zones.js';
import { ownedHash } from './airtrail.js';
import { IntegrationError } from './errors.js';

const SERVICE = 'airtrail';
const CODE = /^[A-Za-z0-9]{3,4}$/;
export const PUSHED = 'p:';
export const MAX_PUSH = 50;

/** AirTrail flight ids of a booking sent from Trips, or null when it was not. */
export function pushedIds(res) {
  const ext = res?.src?.kind === 'airtrail' && typeof res.src.ext === 'string' ? res.src.ext : '';
  return ext.startsWith(PUSHED) ? ext.slice(PUSHED.length).split(',').filter(Boolean) : null;
}

const usableLeg = (leg) => CODE.test(leg?.from?.code ?? '') && CODE.test(leg?.to?.code ?? '') && isDate(leg?.dep?.date);

/**
 * What can go to AirTrail from a trip's bookings: `add` (flights booked here, every leg with airport codes and a date)
 * and `update` (sent flights edited since, with the same number of legs). `blocked` lists flights that cannot be sent
 * and why (`codes` or `legs`).
 */
export function pushPlan(reservations) {
  const plan = { add: [], update: [], blocked: [] };
  for (const res of reservations ?? []) {
    if (!res || res.deleted || res.type !== 'flight' || res.status === 'cancelled') continue;
    const legs = Array.isArray(res.legs) ? res.legs : [];
    const ids = pushedIds(res);
    if (res.src?.kind === 'airtrail' && !ids) continue;
    if (!legs.length || !legs.every(usableLeg)) { plan.blocked.push({ res, reason: 'codes' }); continue; }
    if (!ids) { plan.add.push({ res }); continue; }
    if (ownedHash(res) === res.src.hash) continue;
    if (ids.length !== legs.length) { plan.blocked.push({ res, reason: 'legs' }); continue; }
    plan.update.push({ res, ids });
  }
  return plan;
}

/** An ISO date-time for a local point: with its UTC offset when the zone is known, else as written. */
export function isoPoint(point, zone) {
  if (!isDate(point?.date)) return null;
  const time = isTime(point.time) ? point.time : '00:00';
  if (!isTimeZone(zone)) return `${point.date}T${time}:00`;
  let epoch;
  try { epoch = zonedInstant(point.date, time, zone, { disambiguation: 'earlier' }); } catch { return `${point.date}T${time}:00`; }
  const offset = offsetAt(zone, epoch);
  const abs = Math.abs(offset);
  return `${point.date}T${time}:00${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const text = (value, max = 500) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** One leg as an AirTrail flight. `me` is the AirTrail user id for the seat, when known. */
export function flightPayload(res, leg, { me = null } = {}) {
  if (!usableLeg(leg)) throw new IntegrationError('rejected', { service: SERVICE });
  const departure = isoPoint(leg.dep, leg.from.tz);
  const arrival = isDate(leg.arr?.date) && isTime(leg.arr?.time) ? isoPoint(leg.arr, leg.to.tz) : null;
  return {
    from: leg.from.code.toUpperCase(), to: leg.to.code.toUpperCase(), date: leg.dep.date,
    departure, arrival,
    airline: text(leg.carrier), flightNumber: text(leg.number, 40),
    note: text(res.notes, 10_000),
    seats: [{ userId: me, guestName: me ? null : 'Me', seat: null, seatNumber: text(leg.seat, 40), seatClass: text(leg.cls, 40) }],
  };
}

const idOf = (data) => {
  const value = data?.data?.id ?? data?.id ?? data?.flight?.id ?? data?.data?.flight?.id;
  return value === undefined || value === null || String(value).length > 100 || /[,\s]/.test(String(value)) ? null : String(value);
};
const missingRoute = (error) => error?.code === 'not_found' || (error?.code === 'rejected' && error.httpStatus === 405);

/** Creates one flight: `/api/v1/flights`, or the older `/api/flight/save` on servers without it. Resolves its id. */
export async function createFlight(client, payload, { signal } = {}) {
  let response;
  try { response = await client.request('/api/v1/flights', { method: 'POST', body: payload, signal }); }
  catch (error) {
    if (!missingRoute(error)) throw error;
    response = await client.request('/api/flight/save', { method: 'POST', body: payload, signal });
  }
  const id = idOf(response.data);
  if (!id) throw new IntegrationError('bad_response', { service: SERVICE });
  return id;
}

/** Updates one flight by id, with the same fallback. */
export async function updateFlight(client, id, payload, { signal } = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new IntegrationError('rejected', { service: SERVICE });
  try { await client.request(`/api/v1/flights/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload, signal }); }
  catch (error) {
    if (!missingRoute(error)) throw error;
    await client.request('/api/flight/save', { method: 'POST', body: { ...payload, id }, signal });
  }
}

/** The `src` a booking keeps once all its legs are in AirTrail. */
export const pushedSrc = (res, ids) => ({ kind: 'airtrail', ext: `${PUSHED}${ids.join(',')}`, hash: ownedHash(res) });

/**
 * Sends one plan entry. `add` creates each leg's flight (resuming from `done`, the ids already made for this booking,
 * so a retry does not duplicate them); `update` patches each one. Resolves the booking's new `src`.
 */
export async function pushBooking(client, entry, { me = null, done = [], signal } = {}) {
  const legs = entry.res.legs;
  const ids = entry.ids ? [...entry.ids] : [...done];
  for (let index = 0; index < legs.length; index += 1) {
    const payload = flightPayload(entry.res, legs[index], { me });
    if (entry.ids) await updateFlight(client, ids[index], payload, { signal });
    else if (!ids[index]) { ids[index] = await createFlight(client, payload, { signal }); done.push(ids[index]); }
  }
  return pushedSrc(entry.res, ids);
}
