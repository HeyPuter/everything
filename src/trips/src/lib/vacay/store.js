// The user's own Vacay data, read and written directly in their KV (they pay). Writes are optimistic, serialized
// per key, and reverted to the last known cloud value when they fail.
import { GRANTS, GROUPS, INDEX, PLAN, PREFIX, SHARES, parseKey, relative } from './keys.js';
import { defaultPlan } from './defaults.js';
import { cleanIndex, readAllowance, readCalendar, readCompany, readEntry, readInvite, readPlan, readRecord, valid } from './model.js';

const BATCH = 100;
const READERS = { e: readEntry, company: readCompany, allow: readAllowance, cal: readCalendar, inv: readInvite };
const MAPS = { e: 'entries', company: 'company', allow: 'allowances', cal: 'calendars', inv: 'invites' };
const PRIVATE = { disableSharing: true };
const mapKey = (group, id) => (group === 'allow' ? Number(id) : id);

/** Batched `kv.get` in chunks of 100 keys; `options` carries a handle for other people's data. */
export async function getMany(puter, keys, options) {
  const values = [];
  for (let start = 0; start < keys.length; start += BATCH) {
    const chunk = keys.slice(start, start + BATCH);
    const result = await (options ? puter.kv.get(chunk, options) : puter.kv.get(chunk));
    values.push(...(Array.isArray(result) ? result : chunk.map(() => null)));
  }
  return values;
}

export function createVacayStore({ puter, now = Date.now, locale } = {}) {
  const listeners = new Set();
  const state = {
    loaded: false, plan: null, index: cleanIndex(null),
    entries: new Map(), company: new Map(), allowances: new Map(), calendars: new Map(), invites: new Map(),
    shares: {}, grants: {},
  };
  const confirmed = new Map();
  const writes = new Map();
  let subscription = null;
  let closed = false;

  const notify = (change) => { for (const listener of listeners) listener(change); };

  function applyValue(group, id, value) {
    const map = state[MAPS[group]];
    if (value == null) map.delete(mapKey(group, id)); else map.set(mapKey(group, id), value);
  }

  async function load() {
    const [plan, index, shares, grants] = await puter.kv.get([PLAN, INDEX, SHARES, GRANTS]);
    state.index = cleanIndex(index);
    state.shares = readRecord('shares', shares);
    state.grants = readRecord('grants', grants);
    for (const [key, record] of [[SHARES, state.shares], [GRANTS, state.grants]]) for (const [id, item] of Object.entries(record)) confirmed.set(`${key}:${id}`, item);
    state.plan = readPlan(plan);
    // First use: write the default plan. A damaged plan is shown as defaults and only replaced when saved.
    if (plan == null) {
      state.plan = readPlan(defaultPlan({ locale })) ?? defaultPlan({ locale });
      await puter.kv.set(PLAN, state.plan);
    } else if (!state.plan) state.plan = readPlan(defaultPlan({ locale })) ?? defaultPlan({ locale });
    confirmed.set(PLAN, state.plan);
    const wanted = [];
    for (const group of Object.keys(GROUPS)) for (const id of Object.keys(state.index[group])) wanted.push([group, id]);
    const values = await getMany(puter, wanted.map(([group, id]) => GROUPS[group].key(id)));
    for (const map of Object.values(MAPS)) state[map].clear();
    wanted.forEach(([group, id], position) => {
      const value = READERS[group](values[position]);
      confirmed.set(GROUPS[group].key(id), value);
      if (value) applyValue(group, id, value);
    });
    state.loaded = true;
    notify({ type: 'load' });
    return state;
  }

  /** Runs `perform(value)` for `key`, coalescing rapid changes; on failure restores the last confirmed value. */
  function commit(key, value, apply, perform) {
    apply(value);
    let slot = writes.get(key);
    if (slot) { slot.desired = value; return slot.promise; }
    slot = { desired: value };
    writes.set(key, slot);
    slot.promise = (async () => {
      let sent;
      try {
        do { sent = slot.desired; await perform(sent); confirmed.set(key, sent); } while (slot.desired !== sent);
      } catch (error) {
        apply(confirmed.has(key) ? confirmed.get(key) : null);
        throw error;
      } finally { writes.delete(key); }
    })();
    return slot.promise;
  }

  // The index names a key before it exists and after it is gone, so a failed write never leaves an unlisted key.
  function putIndexed(group, id, value) {
    const key = GROUPS[group].key(id);
    return commit(key, value, (next) => { applyValue(group, id, next); notify({ type: group, id }); }, async (next) => {
      if (next == null) {
        await puter.kv.del(key);
        await puter.kv.remove(INDEX, `${group}.${id}`);
        delete state.index[group][id];
      } else {
        const at = now();
        await puter.kv.update(INDEX, { [`${group}.${id}`]: at });
        state.index[group][id] = at;
        await puter.kv.set(key, next);
      }
    });
  }

  function putRecord(type, id, value) {
    const key = type === 'shares' ? SHARES : GRANTS;
    return commit(`${key}:${id}`, value, (next) => {
      const record = { ...state[type] };
      if (next == null) delete record[id]; else record[id] = next;
      state[type] = record;
      notify({ type, id });
    }, async (next) => {
      if (next == null) await puter.kv.remove(key, id, PRIVATE);
      else await puter.kv.update(key, { [id]: next }, PRIVATE);
    });
  }

  function onEvent(event) {
    if (!event?.key || !event.key.startsWith(PREFIX) || writes.has(event.key)) return;
    const missing = event.op !== 'del' && event.value === undefined;
    if (event.key === PLAN) {
      const plan = readPlan(event.value);
      if (plan) { state.plan = plan; confirmed.set(PLAN, plan); notify({ type: 'plan' }); } else if (missing) void refresh(PLAN);
      return;
    }
    if (event.key === INDEX) { if (event.value !== undefined) state.index = cleanIndex(event.value); return; }
    const parsed = parseKey(event.key);
    if (!parsed) return;
    if (missing) { void refresh(event.key); return; }
    const value = event.op === 'del' ? null : READERS[parsed.group](event.value);
    confirmed.set(event.key, value);
    applyValue(parsed.group, parsed.id, value);
    notify({ type: parsed.group, id: parsed.id, remote: true });
  }

  async function refresh(key) {
    const value = await puter.kv.get(key).catch(() => undefined);
    if (value === undefined || closed) return;
    onEvent({ key, value, op: value == null ? 'del' : 'set' });
  }

  return {
    state,
    load,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pending: () => writes.size,
    setEntry(date, entry) { return putIndexed('e', date, entry ? readEntry(entry) : null); },
    setCompany(date, day) { return putIndexed('company', date, day ? readCompany(day) ?? {} : null); },
    setAllowance(year, value) { return putIndexed('allow', String(year), value ? readAllowance(value) : null); },
    setCalendar(id, value) { return putIndexed('cal', id, value ? readCalendar(value) : null); },
    setInvite(hash, value) { return putIndexed('inv', hash, value ? readInvite(value) : null); },
    /** Replaces the plan; invalid plans are refused. */
    setPlan(plan) {
      const next = valid('plan', plan);
      if (!next) return Promise.reject(Object.assign(new Error('invalid_plan'), { code: 'invalid_plan' }));
      return commit(PLAN, next, (value) => { state.plan = readPlan(value) ?? state.plan; notify({ type: 'plan' }); }, (value) => puter.kv.set(PLAN, value));
    },
    setShare(hash, value) { return putRecord('shares', hash, value ? readRecord('shares', { [hash]: value })[hash] ?? null : null); },
    setGrant(hash, value) { return putRecord('grants', hash, value ? readRecord('grants', { [hash]: value })[hash] ?? null : null); },
    /** Other sessions of this user write the same keys; events are hints, so a missed one is fixed by the next load. */
    async watch() {
      if (subscription || closed) return;
      try {
        subscription = await puter.events.onLocal(`kv:${puter.appID}:${PREFIX}*`, ({ event }) => {
          if (event?.op === 'gap') notify({ type: 'gap' }); else onEvent(event);
        }, { includeValue: true });
        if (closed) { void subscription.off?.(); subscription = null; }
      } catch { subscription = null; }
    },
    close() { closed = true; listeners.clear(); void subscription?.off?.(); subscription = null; },
    relative,
  };
}
