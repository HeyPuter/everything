// Duplicate detection against the trip's bookings and between candidates, plus merging drafts.
import { comparePoints, groupOf, isTransport, legPoints, normalizeRes } from '../../res/index.js';

/** Confirmation codes compare without case, spaces or punctuation. */
export const codeKey = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const words = (value) => new Set(String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1));
const overlaps = (a, b) => { const left = words(a); return [...words(b)].some((word) => left.has(word)); };
const placeKey = (end) => (end?.code ? end.code.toUpperCase() : [...words(end?.name)].sort().join(' '));
const flightKey = (number) => String(number ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function codesOf(res) {
  const codes = new Set([codeKey(res.code), ...(res.legs ?? []).map((leg) => codeKey(leg.code))]);
  codes.delete('');
  return [...codes].filter((code) => code.length >= 4);
}
function providerOf(res, provider) {
  return provider ?? res.legs?.[0]?.carrier ?? res.location?.name ?? res.title;
}
const startDate = (res) => (isTransport(res.type) ? res.legs?.[0]?.dep?.date : res.start?.date) ?? res.start?.date;

function sameLeg(a, b) {
  if (!a?.dep?.date || a.dep.date !== b?.dep?.date) return null;
  const from = placeKey(a.from);
  const to = placeKey(a.to);
  if (!from || !to || from !== placeKey(b.from) || to !== placeKey(b.to)) return null;
  const left = flightKey(a.number);
  const right = flightKey(b.number);
  if (left && right) return left === right ? 'exact' : null;
  return 'likely';
}

/**
 * How `draft` matches an existing reservation `res`: `{reason: code|legs|dates, strength: exact|likely}` or null.
 * A shared confirmation code is exact when the provider, a leg or the start date also agree.
 */
export function compareBookings(draft, res, { provider } = {}) {
  if (groupOf(draft.type) !== groupOf(res.type)) return null;
  const codes = codesOf(res);
  const shared = codesOf(draft).some((code) => codes.includes(code));
  const legMatch = isTransport(draft.type) ? (draft.legs ?? []).map((leg) => (res.legs ?? []).map((other) => sameLeg(leg, other)).find(Boolean)).find(Boolean) ?? null : null;
  const sameStart = Boolean(startDate(draft)) && startDate(draft) === startDate(res);
  if (shared) {
    const corroborated = overlaps(providerOf(draft, provider), providerOf(res)) || legMatch || sameStart;
    return { reason: 'code', strength: corroborated ? 'exact' : 'likely' };
  }
  if (legMatch) return { reason: 'legs', strength: legMatch };
  if (!isTransport(draft.type) && draft.type === res.type && sameStart
    && (overlaps(draft.title, res.title) || overlaps(draft.location?.name, res.location?.name ?? res.title))) return { reason: 'dates', strength: 'likely' };
  return null;
}

const rank = (match) => (match ? (match.strength === 'exact' ? 2 : 1) + (match.reason === 'code' ? 0.5 : 0) : 0);

/** The strongest match for a candidate among reservations: `{resId, reason, strength}` or null. Cancelled ones count. */
export function findDuplicate(candidate, reservations) {
  let best = null;
  for (const res of reservations) {
    const match = compareBookings(candidate.draft, res, { provider: candidate.provider });
    if (match && rank(match) > rank(best)) best = { resId: res.id, ...match };
  }
  return best;
}

/**
 * Marks each candidate with `duplicate` (an existing booking) and `duplicateOf` (an earlier candidate) and sets a
 * default `action` for new candidates: exact duplicates are skipped, everything else is created. Candidates that
 * already carry an `action` keep it unless the duplicate it was based on is gone.
 */
export function markDuplicates(candidates, reservations) {
  const result = [];
  for (const candidate of candidates) {
    const duplicate = findDuplicate(candidate, reservations);
    let duplicateOf = null;
    for (const earlier of result) {
      if (earlier.action === 'discard') continue;
      const match = compareBookings(candidate.draft, earlier.draft, { provider: candidate.provider });
      if (match?.strength === 'exact') { duplicateOf = earlier.id; break; }
    }
    let action = candidate.action;
    if (action === 'update' && !duplicate) action = 'create';
    if (!action) action = duplicate?.strength === 'exact' || duplicateOf ? 'skip' : 'create';
    result.push({ ...candidate, duplicate, duplicateOf, action });
  }
  return result;
}

const textOf = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
function joinNotes(...notes) {
  const lines = [];
  for (const note of notes) for (const line of textOf(note).split('\n')) if (line.trim() && !lines.includes(line.trim())) lines.push(line.trim());
  return lines.length ? lines.join('\n') : undefined;
}
function sortLegs(legs) {
  return legs.map((leg, index) => ({ leg, index }))
    .sort((a, b) => comparePoints(legPoints(a.leg).dep, legPoints(b.leg).dep) || a.index - b.index).map((entry) => entry.leg);
}
function earliest(points) { return points.filter(Boolean).sort((a, b) => comparePoints(a, b) ?? 0)[0]; }
function latest(points) { return points.filter(Boolean).sort((a, b) => comparePoints(b, a) ?? 0)[0]; }

/**
 * One draft from several of the same group: transports join their legs in travel order (repeated legs once);
 * bookings span from the earliest start to the latest end. Text fields keep the first value; notes and travelers join.
 */
export function mergeDrafts(drafts) {
  if (!drafts.length) return null;
  const [first] = drafts;
  if (drafts.some((draft) => groupOf(draft.type) !== groupOf(first.type))) throw new Error('merge_mixed');
  const merged = structuredClone(first);
  for (const draft of drafts.slice(1)) {
    for (const key of ['code', 'url', 'location', 'stay', 'placeId']) if (merged[key] === undefined && draft[key] !== undefined) merged[key] = structuredClone(draft[key]);
  }
  merged.notes = joinNotes(...drafts.map((draft) => draft.notes));
  const people = [...new Set(drafts.flatMap((draft) => draft.people ?? []))];
  merged.people = people.length ? people : undefined;
  if (drafts.some((draft) => draft.status === 'confirmed')) merged.status = 'confirmed';
  if (isTransport(first.type)) {
    const seen = new Set();
    merged.legs = sortLegs(drafts.flatMap((draft) => draft.legs ?? [])).filter((leg) => {
      const key = JSON.stringify([placeKey(leg.from), placeKey(leg.to), leg.dep?.date, leg.dep?.time, flightKey(leg.number)]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    merged.title = '';
  } else {
    merged.start = earliest(drafts.map((draft) => draft.start));
    merged.end = latest(drafts.map((draft) => draft.end ?? draft.start));
  }
  return normalizeRes({ ...merged, review: true, title: merged.title || first.title });
}

/**
 * An existing reservation with empty fields filled from an imported draft: code, link, location, travelers,
 * stay times, and per-leg details when both have the same legs. Notes gain the imported lines they lack.
 * Returns the full next fields; the caller patches with `resPatch`.
 */
export function fillMissing(existing, draft) {
  const next = structuredClone(existing);
  for (const key of ['code', 'url', 'location', 'start', 'end']) if (next[key] === undefined && draft[key] !== undefined) next[key] = structuredClone(draft[key]);
  if (draft.stay) next.stay = { ...draft.stay, ...(next.stay ?? {}) };
  const people = [...new Set([...(next.people ?? []), ...(draft.people ?? [])])];
  if (people.length) next.people = people;
  next.notes = joinNotes(next.notes, draft.notes);
  if (isTransport(next.type)) {
    if (!next.legs?.length && draft.legs?.length) next.legs = structuredClone(draft.legs);
    else if (next.legs?.length === draft.legs?.length) {
      next.legs = next.legs.map((leg, index) => {
        const other = draft.legs[index];
        const filled = { ...leg, from: { ...other.from, ...leg.from }, to: { ...other.to, ...leg.to } };
        for (const key of ['carrier', 'number', 'seat', 'cls', 'code', 'platform', 'coach']) if (!filled[key] && other[key]) filled[key] = other[key];
        if (!filled.dep?.time && other.dep?.time && other.dep.date === filled.dep?.date) filled.dep = { ...filled.dep, time: other.dep.time };
        if (!filled.arr?.time && other.arr?.time) filled.arr = { ...other.arr };
        return filled;
      });
    }
  }
  return normalizeRes({ ...next, review: true });
}
