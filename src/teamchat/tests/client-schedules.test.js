import { describe, it, expect, vi, afterEach } from 'vitest';
import { installDom } from './helpers/dom.js';

const REF = 'abc123def0@teamchat-test';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let dom;
afterEach(() => {
  vi.restoreAllMocks();
  dom?.uninstall(); dom = null;
  delete globalThis.puter;
});

async function setup({ granted = true, decline = false, scheduleError, failAttach = false } = {}) {
  dom = installDom();
  vi.resetModules();
  const calls = [];
  const queued = new Map();
  let n = 0;
  const events = {
    onSchedule: vi.fn(async (options) => {
      calls.push(['wake', options]);
      if (scheduleError) throw { code: scheduleError };
      return { scheduleId: `wake-${++n}` };
    }),
    removeSchedule: vi.fn(async (id) => { calls.push(['cancel', id]); }),
  };
  const perms = { check: vi.fn(async () => granted), request: vi.fn(async () => !decline) };
  globalThis.puter = {
    events, perms,
    workers: {
      exec: async (url, init) => {
        const path = new URL(url).pathname;
        const body = init.body ? JSON.parse(init.body) : {};
        calls.push([init.method, path, body]);
        if (init.method === 'POST') {
          const reminder = path.endsWith('/reminders');
          const e = { id: `entry-${queued.size}`, ...body, dueAt: Math.floor(body.dueAt), kind: reminder ? 'reminder' : 'message' };
          queued.set(e.id, e);
          return json({ [reminder ? 'reminder' : 'scheduled']: e });
        }
        const id = path.split('/').at(-1);
        const e = queued.get(id);
        if (!e) return json({ code: 'not_found' }, 404);
        if (body.scheduleId && body.scheduleFor !== e.dueAt) return json({ code: 'rescheduled' }, 409);
        if (body.scheduleId && failAttach) return json({ code: 'sending' }, 409);
        const previousScheduleId = e.scheduleId;
        if (init.method === 'DELETE' || body.sendNow) queued.delete(id);
        else queued.set(id, { ...e, ...body });
        return json({ ok: true, previousScheduleId });
      },
    },
  };
  const { store } = await import('../src/lib/store.js');
  store.wsId = REF;
  store.profile = { uuid: 'u-me', prefs: {} };
  store.ws = { id: 'abc123def0', channels: { c1: { id: 'c1' } }, members: {} };
  store.me = { channels: ['c1'], dms: {}, notify: {} };
  store._clockOffset = 5000;
  return { store, events, perms, calls, queued };
}

describe('client scheduled wake-ups', () => {
  it.each(['message', 'reminder'])('queues a %s, schedules its wake-up and persists the schedule id', async (kind) => {
    const { store, events, perms, calls, queued } = await setup({ granted: false });
    const dueAt = Date.now() + 60_000;
    const e = kind === 'message' ? await store.schedule('c1', { text: 'hello', dueAt }) : await store.remind('c1', 7, dueAt, 'check');
    expect(perms.request).toHaveBeenCalledWith('backgroundEvents');
    expect(events.onSchedule).toHaveBeenCalledWith({ at: dueAt + 5000, handlerName: 'teamchat-due-v1', context: { u: 'https://teamchat-test.puter.work', w: 'abc123def0' } });
    expect(e.scheduleId).toBe('wake-1');
    expect(queued.get(e.id).scheduleId).toBe('wake-1');
    expect(calls.map((c) => c[0])).toEqual(['POST', 'wake', 'PUT']);
  });

  it.each(['message', 'reminder', 'update'])('keeps one worker time through a clock sync during a %s write and consent', async (kind) => {
    const { store, events, perms, queued } = await setup();
    const entry = kind === 'update' ? await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 }) : null;
    const dueAt = Date.now() + 120_000;
    const exec = puter.workers.exec;
    puter.workers.exec = async (...args) => {
      const res = await exec(...args);
      store._clockOffset = 30_000;
      return res;
    };
    perms.check.mockResolvedValue(false);
    perms.request.mockImplementation(async () => {
      store._clockOffset = 60_000;
      return true;
    });
    if (kind === 'update') await store.updateScheduled(entry, { dueAt });
    else if (kind === 'reminder') await store.remind('c1', 7, dueAt);
    else await store.schedule('c1', { text: 'hello', dueAt });
    expect(events.onSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ at: dueAt + 5000 }));
    expect([...queued.values()].at(-1)).toMatchObject({ dueAt: dueAt + 5000, scheduleFor: dueAt + 5000, scheduleId: kind === 'update' ? 'wake-2' : 'wake-1' });
    expect(events.removeSchedule).not.toHaveBeenCalledWith(kind === 'update' ? 'wake-2' : 'wake-1');
  });

  it.each(['message', 'reminder'])('uses the worker-returned dueAt for a new %s', async (kind) => {
    const { store, events, queued } = await setup();
    const dueAt = Date.now() + 60_000 + 0.75;
    const e = kind === 'message' ? await store.schedule('c1', { text: 'hello', dueAt }) : await store.remind('c1', 7, dueAt);
    expect(events.onSchedule).toHaveBeenCalledWith(expect.objectContaining({ at: Math.floor(dueAt + 5000) }));
    expect(queued.get(e.id).scheduleFor).toBe(Math.floor(dueAt + 5000));
    expect(e.scheduleId).toBe('wake-1');
  });

  it.each(['events_handler_not_found', 'events_disabled', 'events_schedule_limit', 'events_schedule_budget', 'too_many_requests'])('keeps poll delivery on %s', async (scheduleError) => {
    const { store, queued } = await setup({ scheduleError });
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    expect(queued.has(e.id)).toBe(true);
    expect(e.scheduleId).toBeUndefined();
  });

  it('keeps poll delivery when consent is declined, without scheduling', async () => {
    const { store, events, queued } = await setup({ granted: false, decline: true });
    const e = await store.remind('c1', 1, Date.now() + 60_000);
    expect(queued.has(e.id)).toBe(true);
    expect(events.onSchedule).not.toHaveBeenCalled();
  });

  it('asks for background access once, not on every scheduled item after a decline', async () => {
    const { store, perms } = await setup({ granted: false, decline: true });
    vi.spyOn(store, 'updatePrefs').mockImplementation(async (patch) => Object.assign(store.profile.prefs, patch));
    await store.remind('c1', 1, Date.now() + 60_000);
    await store.schedule('c1', { text: 'later', dueAt: Date.now() + 60_000 });
    expect(perms.request).toHaveBeenCalledTimes(1);
    expect(store.profile.prefs.dueDeclined).toBe(true);
  });

  it('cancels the old wake-up after a reschedule succeeds and stores the replacement', async () => {
    const { store, events, queued } = await setup();
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    const dueAt = e.dueAt + 120_000;
    await store.updateScheduled(e, { dueAt });
    expect(events.removeSchedule).toHaveBeenCalledWith('wake-1');
    expect(events.onSchedule).toHaveBeenLastCalledWith(expect.objectContaining({ at: dueAt + 5000 }));
    expect(queued.get(e.id).scheduleId).toBe('wake-2');
  });

  it.each(['delete', 'sendNow'])('cancels after %s, tolerating an already-ended schedule', async (action) => {
    const { store, events, queued } = await setup();
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    events.removeSchedule.mockRejectedValue({ code: 'events_schedule_not_found' });
    if (action === 'delete') await store.deleteScheduled(e);
    else await store.updateScheduled(e, { sendNow: true });
    expect(events.removeSchedule).toHaveBeenCalledWith('wake-1');
    expect(queued.has(e.id)).toBe(false);
  });

  it('keeps the wake-up on a refused edit or deletion', async () => {
    const { store, events } = await setup();
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    puter.workers.exec = async () => json({ code: 'sending' }, 409);
    await expect(store.updateScheduled(e, { dueAt: e.dueAt + 60_000 })).rejects.toMatchObject({ status: 409 });
    await expect(store.deleteScheduled(e)).rejects.toMatchObject({ status: 409 });
    expect(events.removeSchedule).not.toHaveBeenCalled();
  });

  it('removes a wake-up when the item disappeared or changed before its id could be stored', async () => {
    const { store, events } = await setup({ failAttach: true });
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    expect(e.scheduleId).toBeUndefined();
    expect(events.removeSchedule).toHaveBeenCalledWith('wake-1');
  });

  it('preserves the wake-up for a text edit, whose due time is unchanged', async () => {
    const { store, events, queued } = await setup();
    const e = await store.schedule('c1', { text: 'hello', dueAt: Date.now() + 60_000 });
    await store.updateScheduled(e, { text: 'changed' });
    expect(events.onSchedule).toHaveBeenCalledTimes(1);
    expect(events.removeSchedule).not.toHaveBeenCalled();
    expect(queued.get(e.id).text).toBe('changed');
  });
});
