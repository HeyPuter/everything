import { boxPath, dayFolder } from './mailbox.js';
import { flagId } from './readstate.js';

export const SNOOZE_HANDLER = 'mail-snooze-v1';
const PREFIX = 'snooze:';
const WOKEN = 'woken:';
const missing = (error) => ['subject_does_not_exist', 'not_found'].includes(error?.code);
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;

/** Calendar arithmetic keeps mornings at 08:00 across daylight saving changes. */
export function snoozePresets(now = new Date()) {
  const morning = (days) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 8);
  const later = new Date(now);
  later.setHours(now.getHours() + 3, 0, 0, 0);
  if (later.getTime() <= now.getTime() + 2 * 3600000) later.setHours(later.getHours() + 1);
  const evening = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18);
  const today = later < evening ? later : evening;
  const weekday = now.getDay();
  return [
    { label: 'Later today', until: +today },
    { label: 'Tomorrow 08:00', until: +morning(1) },
    { label: 'This weekend', until: +morning(6 - (weekday || 7)) },
    { label: 'Next week', until: +morning(8 - (weekday || 7)) },
  ].filter(({ until }) => until > +now);
}

export const localDateTime = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const snoozeTime = (until) => new Date(until).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** One KV entry per message: a worker never overwrites another message's state. */
export function createSnooze({ fs, mailPath, scope, storage, kv = null, events = null, perms = null }) {
  const localKey = `puter-mail:snooze:${scope}`;
  let records = {};
  let woken = {};
  let declined = false;
  try {
    ({ records = {}, woken = {}, declined = false } = JSON.parse(storage.getItem(localKey) || '{}'));
  } catch {}
  const readDeclined = () => {
    try { declined ||= !!JSON.parse(storage.getItem(localKey) || '{}').declined; } catch {}
  };
  const persist = () => {
    readDeclined();
    storage.setItem(localKey, JSON.stringify({ records, woken, declined }));
  };
  const save = async (id, record) => {
    if (kv) {
      if (record) await kv.set(`${PREFIX}${id}`, record);
      else await kv.del(`${PREFIX}${id}`);
    }
    if (record) records[id] = record;
    else delete records[id];
    // The account copy is authoritative; a full local cache must not fail a move.
    if (kv) { try { persist(); } catch {} }
    else persist();
  };
  const read = async (id) => {
    if (!kv) return records[id] ?? null;
    const record = parse(await kv.get(`${PREFIX}${id}`));
    if (record) records[id] = record;
    else delete records[id];
    return record;
  };
  const promote = async (id, value) => {
    if (kv) {
      if (value) await kv.set(`${WOKEN}${id}`, value);
      else await kv.del(`${WOKEN}${id}`);
    }
    if (value) woken[id] = value;
    else delete woken[id];
    try { persist(); } catch {}
  };
  const pull = async () => {
    if (!kv) return;
    const list = async (pattern) => {
      const found = {};
      let cursor;
      do {
        const page = await kv.list({ pattern, returnValues: true, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const { key, value } of page.items) found[key.slice(pattern.length)] = parse(value);
        cursor = page.cursor;
      } while (cursor);
      return found;
    };
    [records, woken] = await Promise.all([list(PREFIX), list(WOKEN)]);
    try { persist(); } catch {}
  };
  const removeSchedule = async (record) => {
    if (!record?.scheduleId || !events?.removeSchedule) return;
    try { await events.removeSchedule(record.scheduleId); }
    catch (error) { if (error?.code !== 'events_schedule_not_found') throw error; }
  };
  // Asked once per device; after a decline, snoozes wake when Mail is open.
  const consent = async () => {
    if (!kv || !events?.onSchedule || !perms?.request) return false;
    try {
      if (perms.check && await perms.check('backgroundEvents')) return true;
      readDeclined();
      if (declined) return false;
      const granted = !!(await perms.request('backgroundEvents'));
      if (!granted) {
        declined = true;
        try { persist(); } catch {}
      }
      return granted;
    } catch { return false; }
  };
  // `prior`: the schedule of an earlier snooze, moved to the new time rather than replaced.
  const schedule = async (id, record, background, prior = null) => {
    let reason = 'unavailable';
    if (background && kv && events?.onSchedule) {
      try {
        const context = { id, token: record.token, mailPath };
        let scheduleId = null;
        if (prior) {
          try { ({ scheduleId } = await events.updateSchedule(prior, { at: record.until, context })); }
          catch (error) {
            if (error?.code !== 'events_schedule_not_found') {
              await removeSchedule({ scheduleId: prior }).catch(() => {});
              throw error;
            }
          }
        }
        scheduleId ??= (await events.onSchedule({ at: record.until, handlerName: SNOOZE_HANDLER, context })).scheduleId;
        const current = await read(id);
        if (current?.token !== record.token) {
          await removeSchedule({ scheduleId });
          return { background: false, reason: 'changed' };
        }
        try { await save(id, { ...current, scheduleId }); }
        catch (error) {
          await removeSchedule({ scheduleId });
          throw error;
        }
        return { background: true };
      } catch (error) { reason = error?.code || 'unavailable'; }
    }
    return { background: false, reason };
  };

  const snooze = async (message, until, { background = false, previews = true } = {}) => {
    if (!Number.isFinite(until) || until <= Date.now()) throw new Error('Choose a future time.');
    const id = flagId(message.name);
    const old = await read(id);
    // Kept to be moved; until then its run finds the token changed and does nothing.
    const prior = background && events?.updateSchedule ? old?.scheduleId : null;
    if (!prior) await removeSchedule(old);
    const path = `${boxPath(mailPath, 'snoozed')}/${message.day}/${message.name}`;
    const record = {
      until, from: old?.from ?? { box: message.box, path: message.path, day: message.day },
      path, name: message.name, day: message.day, token: crypto.randomUUID(), previews,
    };
    await save(id, record);
    if (message.box !== 'snoozed') {
      try {
        await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { createMissingParents: true }).catch(() => {});
        await fs.move(message.path, path.slice(0, path.lastIndexOf('/')), { newName: message.name });
      } catch (error) {
        if ((await read(id))?.token === record.token) await save(id, old);
        throw error;
      }
    }
    await promote(id, null).catch(() => {});
    return { path, record, previous: old, ...await schedule(id, record, background, prior) };
  };

  /** Invalidate the old handler before another action moves a snoozed file. */
  const leave = async (message, operation) => {
    const id = flagId(message.name);
    const old = await read(id);
    await removeSchedule(old);
    if (old) await save(id, { ...old, scheduleId: undefined, token: crypto.randomUUID() });
    let result;
    try { result = await operation(); }
    catch (error) {
      if (old) {
        const restored = { ...old, scheduleId: undefined, token: crypto.randomUUID() };
        await save(id, restored);
        await schedule(id, restored, !!old.scheduleId);
      }
      throw error;
    }
    if (old) await save(id, null).catch(() => {});
    await promote(id, null).catch(() => {});
    return { result, previous: old };
  };

  const wake = async (id, { now = Date.now(), force = false } = {}) => {
    const record = await read(id);
    if (!record || (!force && record.until > now)) return null;
    // A suspended or disabled scheduler must not prevent the client fallback.
    await removeSchedule(record).catch(() => {});
    const token = crypto.randomUUID();
    await save(id, { ...record, token, scheduleId: undefined });
    if ((await read(id))?.token !== token) return null;
    const day = dayFolder(new Date(now));
    const dir = `${boxPath(mailPath, 'inbox')}/${day}`;
    const path = `${dir}/${record.name}`;
    await fs.mkdir(dir, { createMissingParents: true }).catch(() => {});
    await promote(id, { at: now, path });
    try {
      await fs.move(record.path, dir, { newName: record.name });
    } catch (error) {
      if (!missing(error)) throw error;
      // Another tab or the worker won the move. Never announce it again.
      if ((await read(id))?.token === token) await save(id, null);
      return null;
    }
    if ((await read(id))?.token === token) await save(id, null);
    return { id, name: record.name, path, day, record };
  };
  let waking = null;
  const wakeDue = async () => {
    if (waking) { await waking; return []; }
    waking = (async () => {
      await pull();
      const due = Object.entries(records).filter(([, record]) => record?.until <= Date.now());
      const results = [];
      for (const [id] of due) {
        try { const result = await wake(id); if (result) results.push(result); }
        catch { /* A later tick retries a failed move. */ }
      }
      return results;
    })().finally(() => { waking = null; });
    return waking;
  };
  return {
    snooze, leave, wake, wakeDue, pull, consent,
    forgetPromotion: (name) => promote(flagId(name), null),
    markReturned: (name, path) => promote(flagId(name), { path, at: Date.now() }),
    get: (name) => records[flagId(name)] ?? null,
    promotions: () => Object.values(woken),
    async restore(message, record, background) {
      await save(flagId(message.name), record);
      return schedule(flagId(message.name), record, background);
    },
  };
}
