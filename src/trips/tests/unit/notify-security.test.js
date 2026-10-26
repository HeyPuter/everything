// @vitest-environment node
// Security review M5: the notify email channel only mails the account's own confirmed address, email and test
// sends have hourly caps, and links point at the app origin whatever the client-set context says.
import { describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { KEYS } from '../../src/lib/notify-out/model.js';
import { APP_ORIGIN, EMAIL_PER_HOUR, TESTS_PER_HOUR, runHandler } from '../../src/lib/notify-out/handler.js';

const START = Date.UTC(2027, 4, 10, 12);
const SPACE = 'a1b2c3d4e5f6g7h8';
const WORKER = 'trips-abcdefghij';
const BOB = '0f0e0d0c-0b0a-4000-8000-000000000b0b';

function world({ email = 'alice@example.org', confirmed = true, channels = {}, secret = {} } = {}) {
  let clock = START;
  const runtime = createFakePuter({ now: () => clock, users: [{ uuid: 'alice', username: 'alice', email, email_confirmed: confirmed }, 'bob'] });
  const user = runtime.client('alice');
  const sendTransactional = vi.fn(async () => ({ messageId: 'm' }));
  user.email = { sendTransactional };
  const requests = [];
  const fetch = vi.fn(async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return new Response('ok', { status: 200 }); });
  const ctx = { v: 1, k: 'trip', u: 'alice', o: 'https://evil.example', s: SPACE, w: WORKER };
  const run = (event, context = ctx) => runHandler({ event, ctx: context, user, fetch, now: () => clock, sleep: async () => {} });
  return {
    user, requests, sendTransactional, run, ctx,
    advance: (ms) => { clock += ms; },
    async init() {
      await user.kv.set(KEYS.prefs, { on: true, channels: { webhook: { on: false }, ntfy: { on: false }, email: { on: false, every: 'hour' }, ...channels } });
      await user.kv.set(KEYS.secret, { webhookUrl: 'https://hooks.example.org/in', webhookSecret: 's'.repeat(43), ...secret }, { disableSharing: true });
      await user.kv.set(`shared:${SPACE}:e:meta:meta`, { title: 'Lisbon' });
    },
    test: (id) => user.kv.set(KEYS.sched, { v: 1, test: { id, at: clock } }),
  };
}

const sig = (rev) => ({ op: 'set', value: { rev, at: START, by: BOB, ents: [], del: [], sum: [{ t: 'res', id: `r${rev}`, op: 'put', name: 'Hotel', fields: [] }] } });

describe('notify email channel (M5)', () => {
  it('never mails an address other than the confirmed email of the account', async () => {
    const w = world({ channels: { email: { on: true, every: 'hour' } }, secret: { email: 'victim@example.org' } });
    await w.init();
    await w.test('t1');
    await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    expect(w.sendTransactional).not.toHaveBeenCalled();
    expect((await w.user.kv.get(KEYS.status)).email).toMatchObject({ ok: false, code: 'unverified' });
  });

  it('never mails an unconfirmed account address', async () => {
    const w = world({ confirmed: false, channels: { email: { on: true, every: 'hour' } }, secret: { email: 'alice@example.org' } });
    await w.init();
    await w.test('t1');
    await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    expect(w.sendTransactional).not.toHaveBeenCalled();
  });

  it('mails the account address, matched without case', async () => {
    const w = world({ channels: { email: { on: true, every: 'hour' } }, secret: { email: 'Alice@Example.org' } });
    await w.init();
    await w.test('t1');
    await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    expect(w.sendTransactional).toHaveBeenCalledTimes(1);
  });

  it('caps emails per hour, tests included', async () => {
    const w = world({ channels: { email: { on: true, every: 'hour' } }, secret: { email: 'alice@example.org' } });
    await w.init();
    for (let i = 0; i < EMAIL_PER_HOUR + 3; i++) {
      await w.test(`t${i}`);
      await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    }
    expect(w.sendTransactional.mock.calls.length).toBeLessThanOrEqual(EMAIL_PER_HOUR);
  });

  it('caps test notifications per hour on every channel', async () => {
    const w = world({ channels: { webhook: { on: true } } });
    await w.init();
    for (let i = 0; i < TESTS_PER_HOUR + 3; i++) {
      await w.test(`t${i}`);
      await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    }
    expect(w.requests).toHaveLength(TESTS_PER_HOUR);
    w.advance(3_600_000);
    await w.test('later');
    await w.run({ op: 'set' }, { ...w.ctx, k: 'sched' });
    expect(w.requests).toHaveLength(TESTS_PER_HOUR + 1);
  });

  it('links to the app origin, not the origin in the subscription context', async () => {
    const w = world({ channels: { webhook: { on: true } } });
    await w.init();
    await w.run(sig(1));
    expect(w.requests[0].body.trip.url).toBe(`${APP_ORIGIN}/#/t/${WORKER}/${SPACE}`);
    expect(JSON.stringify(w.requests)).not.toContain('evil.example');
  });
});
