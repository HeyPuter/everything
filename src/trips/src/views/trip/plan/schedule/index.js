import './schedule.css';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { dayStays } from '../../../../lib/res/index.js';
import { clearablePatches, scheduleDay } from '../../../../lib/schedule/index.js';
import { DAY_START } from '../../../../lib/timeline/index.js';
import { isTime, minutesTime } from '../../../../shared/dates.js';
import { refreshPlanHooks, registerPlanHooks } from '../hooks.js';
import { timelineOf } from '../ops.js';
import { tripPlanner } from './planner.js';
import { createHoursSource } from './hours.js';
import { connector, rowDetail } from './render.js';
import { visitFields } from './fields.js';
import { openAutoSchedule } from './dialog.js';

const REFRESH_DELAY = 400;
const RETRY_AFTER = 60_000;
const PREPARE_LIMIT = 6000;
const storageKey = (spaceId) => `trips:schedule:${spaceId}`;

/**
 * Time-aware scheduling in the Plan tab, through the plan hooks (hooks.js): estimated times, travel, dwell and
 * warnings on each day, dwell and fixed-time fields in the visit form, and Auto schedule / Clear times per day.
 * `context` is the Plan tab pane context (`space`, `session`, `plan`). Returns the cleanup.
 */
export function mountSchedule({ space, session, plan }) {
  if (!space?.select || !plan) return () => {};
  const route = session?.services?.route ?? null;
  const planner = tripPlanner(space, route);
  const controller = new AbortController();
  const { signal } = controller;
  const spaceId = space.ref?.s ?? 'trip';
  let refreshTimer = 0;
  // Day ids whose results changed since the last refresh; null means every day.
  let refreshDays = new Set();
  const refresh = (dayId) => {
    if (signal.aborted) return;
    if (typeof dayId === 'string' && refreshDays) refreshDays.add(dayId); else refreshDays = null;
    if (!refreshTimer) {
      refreshTimer = setTimeout(() => {
        refreshTimer = 0;
        const days = refreshDays;
        refreshDays = new Set();
        refreshPlanHooks(days ? [...days] : undefined);
      }, REFRESH_DELAY);
    }
  };
  let lang = 'en';
  try { lang = displayLocale(); } catch { /* Defaults to English. */ }
  const hours = createHoursSource({ services: session?.services, lang, onChange: () => refresh() });

  // The start time is remembered per trip on this device.
  function dayStart() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey(spaceId)) ?? '{}')?.start;
      return isTime(value) ? value : minutesTime(DAY_START);
    } catch { return minutesTime(DAY_START); }
  }
  function saveStart(value) {
    if (!isTime(value) || value === dayStart()) return;
    try { localStorage.setItem(storageKey(spaceId), JSON.stringify({ start: value })); } catch { /* A convenience only. */ }
    refresh();
  }

  // Days are routed one at a time, the selected one first; results land in the shared planner and refresh the plan.
  const queue = [];
  const failed = new Map();
  let draining = false;
  function wantRoute(dayId, latest) {
    if (!route || latest?.routed || queue.includes(dayId) || Date.now() - (failed.get(dayId) ?? -Infinity) < RETRY_AFTER) return;
    if (plan.get().day === dayId) queue.unshift(dayId); else queue.push(dayId);
    if (!draining) void drain();
  }
  async function drain() {
    draining = true;
    while (queue.length && !signal.aborted) {
      const dayId = queue.shift();
      try { await planner.day(dayId, { signal }); } catch (error) {
        if (error?.name === 'AbortError') break;
        failed.set(dayId, Date.now());
      }
    }
    draining = false;
  }

  function compute(entry, { auto = false, start = dayStart() } = {}) {
    const latest = planner.latest(entry.day.id);
    wantRoute(entry.day.id, latest);
    return scheduleDay({
      entry, auto, start, legs: latest?.legs ?? null,
      place: (id) => space.get('place', id) ?? null,
      hours: (place) => hours.get(place),
      stays: dayStays(space.select.res.all(), space.select.day.all(), entry.day.id),
    });
  }
  const nameOf = (entry) => (key) => {
    const row = entry.rows.find((item) => item.key === key);
    if (!row) return '';
    if (row.kind === 'visit') return (row.entity.placeId && space.get('place', row.entity.placeId)?.name) || row.entity.title || t('plan.untitled');
    return row.entity.title ?? '';
  };
  // Rows whose travel shows on the connector the day list draws between two located visits.
  function connected(entry) {
    const keys = new Set();
    entry.rows.forEach((row, index) => {
      const next = entry.rows[index + 1];
      if (row.kind === 'visit' && row.primary && next?.kind === 'visit' && next.primary && row.entity.placeId && next.entity.placeId) keys.add(next.key);
    });
    return keys;
  }

  function annotate({ entry, context }) {
    if (context?.space !== space) return null;
    const day = compute(entry);
    const linked = connected(entry);
    const timed = day.items.filter((item) => item.startWall || item.endWall);
    return new Map(day.items.map((item) => [item.key, { ...item, day, first: item === timed[0], last: item === timed.at(-1), connected: linked.has(item.key) }]));
  }

  function loadHours(dayId) {
    const entry = timelineOf(space).byDay.get(dayId);
    if (!entry) return Promise.resolve();
    const places = entry.rows.filter((row) => row.kind === 'visit' && row.entity.placeId).map((row) => space.get('place', row.entity.placeId)).filter(Boolean);
    return hours.load(places, { signal });
  }
  function prepare(dayId) {
    const jobs = [loadHours(dayId)];
    if (route) jobs.push(planner.day(dayId, { signal }));
    return Promise.race([Promise.allSettled(jobs), new Promise((resolve) => { setTimeout(resolve, PREPARE_LIMIT); })]);
  }

  const apply = (patches, label) => space.apply(patches.map((patch) => space.ops.patch('visit', patch.id, { set: patch.set, unset: patch.unset })), { history: label });
  const undo = () => { space.history.undo().catch(() => toast(t('schedule.saveFailed'))); };
  async function autoSchedule(dayId) {
    const done = await openAutoSchedule({
      dayId, compute, prepare, start: dayStart(), saveStart, nameOf,
      entryOf: (id) => timelineOf(space).byDay.get(id) ?? null,
      apply: (patches) => apply(patches, t('schedule.history')),
    });
    if (done && !signal.aborted) toast(t('schedule.applied'), { action: { label: t('schedule.undo'), onClick: undo } });
  }
  async function clearTimes(entry) {
    try {
      await apply(clearablePatches(entry), t('schedule.historyClear'));
      toast(t('schedule.cleared'), { action: { label: t('schedule.undo'), onClick: undo } });
    } catch { toast(t('schedule.saveFailed')); }
  }
  function dayActions({ entry, context }) {
    if (context?.space !== space || !space.can('plan.edit')) return [];
    if (!entry.rows.some((row) => row.kind === 'visit' && row.primary && row.phase === null)) return [];
    const items = [{ label: t('schedule.auto'), icon: 'clock', onSelect: () => { void autoSchedule(entry.day.id); } }];
    if (clearablePatches(entry).length) items.push({ label: t('schedule.clear'), onSelect: () => { void clearTimes(entry); } });
    return items;
  }

  const offs = [
    registerPlanHooks({
      annotate,
      rowDetail: ({ info, entry, context }) => (context?.space === space ? rowDetail(info, nameOf(entry)) : null),
      connector: ({ to, info, context }) => (context?.space === space ? connector(info?.get?.(`visit:${to.id}`)) : null),
      visitFields: ({ visit, context }) => (context?.space === space ? visitFields(space, visit) : null),
      dayActions,
    }),
    planner.subscribe(refresh),
    plan.subscribe((state, patch) => { if ('day' in patch && state.day) void loadHours(state.day); }),
  ];
  if (plan.get().day) void loadHours(plan.get().day);
  return () => {
    controller.abort();
    clearTimeout(refreshTimer);
    for (const off of offs) off();
  };
}
