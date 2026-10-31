import { invariant } from '../../shared/errors.js';
import { isUuid } from '../../shared/ids.js';
import { TIMING } from '../../shared/limits.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { handleFailure } from './path-a.js';

const VIEW = /^[a-zA-Z0-9:_-]{0,64}$/;
const ACTIVE = 5 * 60_000;
const MIN_GAP = 15_000;

/** Member regions are written by members and never validated by the worker, so every value is clamped here. */
export function regionValue(field, value, now = Date.now()) {
  if (!plainObject(value)) return null;
  if (field === 'pres') {
    return Number.isSafeInteger(value.at) && value.at > 0 ? { at: Math.min(value.at, now + 60_000), view: typeof value.view === 'string' && VIEW.test(value.view) ? value.view : '' } : null;
  }
  return field === 'seen' && Number.isSafeInteger(value.rev) && value.rev >= 0 ? { rev: value.rev } : null;
}

/**
 * Presence (`u:<uuid>:pres`, every 60 s while visible) and the read marker (`u:<uuid>:seen`). With a write handle the
 * member writes their own region and pays; the owner writes theirs directly; otherwise the worker `pres` op and
 * `me:seen:<spaceId>` stand in.
 */
export function createMemberRegion({ puter, api, ref, uid, writeHandle = null, ownerPrefix = null, personal, document = globalThis.document,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, onHandleError = () => {} }) {
  invariant(isUuid(uid), 'invalid_account');
  const members = new Map();
  let view = '';
  let timer;
  let soonTimer;
  let lastBeat = -Infinity;
  let pausedUntil = 0;
  let stopped = true;
  let direct = Boolean(writeHandle || ownerPrefix);
  const write = (field, value) => writeHandle ? puter.kv.set(field, value, { handle: writeHandle }) : puter.kv.set(`${ownerPrefix}u:${uid}:${field}`, value);

  function update(member, field, value) {
    const clean = value === null ? null : regionValue(field, value, now());
    if (value !== null && !clean) return;
    const entry = { ...(members.get(member) ?? {}) };
    if (clean) entry[field] = clean; else delete entry[field];
    if (Object.keys(entry).length) members.set(member, entry); else members.delete(member);
    onChange(member);
  }
  async function beat() {
    if (stopped || document?.hidden || now() < pausedUntil) return;
    lastBeat = now();
    try {
      if (direct) { await write('pres', { at: now(), view }); update(uid, 'pres', { at: now(), view }); }
      else {
        const result = await api.call(ref, 'pres', view ? { view } : {});
        for (const [member, at] of Object.entries(plainObject(result?.active) ? result.active : {})) if (isUuid(member)) update(member, 'pres', { at, view: '' });
      }
    } catch (error) {
      const kind = handleFailure(error);
      // Out of credit: presence pauses rather than retrying every minute.
      if (kind === 'credit' || error?.status === 402) pausedUntil = now() + 10 * 60_000;
      // A lost write handle: the owner of this region switches to the worker until the handle is re-shared.
      else if (kind === 'handle' && writeHandle) onHandleError(error);
    }
  }
  function schedule() {
    clearTimer(timer);
    if (!stopped) timer = setTimer(() => { void beat().finally(schedule); }, TIMING.presence);
  }
  // View and visibility changes write at most once per 15 s; the 60 s heartbeat carries the rest.
  function soon() {
    if (stopped || soonTimer !== undefined) return;
    const wait = lastBeat + MIN_GAP - now();
    if (wait <= 0) { void beat(); return; }
    soonTimer = setTimer(() => { soonTimer = undefined; void beat(); }, wait);
  }
  const visibility = () => { if (!document?.hidden) { soon(); schedule(); } };

  return {
    /** `onRegion` for createPathA. */
    receive: update,
    members() {
      const cutoff = now() - ACTIVE;
      return [...members].map(([member, entry]) => ({ uid: member, ...entry, active: (entry.pres?.at ?? 0) >= cutoff }));
    },
    start(currentView = '') {
      view = VIEW.test(currentView) ? currentView : '';
      if (!stopped) return;
      stopped = false;
      document?.addEventListener('visibilitychange', visibility);
      void beat(); schedule();
    },
    setWriteHandle(handle) { writeHandle = handle; direct = Boolean(writeHandle || ownerPrefix); },
    setView(next) { if (VIEW.test(next) && next !== view) { view = next; soon(); } },
    stop() { stopped = true; clearTimer(timer); clearTimer(soonTimer); soonTimer = undefined; document?.removeEventListener('visibilitychange', visibility); },
    async markSeen(rev) {
      invariant(Number.isSafeInteger(rev) && rev >= 0, 'invalid_revision');
      if ((members.get(uid)?.seen?.rev ?? -1) >= rev) return;
      let local = !direct;
      if (direct) {
        try { await write('seen', { rev }); } catch (error) {
          if (handleFailure(error) !== 'handle' || !writeHandle) throw error;
          onHandleError(error);
          local = true;
        }
      }
      if (local) await personal.set(`me:seen:${ref.s}`, rev);
      update(uid, 'seen', { rev });
    },
    async seen() {
      const known = members.get(uid)?.seen?.rev;
      if (known !== undefined || direct) return known ?? 0;
      const value = await personal.get(`me:seen:${ref.s}`);
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    },
  };
}
