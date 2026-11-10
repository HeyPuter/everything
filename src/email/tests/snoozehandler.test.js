import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import source from '../src/workers/snooze-handler.js?raw';

const handler = new Function(`return (\n${source}\n)`)();
const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NAME = `${ID}--${Buffer.from('Café ☕').toString('base64url')}`;
const PATH = `/tester/.mail/snoozed/2026-10-30/${NAME}`;
const NOW = +new Date('2026-11-04T20:00:00Z');
const DESTINATION = `/tester/.mail/objects/2026-11-04/${NAME}`;
const ctx = Object.freeze({ id: ID, token: 'version-1', mailPath: '/tester/.mail' });
const event = { op: 'tick', id: 'schedule-1:1793822400000', scheduleId: 'schedule-1', scheduledFor: NOW };
let data;
let files;
let user;
const run = () => handler({ event, ctx, user });

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  data = new Map([[`snooze:${ID}`, { until: NOW - 1000, path: PATH, name: NAME, token: ctx.token,
    from: { box: 'inbox', day: '2026-10-30' }, scheduleId: 'schedule-1' }]]);
  files = new Set([PATH]);
  user = {
    kv: {
      get: vi.fn(async (key) => structuredClone(data.get(key) ?? null)),
      set: vi.fn(async (key, value) => { data.set(key, structuredClone(value)); }),
      del: vi.fn(async (key) => { data.delete(key); }),
    },
    fs: {
      mkdir: vi.fn(async () => {}),
      move: vi.fn(async (from, dir, { newName }) => {
        if (!files.delete(from)) throw { code: 'subject_does_not_exist' };
        files.add(`${dir}/${newName}`);
      }),
    },
    notifications: { notify: vi.fn(async () => 'notification-id') },
  };
});
afterEach(() => vi.restoreAllMocks());

describe('the published snooze handler', () => {
  it('moves into today, clears the record and notifies without a tab', async () => {
    await run();
    expect(files).toEqual(new Set([DESTINATION]));
    expect(data.has(`snooze:${ID}`)).toBe(false);
    expect(data.get(`woken:${ID}`)).toEqual({ at: NOW, path: DESTINATION });
    expect(user.fs.mkdir).toHaveBeenCalledWith('/tester/.mail/objects/2026-11-04', { createMissingParents: true });
    expect(user.notifications.notify).toHaveBeenCalledWith({
      title: 'Snoozed message', text: 'Café ☕', data: { id: ID },
      target: `/?message=${ID}`, channel: 'mail', group: `snooze-${ID}`,
    });
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(1);
    expect(user.fs.move).toHaveBeenCalledTimes(1);
  });

  it('two attempts can only announce the successful move', async () => {
    await Promise.all([run(), run()]);
    expect(user.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('ignores removed, changed and not-yet-due records', async () => {
    data.get(`snooze:${ID}`).until = NOW + 3600000;
    await run();
    data.get(`snooze:${ID}`).until = NOW - 1000;
    data.get(`snooze:${ID}`).token = 'version-2';
    await run();
    data.clear();
    await run();
    expect(user.fs.move).not.toHaveBeenCalled();
    expect(user.notifications.notify).not.toHaveBeenCalled();
  });

  it('does not announce a missing file without evidence of a prior wake', async () => {
    files.delete(PATH);
    files.add(DESTINATION);
    await run();
    expect(user.notifications.notify).not.toHaveBeenCalled();
    expect(data.has(`snooze:${ID}`)).toBe(true);
  });

  it('allows an existing inbox day and honors sensitive previews', async () => {
    user.fs.mkdir.mockRejectedValueOnce({ code: 'item_with_same_name_exists' });
    data.get(`snooze:${ID}`).previews = false;
    await run();
    expect(user.notifications.notify.mock.calls[0][0].sensitive).toBe(true);
  });

  it.each([
    { status: 503 }, { statusCode: 500 }, { code: 'network_error' },
    { code: 'ETIMEDOUT' }, { name: 'TypeError', message: 'fetch failed' },
  ])('retries temporary FS failures: %j', async (error) => {
    user.fs.move.mockRejectedValueOnce(error);
    await expect(run()).rejects.toMatchObject({ retry: true });
    expect(data.has(`snooze:${ID}`)).toBe(true);
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 403, code: 'forbidden' },
    { code: 'invalid_request' },
  ])('does not retry permanent refusals or quotas: %j', async (error) => {
    user.fs.move.mockRejectedValueOnce(error);
    await expect(run()).resolves.toBeUndefined();
    expect(user.notifications.notify).not.toHaveBeenCalled();
  });

  it('retries temporary KV failures', async () => {
    user.kv.get.mockRejectedValueOnce({ status: 502 });
    await expect(run()).rejects.toMatchObject({ retry: true });
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it('announces once on a later retry after a temporary notification failure', async () => {
    user.notifications.notify.mockRejectedValueOnce({ status: 503 });
    await expect(run()).rejects.toMatchObject({ retry: true });
    expect(data.has(`snooze:${ID}`)).toBe(true);
    expect(files).toEqual(new Set([DESTINATION]));
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(2);
    await expect(user.notifications.notify.mock.results[1].value).resolves.toBe('notification-id');
    expect(data.has(`snooze:${ID}`)).toBe(false);
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(2);
  });

  it('a losing concurrent move leaves a failed announcement available to retry', async () => {
    user.notifications.notify.mockRejectedValueOnce({ status: 503 });
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(data.has(`snooze:${ID}`)).toBe(true);
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(2);
    expect(data.has(`snooze:${ID}`)).toBe(false);
  });

  it('ignores a changed token after a moved-but-unannounced wake', async () => {
    user.notifications.notify.mockRejectedValueOnce({ status: 503 });
    await expect(run()).rejects.toMatchObject({ retry: true });
    data.get(`snooze:${ID}`).token = 'version-2';
    await run();
    expect(user.notifications.notify).toHaveBeenCalledTimes(1);
    expect(data.get(`snooze:${ID}`).token).toBe('version-2');
  });

  it.each(['fs.mkdir', 'fs.move', 'kv.get', 'kv.set', 'kv.del'])('retries Puter throttling from %s', async (method) => {
    const [module, name] = method.split('.');
    user[module][name].mockRejectedValueOnce({ status: 429, code: 'too_many_requests' });
    await expect(run()).rejects.toMatchObject({ retry: true });
    expect(data.has(`snooze:${ID}`)).toBe(true);
  });

  it('retries a Puter throttle code without an HTTP status', async () => {
    user.kv.get.mockRejectedValueOnce({ code: 'too_many_requests' });
    await expect(run()).rejects.toMatchObject({ retry: true });
  });

  it.each([{ status: 429 }, { statusCode: 429 }, { code: 'too_many_requests' }])(
    'clears the record without retrying a notification cap: %j', async (error) => {
      user.notifications.notify.mockRejectedValueOnce(error);
      await expect(run()).resolves.toBeUndefined();
      expect(data.has(`snooze:${ID}`)).toBe(false);
      await run();
      expect(user.notifications.notify).toHaveBeenCalledTimes(1);
    });
});
