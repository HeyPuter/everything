import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, as, USERS, workspaceWith, fakeAuthToken } from './helpers/harness.js';
import { KEYS } from '../src/shared/blocks.js';

const { alice, bob, carol } = USERS;
const handler = new Function(`return (\n${readFileSync(new URL('../handlers/due.js', import.meta.url), 'utf8')}\n)`)();
const ctx = { u: 'https://teamchat-test.puter.work', w: 'room' };
afterEach(() => vi.restoreAllMocks());

describe('due handler', () => {
  it('calls the authenticated worker without reading the response body', async () => {
    const exec = vi.fn(async () => new Response('', { status: 200 }));
    await handler({ ctx: { ...ctx, w: 'room:name' }, user: { workers: { exec } } });
    expect(exec).toHaveBeenCalledWith('https://teamchat-test.puter.work/api/ws/room%3Aname/due', { method: 'POST' });
  });

  it.each([200, 400, 401, 403, 404, 409])('does not retry HTTP %s', async (status) => {
    await expect(handler({ ctx, user: { workers: { exec: async () => new Response('', { status }) } } })).resolves.toBeUndefined();
  });

  it.each([429, 500, 502, 503])('retries HTTP %s', async (status) => {
    await expect(handler({ ctx, user: { workers: { exec: async () => new Response('', { status }) } } })).rejects.toMatchObject({ retry: true });
  });

  it.each([{ status: 429 }, { statusCode: 429 }, { code: 429 }, { code: 'too_many_requests' }])('retries a rate-limit rejection %j', async (err) => {
    await expect(handler({ ctx, user: { workers: { exec: async () => { throw err; } } } })).rejects.toMatchObject({ retry: true });
  });

  it('retries network failure, but drops a coded permission refusal', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce({ code: 'auth_canceled' });
    await expect(handler({ ctx, user: { workers: { exec } } })).rejects.toMatchObject({ retry: true });
    await expect(handler({ ctx, user: { workers: { exec } } })).resolves.toBeUndefined();
  });
});

describe('POST /due', () => {
  it('authenticates members, delivers only due entries once, and writes no presence', async () => {
    const rt = await boot();
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const queue = `/api/ws/${wsId}/scheduled`;
    await as(alice).post(queue, { conv: general.id, text: 'due', dueAt: Date.now() - 1000 });
    const later = await as(alice).post(queue, { conv: general.id, text: 'later', dueAt: Date.now() + 60_000 });
    const before = await rt.kv.get(KEYS.activity(wsId));
    expect((await as(null).post(`/api/ws/${wsId}/due`)).status).toBe(401);
    expect((await as(carol).post(`/api/ws/${wsId}/due`)).status).toBe(403);
    const pokes = await Promise.all([as(alice).post(`/api/ws/${wsId}/due`), as(bob).post(`/api/ws/${wsId}/due`)]);
    expect(pokes.some((r) => r.ok)).toBe(true);
    expect(pokes.every((r) => r.ok || r.status === 503)).toBe(true);
    await as(bob).post(`/api/ws/${wsId}/due`);
    const messages = (await as(bob).get(`/api/ws/${wsId}/conv/${general.id}/messages`)).data.messages;
    expect(messages.filter((m) => m.text === 'due')).toHaveLength(1);
    expect(messages.some((m) => m.text === 'later')).toBe(false);
    expect(Object.keys((await rt.kv.get(KEYS.sched(wsId))).m)).toEqual([later.data.scheduled.id]);
    const after = await rt.kv.get(KEYS.activity(wsId));
    expect(after.p).toEqual(before.p);
    expect(after.ps).toEqual(before.ps);
  });

  it.each([0, 4])('keeps the wake-up retrying only while delivery has tries left (prior tries: %s)', async (tries) => {
    const rt = await boot();
    const { wsId, general } = await workspaceWith(alice);
    const e = (await as(alice).post(`/api/ws/${wsId}/scheduled`, { conv: general.id, text: 'retry me', dueAt: Date.now() - 1000 })).data.scheduled;
    const key = KEYS.sched(wsId);
    await rt.kv.update(key, { [`m.${e.id}.tries`]: tries });
    const incr = rt.kv.incr.bind(rt.kv);
    const failure = vi.spyOn(rt.kv, 'incr').mockImplementation((k, ...args) => {
      if (k === KEYS.seq(general.id)) throw new Error('store down');
      return incr(k, ...args);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const poke = () => as(alice).post(`/api/ws/${wsId}/due`);
    expect((await poke()).status).toBe(tries ? 200 : 503);
    failure.mockRestore();
    if (tries) {
      expect((await rt.kv.get(key)).m[e.id]).toBeUndefined();
    } else {
      expect((await rt.kv.get(key)).m[e.id].retryAt).toBeGreaterThan(Date.now());
      expect((await poke()).status).toBe(503);
      await rt.kv.update(key, { [`m.${e.id}.retryAt`]: Date.now() - 1 });
      expect((await poke()).status).toBe(200);
      expect((await rt.kv.get(key)).m[e.id]).toBeUndefined();
    }
  });

  it('answers 200 for an author-visible refusal and an entry moved to the future', async () => {
    const rt = await boot();
    const { wsId } = await workspaceWith(alice);
    const ch = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'temp' })).data.channel;
    const e = (await as(alice).post(`/api/ws/${wsId}/scheduled`, { conv: ch.id, text: 'refused', dueAt: Date.now() - 1000 })).data.scheduled;
    await as(alice).put(`/api/ws/${wsId}/channels/${ch.id}`, { archived: true });
    const poke = () => as(alice).post(`/api/ws/${wsId}/due`);
    expect((await poke()).status).toBe(200);
    expect((await rt.kv.get(KEYS.sched(wsId))).m[e.id].failed.code).toBe('archived');
    expect((await poke()).status).toBe(200);
    await rt.kv.update(KEYS.sched(wsId), { [`m.${e.id}`]: { ...e, dueAt: Date.now() + 60_000 } });
    expect((await poke()).status).toBe(200);
  });

  it('materialises a reminder and directly notifies its member once', async () => {
    const rt = await boot({ authToken: fakeAuthToken('app-teamchat-test') });
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const seq = (await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'remember this' })).data.message.seq;
    await as(bob).post(`/api/ws/${wsId}/pn`, {});
    const rem = await as(bob).post(`/api/ws/${wsId}/reminders`, { conv: general.id, seq, dueAt: Date.now() - 1000, note: 'follow up' });
    const poke = () => as(alice).post(`/api/ws/${wsId}/due`);
    expect((await poke()).ok).toBe(true);
    await poke();
    expect(rt.notifications.sent).toHaveLength(1);
    expect(rt.notifications.sent[0]).toMatchObject({ title: 'Reminder', text: 'follow up', to: { handle: expect.any(String) }, channel: 'chat', data: { g: expect.stringContaining(`reminder-${rem.data.reminder.id}`) } });
    expect(rt.notifications.sent[0].target).toContain(`/c/${general.id}/m/${seq}`);
    const inbox = (await rt.kv.get(KEYS.inbox(wsId, bob.uuid))).items;
    expect(inbox.filter((e) => e.rid === rem.data.reminder.id)).toHaveLength(1);
  });

  it('stores schedule metadata only for the current time and returns it for cancellation', async () => {
    const rt = await boot();
    const { wsId, general } = await workspaceWith(alice);
    const path = `/api/ws/${wsId}/scheduled`;
    const dueAt = Date.now() + 60_000;
    const e = (await as(alice).post(path, { conv: general.id, text: 'later', dueAt })).data.scheduled;
    const item = `${path}/${e.id}`;
    expect((await as(alice).put(item, { scheduleId: 'schedule-1', scheduleFor: dueAt })).ok).toBe(true);
    expect((await rt.kv.get(KEYS.sched(wsId))).m[e.id].scheduleId).toBe('schedule-1');
    const moved = await as(alice).put(item, { dueAt: dueAt + 60_000 });
    expect(moved.data.previousScheduleId).toBe('schedule-1');
    expect((await rt.kv.get(KEYS.sched(wsId))).m[e.id].scheduleId).toBeNull();
    expect((await as(alice).put(item, { scheduleId: 'stale', scheduleFor: dueAt })).status).toBe(409);
    await as(alice).put(item, { scheduleId: 'schedule-2' });
    expect((await as(alice).del(item)).data.previousScheduleId).toBe('schedule-2');
  });
});
