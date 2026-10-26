import { stable } from '../../../services/core.js';
import { SPEEDS, straightRoute } from '../../../services/route.js';
import { createRoadRoute } from '../../../services/roadRoute.js';
import { createCorridor } from '../../../services/corridor.js';
import { createHazards } from '../../../services/hazards.js';
import {
  ROAD_PREFS_ID, buildChain, dayAvoid, densify, downsample, driveRuns, hazardsNearRoute, legForDayEnd, lineLength, planFuel, project,
  readPrefs, routeFlags, scheduleRoad, slice,
} from '../../../lib/road/index.js';
import { tripPlanner } from '../plan/schedule/planner.js';

const MAX_POINTS = 25;
const RETRY_AFTER = 60_000;
const ESTIMATE_RETRY = 10 * 60_000;
const HAZARD_REFRESH = 10 * 60_000;
const CACHE_LIMIT = 300;
const WATCHED = ['day', 'visit', 'place', 'res', 'via', 'dayEnd', 'dayTrack', 'rtPrefs', 'meta', 'file'];
export const ALTERNATIVES = Object.freeze({ fastest: [], noToll: ['toll'], noMotorway: ['motorway'], noFerry: ['ferry'] });
const states = new WeakMap();

const refOf = (node) => (node.kind === 'visit' ? { t: 'visit', id: node.id } : node.kind === 'stay' ? { t: 'res', id: node.id, stay: true } : { t: 'res', id: node.id });
const sameRef = (a, b) => a?.t === b?.t && a?.id === b?.id && Boolean(a?.stay) === Boolean(b?.stay);
const joinLines = (lines) => lines.reduce((all, line) => (all.length ? [...all, ...line.slice(1)] : [...line]), []);
function flatTrack(feature) {
  const geometry = feature?.geometry;
  const coords = geometry?.type === 'LineString' ? geometry.coordinates : geometry?.type === 'MultiLineString' ? geometry.coordinates.flat() : [];
  return downsample(coords.map((position) => [position[0], position[1]]), 2000);
}

/**
 * Road-trip state for one open trip, shared by the road view, the map overlay and the days view: the chain, its routed
 * legs (queued one request at a time), the schedule, range plan, flags and hazards. `retain()` starts watching the
 * trip and returns the release; routing and hazards stop when nothing holds the state.
 */
export function roadState(space, session) {
  const services = session?.services ?? null;
  const known = states.get(space);
  if (known && known.services === services) return known.api;
  const planner = tripPlanner(space, services?.route ?? null);
  const road = services?.context ? createRoadRoute({ context: services.context, route: services.route }) : null;
  const corridorService = services?.context ? createCorridor(services.context) : null;
  const hazardService = services?.context ? createHazards(services.context) : null;
  const listeners = new Set();
  const routes = new Map();
  const failed = new Map();
  const tracks = new Map();
  const queue = [];
  let holders = 0; let offSpace = null; let controller = null; let draining = false; let hazardTimer = 0;
  let version = 0; let cache = null;
  let hazards = { events: [], status: 'idle', at: 0, attribution: [] };
  let active = false; let selected = null;
  let corridor = { status: 'idle', results: [], scope: null, attribution: [], truncated: false, failed: 0 };

  // `data` changes invalidate the computed view; selection and search progress only tell listeners.
  const notify = (data = true) => {
    if (data) version++;
    for (const listener of [...listeners]) { try { listener(); } catch { /* A listener must not stop the others. */ } }
  };
  const remember = (map, key, value) => { map.delete(key); map.set(key, value); while (map.size > CACHE_LIMIT) map.delete(map.keys().next().value); };
  const can = (action) => { try { return Boolean(space.can(action)); } catch { return false; } };

  function prefs() { return readPrefs(space.get('rtPrefs', ROAD_PREFS_ID)); }
  function enabled() { return space.get('meta', 'meta')?.settings?.addons?.roadtrip === true; }

  // Day tracks: the track line for a day, once downloaded (proxied file read, once per session).
  function trackFor(dayId) {
    const entry = space.select.dayTrack.all().find((item) => item.dayId === dayId);
    const place = entry ? space.get('place', entry.placeId) : null;
    const fileId = place?.track?.fileId;
    if (!entry || !fileId) return null;
    const key = `${fileId}:${space.get('file', fileId)?.sha256 ?? ''}`;
    const known = tracks.get(key);
    if (Array.isArray(known)) return { entry, place, line: known };
    if (!known && session?.api && globalThis.navigator?.onLine !== false) {
      // The track reader brings in the gzip library, so it loads with the first track.
      tracks.set(key, import('../../../lib/io/track-file.js').then(({ downloadTrack }) => downloadTrack(space.ref, fileId, { api: session.api }))
        .then((feature) => { tracks.set(key, flatTrack(feature)); notify(); }, () => { tracks.set(key, 'failed'); notify(); }));
    }
    return { entry, place, line: null, failed: known === 'failed' };
  }

  // Each run of drive legs leaving on one day is routed in windows of at most 25 points with that day's avoid options.
  function runWindows(chain, run, avoid) {
    const points = []; const owner = [];
    run.legs.forEach((leg, index) => {
      const from = chain.nodes[leg.from]; const to = chain.nodes[leg.to];
      if (index === 0) points.push(from.point);
      for (const via of leg.vias) { points.push(via.point); owner.push(leg.key); }
      points.push(to.point); owner.push(leg.key);
    });
    const windows = [];
    for (let start = 0; start < points.length - 1; start += MAX_POINTS - 1) {
      const slicePoints = points.slice(start, Math.min(points.length, start + MAX_POINTS));
      windows.push({ points: slicePoints, owners: owner.slice(start, start + slicePoints.length - 1), key: stable({ points: slicePoints, avoid }), avoid });
    }
    return windows;
  }

  function routedLegs(chain, prefsValue) {
    const out = new Map(); const wanted = [];
    for (const run of driveRuns(chain)) {
      const avoid = dayAvoid(prefsValue, run.dayId);
      const parts = new Map();
      for (const window of runWindows(chain, run, avoid)) {
        const result = routes.get(window.key);
        if (!result || (result.estimated && Date.now() - result.at > ESTIMATE_RETRY)) wanted.push(window);
        if (!result) continue;
        window.owners.forEach((legKey, index) => {
          const segment = result.legs[index];
          if (!parts.has(legKey)) parts.set(legKey, []);
          parts.get(legKey).push({ ...segment, estimated: result.estimated, attribution: result.attribution });
        });
      }
      for (const leg of run.legs) {
        const segments = parts.get(leg.key);
        if (!segments || segments.length !== leg.vias.length + 1) continue;
        out.set(leg.key, {
          meters: segments.reduce((sum, item) => sum + item.distance, 0), minutes: segments.reduce((sum, item) => sum + item.duration, 0) / 60,
          line: joinLines(segments.map((item) => item.line)), estimated: segments.some((item) => item.estimated), routed: true,
          flags: segments.every((item) => item.flags) ? { toll: segments.some((item) => item.flags.toll), ferry: segments.some((item) => item.flags.ferry), motorway: segments.some((item) => item.flags.motorway) } : null,
          attribution: segments.flatMap((item) => item.attribution ?? []),
        });
      }
    }
    return { out, wanted };
  }

  function compute() {
    const prefsValue = prefs();
    const model = planner.model();
    const chain = buildChain({ model, vias: space.select.via.all() });
    const { out: routed, wanted } = routedLegs(chain, prefsValue);
    const dayIndex = new Map(model.days.map((day, index) => [day.id, index]));
    const info = new Map();
    const offTrack = [];
    for (const leg of chain.legs) {
      const from = chain.nodes[leg.from]; const to = chain.nodes[leg.to];
      const points = [from.point, ...leg.vias.map((via) => via.point), to.point];
      if (leg.kind === 'transport' || leg.kind === 'none') { info.set(leg.key, { meters: 0, minutes: leg.estimate ?? 0, line: points, estimated: leg.estimate !== null, routed: false, flags: null }); continue; }
      if (leg.kind !== 'drive') {
        const line = straightRoute(points, leg.kind);
        info.set(leg.key, { meters: line.distance, minutes: line.duration / 60, line: points, estimated: true, routed: false, flags: null });
        continue;
      }
      const track = trackFor(leg.dayId);
      if (track?.line?.length > 1) {
        const a = project(track.line, from.point); const b = project(track.line, to.point);
        const limit = track.entry.strayKm * 1000;
        if (a.distance <= limit && b.distance <= limit) {
          const part = a.fraction <= b.fraction ? slice(track.line, a.fraction, b.fraction) : slice(track.line, b.fraction, a.fraction).reverse();
          const meters = lineLength(part) + a.distance + b.distance;
          info.set(leg.key, { meters, minutes: meters / 1000 / SPEEDS.drive * 60, line: [from.point, ...part, to.point], estimated: true, routed: false, flags: null, track: track.place.id });
          continue;
        }
        offTrack.push({ leg: leg.key, node: a.distance > limit ? from.key : to.key, km: Math.max(a.distance, b.distance) / 1000 });
      }
      const value = routed.get(leg.key);
      if (value) { info.set(leg.key, value); continue; }
      // The plan view's own route for the same stops, until the road route arrives.
      const shared = planner.latest(leg.dayId)?.legs?.find((item) => sameRef(item.from, refOf(from)) && sameRef(item.to, refOf(to)) && item.mode === 'drive');
      if (shared && !leg.vias.length && !dayAvoid(prefsValue, leg.dayId).length) {
        info.set(leg.key, { meters: shared.distance, minutes: shared.duration / 60, line: points, estimated: shared.estimated, routed: false, flags: null });
        continue;
      }
      const line = straightRoute(points, 'drive');
      info.set(leg.key, { meters: line.distance, minutes: line.duration / 60, line: points, estimated: true, routed: false, flags: null });
    }
    const legTime = (leg) => info.get(leg.key) ?? null;
    const dayEnds = new Map();
    const staleEnds = [];
    for (const end of space.select.dayEnd.all()) {
      const leg = legForDayEnd(chain, end, (id) => dayIndex.get(id));
      if (!leg) { staleEnds.push(end); continue; }
      if (!dayEnds.has(leg.key)) dayEnds.set(leg.key, []);
      dayEnds.get(leg.key).push({ fraction: end.fraction, id: end.id });
    }
    const schedule = scheduleRoad({ chain, legTime, prefs: prefsValue, dayEnds });
    const fuel = planFuel({ chain, legTime, prefs: prefsValue });
    const flags = routeFlags(chain, new Map([...info].filter(([, value]) => value.flags).map(([key, value]) => [key, value.flags])));
    const lines = chain.legs.filter((leg) => leg.kind === 'drive').map((leg) => ({ leg: leg.key, line: densify(info.get(leg.key).line, 5, 800) }));
    const near = hazardsNearRoute(hazards.events, lines);
    const attribution = [];
    for (const value of info.values()) for (const credit of value.attribution ?? []) if (credit?.url && !attribution.some((item) => item.url === credit.url && item.text === credit.text)) attribution.push(credit);
    return { prefs: prefsValue, model, chain, info, schedule, fuel, flags, dayEnds, staleEnds, offTrack, hazards: near, wanted, attribution, days: model.days };
  }

  function view() {
    // Without holders nothing watches the trip, so nothing can be cached.
    if (!holders || !cache || cache.version !== version) cache = { version, value: compute() };
    if (holders && enabled()) for (const window of cache.value.wanted) want(window);
    return cache.value;
  }

  function want(window) {
    const known = routes.get(window.key);
    // Estimates are asked again after a while, in case routing has become available.
    if (known && !(known.estimated && Date.now() - known.at > ESTIMATE_RETRY)) return;
    if (!road || queue.some((item) => item.key === window.key) || Date.now() - (failed.get(window.key) ?? -Infinity) < RETRY_AFTER) return;
    queue.push(window);
    if (!draining) void drain();
  }
  async function drain() {
    draining = true;
    controller ??= new AbortController();
    const { signal } = controller;
    while (queue.length && !signal.aborted) {
      const window = queue.shift();
      try {
        const result = await road.route(window.points, { avoid: window.avoid, signal });
        remember(routes, window.key, { ...result, at: Date.now() });
        notify();
      } catch (error) {
        if (error?.name === 'AbortError') break;
        failed.set(window.key, Date.now());
      }
    }
    draining = false;
  }

  async function refreshHazards({ force = false } = {}) {
    if (!hazardService || !holders || !active) return;
    if (!force && hazards.status === 'loading') return;
    if (!force && Date.now() - hazards.at < HAZARD_REFRESH && hazards.status === 'ready') return;
    const current = view();
    const points = current.chain.nodes.map((node) => node.point);
    if (!points.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lng, lat] of [...points, ...[...current.info.values()].flatMap((value) => value.line)]) { w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat); }
    hazards = { ...hazards, status: 'loading' };
    notify(false);
    const results = await Promise.allSettled([hazardService.gdacs(), hazardService.dwd([w - 0.2, s - 0.2, e + 0.2, n + 0.2])]);
    const values = results.map((item) => (item.status === 'fulfilled' ? item.value : undefined));
    const events = values.flatMap((value) => value?.data ?? []);
    const offline = values.some((value) => value === null) && !events.length;
    const errored = results.every((item) => item.status === 'rejected');
    hazards = {
      events, at: Date.now(), status: errored ? 'error' : offline ? 'offline' : 'ready',
      stale: values.some((value) => value?.stale), attribution: values.flatMap((value) => value?.attribution ?? []),
    };
    notify();
  }

  function retain() {
    holders++;
    if (holders === 1) {
      offSpace = space.subscribe((event) => { if (WATCHED.some((type) => event.types.has(type))) notify(); });
      const offPlanner = planner.subscribe(() => notify());
      const prior = offSpace;
      offSpace = () => { prior(); offPlanner(); };
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders--;
      if (holders > 0) return;
      offSpace?.(); offSpace = null;
      controller?.abort(); controller = null; queue.length = 0;
      clearInterval(hazardTimer); hazardTimer = 0;
    };
  }

  async function compare(dayId, { signal } = {}) {
    const current = view();
    const runs = driveRuns(current.chain).filter((run) => run.dayId === dayId);
    const out = {};
    for (const [name, avoid] of Object.entries(ALTERNATIVES)) {
      let meters = 0; let minutes = 0; let estimated = false; let flags = { toll: false, ferry: false, motorway: false }; let known = true;
      for (const run of runs) {
        for (const window of runWindows(current.chain, run, avoid)) {
          let result = routes.get(window.key);
          if (!result && road) { result = { ...(await road.route(window.points, { avoid, signal })), at: Date.now() }; remember(routes, window.key, result); }
          if (!result) continue;
          estimated ||= result.estimated;
          for (const leg of result.legs) {
            meters += leg.distance; minutes += leg.duration / 60;
            if (leg.flags) flags = { toll: flags.toll || leg.flags.toll, ferry: flags.ferry || leg.flags.ferry, motorway: flags.motorway || leg.flags.motorway };
            else known = false;
          }
        }
      }
      out[name] = { meters, minutes, estimated, flags: known ? flags : null };
    }
    notify();
    return out;
  }

  const api = {
    space, session, services, planner, corridorService,
    prefs, enabled, view, retain, compare,
    canEdit: () => can('plan.edit'), canTrip: () => can('trip.edit'),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get version() { return version; },
    get hazards() { return hazards; },
    refreshHazards,
    get active() { return active; },
    setActive(value) {
      if (active === value) return;
      active = value;
      clearInterval(hazardTimer); hazardTimer = 0;
      if (active) { void refreshHazards(); hazardTimer = setInterval(() => { if (!document.hidden) void refreshHazards(); }, HAZARD_REFRESH); }
      notify(false);
    },
    get selected() { return selected; },
    select(value) { selected = value; notify(false); },
    get corridor() { return corridor; },
    setCorridor(value) { corridor = { ...corridor, ...value }; notify(false); },
    notify,
  };
  states.set(space, { services, api });
  return api;
}
