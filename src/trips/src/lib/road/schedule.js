import { timeMinutes } from '../../shared/dates.js';
import { LATE_TOLERANCE } from '../schedule/engine.js';

// Times are trip minutes: day index × 1440 + minutes after local midnight (wall clock, no zone shifts).
export const DAY = 1440;
const EPSILON = 0.01;
// Departures may move this early (04:00) to make a fixed time after a night.
const EARLIEST = 240;
const PASSES = 4;

/** Trip minutes → `{day, minutes}` with minutes in 0–1439. */
export const splitTime = (value) => ({ day: Math.floor(value / DAY), minutes: ((Math.round(value) % DAY) + DAY) % DAY });

/**
 * Schedules the chain (`buildChain`) for driving: stay per stop, fixed times, the daily window, the longest drive at
 * once (breaks), driving per day (night pauses), booked nights and day ends placed along legs.
 * - `legTime(leg)` → `{minutes, meters, estimated}` for drive, walk, bike and transit legs.
 * - `prefs`: `readPrefs` output (`start`, `end`, `stint`, `daily`, `pause`).
 * - `dayEnds`: `Map<legKey, [{fraction, id}]>`, nights placed along legs (fraction 0 sleeps at the start, 1 at the end).
 *
 * A leg to a stop planned on a later day has a night: at its day end when one is placed, else at its start. Drives
 * that run past the window or the daily limit pause for the night where the limit is reached, unless the stop is an
 * anchor for that day (a booked night or a fixed time), which only warns. Fixed times pull departures after a night
 * earlier when needed, and early arrivals move the wait back to the previous stop (`leaveBy`).
 *
 * Returns `{stops: Map<nodeKey, {arrive, start, depart, wait, late, day, leaveBy?}>, drives: Map<legKey, {start, end,
 * minutes, meters, estimated, nights: [{at, source, count, resume}], breaks: [{at, start, minutes}]}>, days: [{index,
 * drive, distance, start, end, overDaily, overWindow}], warnings: [{code, node?, leg?, day?, minutes?, days?}], totals}`.
 * Night sources: plan (the day changes there), manual (a day end), window, daily.
 */
export function scheduleRoad({ chain, legTime, prefs, dayEnds = new Map() }) {
  let early = new Map();
  let result = null;
  for (let pass = 0; pass < PASSES; pass++) {
    result = forward({ chain, legTime, prefs, dayEnds, early });
    const next = earlyStarts(chain, result, early);
    if (!next) break;
    early = next;
  }
  anchorBackward(chain, result);
  return result;
}

function forward({ chain, legTime, prefs, dayEnds, early }) {
  const { nodes, legs } = chain;
  const W0 = timeMinutes(prefs.start); const W1 = timeMinutes(prefs.end);
  const S = prefs.stint; const L = prefs.daily; const B = prefs.pause;
  const stops = new Map(); const drives = new Map(); const warnings = []; const stats = new Map();
  const legFrom = new Map(legs.map((leg) => [leg.from, leg]));
  const stat = (day) => {
    if (!stats.has(day)) stats.set(day, { index: day, drive: 0, distance: 0, start: null, end: null, overDaily: false, overWindow: false });
    return stats.get(day);
  };
  if (!nodes.length) return { stops, drives, days: [], warnings, totals: { distance: 0, drive: 0, stops: 0, days: 0 } };

  let today = nodes[0].day;
  let T = today * DAY + W0;
  let driven = 0; let stint = 0;
  // The trip day runs from the window start to the next one, so a drive past midnight still belongs to it.
  const dayOf = (time) => Math.floor((time - W0) / DAY);
  function nextDay(at = 0) {
    const day = Math.max(today + 1, Math.ceil((T - W0) / DAY), at);
    const count = day - today;
    today = day; T = day * DAY + W0; driven = 0; stint = 0;
    return count;
  }

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const arrive = T;
    let start = arrive; let wait = 0; let late = 0;
    if (node.fixed !== null) {
      const target = node.day * DAY + node.fixed - node.buffer;
      if (arrive > target + LATE_TOLERANCE) {
        late = arrive - target;
        warnings.push({ code: node.kind === 'depart' ? 'missed' : 'late', node: node.key, minutes: Math.round(late) });
      } else if (target > arrive) { wait = target - arrive; start = target; }
    }
    if (node.kind === 'stay' && node.until !== null && arrive > node.day * DAY + node.until + LATE_TOLERANCE) {
      warnings.push({ code: 'checkin', node: node.key, minutes: Math.round(arrive - node.day * DAY - node.until) });
    }
    if (dayOf(arrive) > node.day && !(node.kind === 'stay' && node.morning)) warnings.push({ code: 'behind', node: node.key, days: dayOf(arrive) - node.day });
    // Waiting overnight (a ferry, a late booking) starts a new driving day; any stop long enough counts as a break.
    if (dayOf(start) > today) { today = dayOf(start); driven = 0; stint = 0; }
    if (wait + node.dwell >= B) stint = 0;
    let depart = start + node.dwell + node.post;
    T = depart;
    if (node.kind === 'stay' && !(node.morning && node.leaveDay === node.day)) {
      T = start;
      nextDay(node.leaveDay);
      if (early.has(node.key)) T = Math.min(T, early.get(node.key));
      depart = T;
    } else if (node.kind === 'stay') {
      depart = Math.max(start, early.get(node.key) ?? start);
      T = depart;
    }
    if (dayOf(arrive) >= 0) { const day = stat(Math.max(dayOf(arrive), 0)); day.end = arrive; }
    stops.set(node.key, { arrive, start, depart, wait, late, day: dayOf(arrive) });

    const leg = legFrom.get(i);
    if (!leg || leg.kind === 'none') continue;
    const to = nodes[leg.to];
    if (leg.kind === 'transport') {
      const startT = T;
      T += leg.estimate ?? 0;
      drives.set(leg.key, { start: startT, end: T, minutes: leg.estimate ?? 0, meters: 0, estimated: leg.estimate !== null, nights: [], breaks: [] });
      if (to.day > dayOf(T) && to.fixed === null) nextDay(to.day);
      continue;
    }
    const timing = legTime(leg) ?? { minutes: 0, meters: 0, estimated: true };
    const D = Math.max(0, timing.minutes);
    const meters = Math.max(0, timing.meters);
    if (leg.kind !== 'drive') {
      const startT = T;
      T += D;
      drives.set(leg.key, { start: startT, end: T, minutes: D, meters, estimated: timing.estimated, nights: [], breaks: [] });
      continue;
    }
    const placed = (dayEnds.get(leg.key) ?? []).map((item) => item.fraction).filter(Number.isFinite).sort((a, b) => a - b);
    const nights = []; const breaks = [];
    const crossing = to.day > today;
    const atStart = placed.some((f) => f <= EPSILON);
    const atEnd = placed.some((f) => f >= 1 - EPSILON);
    const middle = placed.filter((f) => f > EPSILON && f < 1 - EPSILON);
    if (atStart || (crossing && !placed.length)) {
      const count = nextDay(crossing ? to.day : 0);
      nights.push({ at: 0, source: atStart ? 'manual' : 'plan', count, resume: T });
    }
    const startT = T;
    if (stat(today).start === null) stat(today).start = startT;
    // A stop fixed on the day the drive starts (or a booked night) must be reached that day.
    const anchor = (to.kind === 'stay' || to.fixed !== null) && to.day <= today;
    let pos = 0;
    while (pos < D - EPSILON) {
      const manual = middle.find((f) => f * D > pos + EPSILON);
      const goal = manual !== undefined ? manual * D : D;
      const windowLeft = today * DAY + W1 - T;
      const dailyLeft = L - driven;
      const stintLeft = S - stint;
      const auto = manual === undefined && !anchor;
      if (auto && (windowLeft <= EPSILON || dailyLeft <= EPSILON)) {
        const count = nextDay();
        nights.push({ at: pos / D, source: dailyLeft <= EPSILON ? 'daily' : 'window', count, resume: T });
        stat(today).start ??= T;
        continue;
      }
      if (stintLeft <= EPSILON) {
        if (B > 0) breaks.push({ at: pos / D, start: T, minutes: B });
        T += B; stint = 0;
        continue;
      }
      let chunk = Math.min(goal - pos, stintLeft);
      if (auto) chunk = Math.min(chunk, windowLeft, dailyLeft);
      else {
        if (chunk > windowLeft + EPSILON) stat(today).overWindow = true;
        if (chunk > dailyLeft + EPSILON) stat(today).overDaily = true;
      }
      const day = stat(today);
      day.drive += chunk; day.distance += D > 0 ? meters * (chunk / D) : 0;
      T += chunk; pos += chunk; stint += chunk; driven += chunk;
      if (manual !== undefined && pos >= goal - EPSILON) {
        const count = nextDay();
        nights.push({ at: manual, source: 'manual', count, resume: T });
        stat(today).start ??= T;
      }
    }
    if (D <= EPSILON) stat(today).distance += meters;
    if (atEnd) { const count = nextDay(); nights.push({ at: 1, source: 'manual', count, resume: T }); }
    drives.set(leg.key, { start: startT, end: T, minutes: D, meters, estimated: timing.estimated, nights, breaks });
  }

  const indexes = [...stats.keys()];
  const first = Math.min(nodes[0].day, ...indexes); const last = Math.max(nodes.at(-1).day, ...indexes);
  const days = [];
  for (let index = first; index <= last; index++) {
    const day = stats.get(index) ?? { index, drive: 0, distance: 0, start: null, end: null, overDaily: false, overWindow: false };
    if (day.drive > L + EPSILON) day.overDaily = true;
    if (day.overDaily) warnings.push({ code: 'overDaily', day: index, minutes: Math.round(day.drive) });
    if (day.overWindow) warnings.push({ code: 'overWindow', day: index });
    days.push(day);
  }
  const driveList = [...drives.entries()].filter(([key]) => legs.find((leg) => leg.key === key)?.kind === 'drive').map(([, value]) => value);
  return {
    stops, drives, days, warnings,
    totals: {
      distance: driveList.reduce((sum, item) => sum + item.meters, 0),
      drive: driveList.reduce((sum, item) => sum + item.minutes, 0),
      stops: nodes.filter((node) => ['visit', 'booking'].includes(node.kind)).length,
      days: days.length,
      estimated: driveList.some((item) => item.estimated),
    },
  };
}

// A fixed time missed after a night: leave that night's stop earlier, down to 04:00, when nothing else is fixed between.
function earlyStarts(chain, result, early) {
  let changed = false;
  const next = new Map(early);
  for (const warning of result.warnings) {
    if (!['late', 'missed'].includes(warning.code)) continue;
    const index = chain.nodes.findIndex((node) => node.key === warning.node);
    for (let k = index - 1; k >= 0; k--) {
      const node = chain.nodes[k];
      if (node.fixed !== null) break;
      if (node.kind !== 'stay') continue;
      const stop = result.stops.get(node.key);
      const floor = Math.floor(stop.depart / DAY) * DAY + EARLIEST;
      const want = Math.max(floor, stop.depart - warning.minutes);
      if (want < stop.depart - EPSILON) { next.set(node.key, want); changed = true; }
      break;
    }
  }
  return changed ? next : null;
}

// Waiting before a fixed time is spent at the previous stop instead, when the leg between has no night or break.
function anchorBackward(chain, result) {
  const legTo = new Map(chain.legs.map((leg) => [leg.to, leg]));
  chain.nodes.forEach((node, index) => {
    const stop = result.stops.get(node.key);
    if (!stop?.wait || index === 0) return;
    const leg = legTo.get(index);
    const drive = leg ? result.drives.get(leg.key) : null;
    if (leg && (!drive || drive.nights.length || drive.breaks.length)) return;
    const previous = result.stops.get(chain.nodes[index - 1].key);
    if (!previous) return;
    previous.leaveBy = previous.depart + stop.wait;
    if (drive) { drive.start += stop.wait; drive.end += stop.wait; }
    stop.arrive += stop.wait;
  });
}
