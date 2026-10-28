import { describe, it, expect, vi } from 'vitest';
import { createMailbox, HANDLER_NAME, MAIL_SUBJECT, RECORD_VERSION } from '../src/js/mailbox.js';
import { makeKv } from './helpers/worker-harness.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A minimal, self-contained fixture handler — same instantiation shape as the
// real one (a bare async function expression, run via `new Function`), but
// simple enough to assert against: it just records that it ran, per event uid.
const TEST_HANDLER_SOURCE = `
async function testHandler({ event, ctx, user }) {
  if (event.op === 'gap') return;
  await user.kv.set('test:seen:' + event.uid, { path: event.path, ctx });
}
`;

function makeEmailList(items, { pageSize = 100 } = {}) {
  // Mimics puter.email.list: pages of `pageSize`, newest first, with an
  // opaque numeric-string cursor.
  return vi.fn(async ({ limit = pageSize, cursor } = {}) => {
    const start = cursor ? Number(cursor) : 0;
    // The caller asks for up to LIST_PAGE_LIMIT; a fixture with a smaller
    // pageSize is asking to be paged, so honour whichever is tighter.
    const end = Math.min(start + Math.min(limit, pageSize), items.length);
    const page = { items: items.slice(start, end) };
    if (end < items.length) page.cursor = String(end);
    return page;
  });
}

function makePuter(overrides = {}) {
  return {
    appID: 'app-1',
    events: {
      onPersistent: vi.fn(async () => ({ id: 'sub-1' })),
      list: vi.fn(async () => []),
      unsubscribe: vi.fn(async () => true),
      ...overrides.events,
    },
    perms: {
      request: vi.fn(async () => true),
      ...overrides.perms,
    },
    email: {
      list: vi.fn(async () => ({ items: [] })),
      ...overrides.email,
    },
  };
}

function makeMailbox({ kv = makeKv(), puter = makePuter(), user = { username: 'nariman', email: 'nariman@example.com' }, now = () => 1000 } = {}) {
  // The in-page rescan hands `user: puter` to the handler (mirroring the
  // real `user: puter` in the design's pseudocode) — wire it to the SAME kv
  // the test inspects, so the fixture handler's writes land where expected.
  puter.kv = kv;
  const mailbox = createMailbox({
    kv,
    store: {},
    user,
    getPuter: () => puter,
    blocked: () => false,
    source: TEST_HANDLER_SOURCE,
    now,
  });
  return { mailbox, kv, puter };
}

describe('RECORD_VERSION / HANDLER_NAME / MAIL_SUBJECT', () => {
  it('are stable, versioned constants', () => {
    expect(HANDLER_NAME).toBe('calendar-mail-v2');
    expect(MAIL_SUBJECT).toBe('fs:~/.mail/objects/**:add');
    expect(RECORD_VERSION).toBe(1);
  });
});

describe('mailbox: available()', () => {
  it('is false with no puter.events.onPersistent, or while blocked', () => {
    const m1 = createMailbox({ kv: makeKv(), store: {}, user: {}, getPuter: () => null, blocked: () => false });
    expect(m1.available()).toBe(false);
    const m2 = createMailbox({ kv: makeKv(), store: {}, user: {}, getPuter: () => ({ events: {}, perms: {} }), blocked: () => false });
    expect(m2.available()).toBe(false);
    const m3 = createMailbox({
      kv: makeKv(), store: {}, user: {},
      getPuter: () => ({ events: { onPersistent() {} }, perms: {} }),
      blocked: () => true,
    });
    expect(m3.available()).toBe(false);
  });

  it('is true when puter.events/perms are present and not blocked', () => {
    const { mailbox } = makeMailbox();
    expect(mailbox.available()).toBe(true);
  });
});

describe('mailbox: connect() happy path', () => {
  it('sends one batched perms request, then a queue onPersistent', async () => {
    const { mailbox, kv, puter } = makeMailbox();
    const status = await mailbox.connect();

    expect(puter.perms.request).toHaveBeenCalledTimes(1);
    expect(puter.perms.request.mock.calls[0][0]).toEqual([
      { resource: 'permission', permission: 'fs:/nariman/.mail:read', create: true },
      { resource: 'permission', permission: 'events:background' },
    ]);
    expect(puter.events.onPersistent).toHaveBeenCalledTimes(1);
    expect(puter.events.onPersistent.mock.calls[0][0]).toMatchObject({
      subject: MAIL_SUBJECT,
      queue: true,
      handlerName: HANDLER_NAME,
    });
    expect(puter.events.onPersistent.mock.calls[0][0]).not.toHaveProperty('targets');
    expect(puter.events.onPersistent.mock.calls[0][0]).not.toHaveProperty('delivery');
    expect(status.mode).toBe('background');
    expect(status.state).toBe('ok');
    expect(status.subId).toBe('sub-1');
    const cfg = kv.map.get('cal:mail:cfg');
    expect(cfg).toMatchObject({ mode: 'background', subId: 'sub-1', handlerName: HANDLER_NAME, subject: MAIL_SUBJECT });
  });

  it('adopts an existing, non-suspended subscription instead of creating a second', async () => {
    const puter = makePuter({
      events: {
        list: vi.fn(async () => [
          { id: 'existing-sub', subject: MAIL_SUBJECT, handlerName: HANDLER_NAME, suspendedAt: null },
        ]),
      },
    });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
    expect(status.subId).toBe('existing-sub');
  });
});

describe('mailbox: connect() error mapping', () => {
  it('unavailable() when puter.events is missing entirely', async () => {
    const mailbox = createMailbox({ kv: makeKv(), store: {}, user: {}, getPuter: () => null, blocked: () => false, source: TEST_HANDLER_SOURCE });
    const status = await mailbox.connect();
    expect(status.state).toBe('unavailable');
  });

  it('events_disabled -> mode off, with a clear message', async () => {
    const err = Object.assign(new Error('no'), { code: 'events_disabled' });
    const puter = makePuter({ perms: { request: vi.fn(async () => { throw err; }) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('off');
    expect(status.lastError).toMatch(/Not available/i);
  });

  it('events_durable_requires_account -> mode off, with a clear message', async () => {
    const err = Object.assign(new Error('no'), { code: 'events_durable_requires_account' });
    const puter = makePuter({ perms: { request: vi.fn(async () => { throw err; }) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('off');
    expect(status.lastError).toMatch(/full Puter account/i);
  });

  it('no app identity -> foreground mode, without subscribing', async () => {
    const puter = makePuter();
    delete puter.appID;
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('foreground');
    expect(status.state).toBe('foreground');
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
  });

  // puter.perms.request RESOLVES falsy on denial — it does not throw. Modelling
  // denial as a rejection left the real path untested.
  it('refusing mailbox access stops with an explanation, and subscribes to nothing', async () => {
    const puter = makePuter({ perms: { request: vi.fn(async () => [false, false]) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('off');
    expect(status.state).toBe('off');
    expect(status.lastError).toMatch(/needs access to your Puter mailbox/i);
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
  });

  it('mailbox granted but background refused -> foreground mode, no subscription', async () => {
    const puter = makePuter({ perms: { request: vi.fn(async () => [true, false]) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('foreground');
    expect(status.state).toBe('foreground');
    expect(puter.events.onPersistent).not.toHaveBeenCalled();
  });

  it('events_background_consent_required from onPersistent -> foreground mode', async () => {
    const err = Object.assign(new Error('no'), { code: 'events_background_consent_required' });
    const puter = makePuter({ events: { onPersistent: vi.fn(async () => { throw err; }) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('foreground');
  });

  it('subject_does_not_exist -> re-requests fs:.mail:read with create:true, retries once', async () => {
    const err = Object.assign(new Error('no'), { code: 'subject_does_not_exist' });
    let first = true;
    const onPersistent = vi.fn(async () => {
      if (first) {
        first = false;
        throw err;
      }
      return { id: 'sub-retry' };
    });
    const puter = makePuter({ events: { onPersistent } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(puter.perms.request).toHaveBeenCalledTimes(2);
    expect(status.mode).toBe('background');
    expect(status.subId).toBe('sub-retry');
  });

  it('events_handler_not_found -> mode off, "not deployed" message', async () => {
    const err = Object.assign(new Error('no'), { code: 'events_handler_not_found' });
    const puter = makePuter({ events: { onPersistent: vi.fn(async () => { throw err; }) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('off');
    expect(status.lastError).toMatch(/not deployed/i);
  });

  it('events_subscription_limit -> a transient message, mode off (retry-able)', async () => {
    const err = Object.assign(new Error('no'), { code: 'events_subscription_limit' });
    const puter = makePuter({ events: { onPersistent: vi.fn(async () => { throw err; }) } });
    const { mailbox } = makeMailbox({ puter });
    const status = await mailbox.connect();
    expect(status.mode).toBe('off');
    expect(status.lastError).toBeTruthy();
  });
});

describe('mailbox: suspension and reconnect', () => {
  it('start() surfaces a suspended subscription, and reconnect() re-subscribes', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:cfg', {
      v: 1, mode: 'background', subId: 'sub-1', handlerName: HANDLER_NAME, subject: MAIL_SUBJECT, watermark: '',
    });
    const puter = makePuter({
      events: {
        list: vi.fn(async () => [
          { id: 'sub-1', subject: MAIL_SUBJECT, handlerName: HANDLER_NAME, suspendedAt: 123, suspendedReason: 'permission_revoked' },
        ]),
        onPersistent: vi.fn(async () => ({ id: 'sub-new' })),
      },
    });
    const { mailbox } = makeMailbox({ kv, puter });
    const status = await mailbox.start();
    expect(status.state).toBe('suspended');
    expect(status.suspendedReason).toBeTruthy();

    const status2 = await mailbox.reconnect();
    expect(status2.state).toBe('ok');
    expect(status2.subId).toBe('sub-new');
  });
});

describe('mailbox: disconnect()', () => {
  it('unsubscribes and sets mode off, keeping the cfg key', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:cfg', {
      v: 1, mode: 'background', subId: 'sub-1', handlerName: HANDLER_NAME, subject: MAIL_SUBJECT, watermark: '',
    });
    const puter = makePuter();
    const { mailbox } = makeMailbox({ kv, puter });
    await mailbox.start();
    await mailbox.disconnect();
    expect(puter.events.unsubscribe).toHaveBeenCalledWith('sub-1');
    expect(mailbox.status().mode).toBe('off');
  });
});

describe('mailbox: rescan / watermark (puter.email.list)', () => {
  function items(ids) {
    // Newest first, as email.list returns them; id order is the sort key.
    return ids.map((id) => ({ id, subject: 's', date: '2026-01-01T00:00:00.000Z', size: 100, folder: 'inbox', path: `/nariman/.mail/objects/2026-01-01/${id}--c3ViamVjdA`, uid: 'uid-' + id }));
  }

  it('processes items newest-first and advances the watermark to the greatest id', async () => {
    const list = makeEmailList(items(['0003', '0002', '0001']));
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter });

    await mailbox.rescan({ force: true });

    expect(kv.map.get('test:seen:uid-0003')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0002')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0001')).toBeTruthy();
    const cfg = kv.map.get('cal:mail:cfg');
    expect(cfg.watermark).toBe('0003');
  });

  it('stops at the horizon: a first sweep never reaches messages older than 14 days', async () => {
    const NOW = Date.parse('2026-09-18T12:00:00.000Z');
    const dated = (id, iso) => ({
      id,
      subject: 's',
      date: iso,
      size: 100,
      folder: 'inbox',
      path: `/nariman/.mail/objects/2026-09-18/${id}--c3ViamVjdA`,
      uid: 'uid-' + id,
    });
    // One page whose tail predates the horizon. Newest first, as list returns.
    const list = makeEmailList([
      dated('0004', '2026-09-18T09:00:00.000Z'), // today
      dated('0003', '2026-09-10T09:00:00.000Z'), // 8 days — inside
      dated('0002', '2026-08-20T09:00:00.000Z'), // 29 days — past the horizon
      dated('0001', '2026-08-01T09:00:00.000Z'), // older still
    ]);
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter, now: () => NOW });

    await mailbox.rescan({ force: true });

    expect(kv.map.get('test:seen:uid-0004')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0003')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0002')).toBeUndefined();
    expect(kv.map.get('test:seen:uid-0001')).toBeUndefined();
    // The watermark covers only what was actually swept.
    expect(kv.map.get('cal:mail:cfg').watermark).toBe('0004');
  });

  it('stops paging at the horizon rather than fetching the rest of the mailbox', async () => {
    const NOW = Date.parse('2026-09-18T12:00:00.000Z');
    const dated = (id, iso) => ({
      id, subject: 's', date: iso, size: 100, folder: 'inbox',
      path: `/nariman/.mail/objects/2026-09-18/${id}--x`, uid: 'uid-' + id,
    });
    const list = makeEmailList(
      [dated('0004', '2026-09-17T09:00:00.000Z'), dated('0003', '2026-01-01T09:00:00.000Z'),
       dated('0002', '2025-12-01T09:00:00.000Z'), dated('0001', '2025-11-01T09:00:00.000Z')],
      { pageSize: 2 },
    );
    const puter = makePuter({ email: { list } });
    const { mailbox } = makeMailbox({ puter, now: () => NOW });
    await mailbox.rescan({ force: true });
    // The horizon is hit inside the first page, so the second is never asked for.
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('an unparseable date is swept rather than silently dropped', async () => {
    const NOW = Date.parse('2026-09-18T12:00:00.000Z');
    const list = makeEmailList([
      { id: '0001', subject: 's', date: 'not a date', size: 100, folder: 'inbox', path: '/nariman/.mail/objects/2026-09-18/0001--x', uid: 'uid-0001' },
    ]);
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter, now: () => NOW });
    await mailbox.rescan({ force: true });
    expect(kv.map.get('test:seen:uid-0001')).toBeTruthy();
  });

  it('passes item.path/item.uid straight through to the in-page handler', async () => {
    const list = makeEmailList(items(['0001']));
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter });
    await mailbox.rescan({ force: true });
    expect(kv.map.get('test:seen:uid-0001').path).toBe('/nariman/.mail/objects/2026-01-01/0001--c3ViamVjdA');
  });

  it('stops at the first item at or before the watermark, leaving older ones untouched', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:cfg', {
      v: 1, mode: 'foreground', subId: '', handlerName: HANDLER_NAME, subject: MAIL_SUBJECT, watermark: '0002',
    });
    const list = makeEmailList(items(['0004', '0003', '0002', '0001']));
    const puter = makePuter({ email: { list } });
    const { mailbox } = makeMailbox({ kv, puter });
    await mailbox.start();
    await mailbox.rescan({ force: true });
    expect(kv.map.get('test:seen:uid-0004')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0003')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0002')).toBeUndefined();
    expect(kv.map.get('test:seen:uid-0001')).toBeUndefined();
    expect(kv.map.get('cal:mail:cfg').watermark).toBe('0004');
  });

  it('skips an item over 3 MiB without invoking the handler, but still advances past it', async () => {
    const list = makeEmailList([
      { id: '0002', subject: 's', date: 'd', size: (3 << 20) + 1, folder: 'inbox', path: '/nariman/.mail/objects/2026-01-01/0002--x', uid: 'uid-big' },
      { id: '0001', subject: 's', date: 'd', size: 100, folder: 'inbox', path: '/nariman/.mail/objects/2026-01-01/0001--x', uid: 'uid-small' },
    ]);
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter });
    await mailbox.rescan({ force: true });
    expect(kv.map.get('test:seen:uid-big')).toBeUndefined();
    expect(kv.map.get('test:seen:uid-small')).toBeTruthy();
    expect(kv.map.get('cal:mail:cfg').watermark).toBe('0002');
  });

  it('a gap ignores the stored watermark for one pass, then clears the gap key', async () => {
    const kv = makeKv();
    kv.map.set('cal:mail:cfg', {
      v: 1, mode: 'foreground', subId: '', handlerName: HANDLER_NAME, subject: MAIL_SUBJECT, watermark: '0002',
    });
    kv.map.set('cal:mail:gap', { at: 1, reason: 'missed delivery' });
    const list = makeEmailList(items(['0003', '0002', '0001']));
    const puter = makePuter({ email: { list } });
    const { mailbox } = makeMailbox({ kv, puter });
    await mailbox.start(); // loads cfg.watermark from kv, same as real startup
    await mailbox.rescan({ force: true });
    // 0002 and 0001 are <= the stored watermark but the gap forces a full pass.
    expect(kv.map.get('test:seen:uid-0002')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0001')).toBeTruthy();
    expect(kv.map.get('cal:mail:gap')).toBeUndefined();
  });

  it('caps a pass at 200 messages, across multiple pages', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(250 - i).padStart(4, '0')); // newest (0250) first
    const list = makeEmailList(items(ids), { pageSize: 100 });
    const puter = makePuter({ email: { list } });
    const { mailbox, kv } = makeMailbox({ puter });
    await mailbox.rescan({ force: true });
    const seenCount = [...kv.map.keys()].filter((k) => k.startsWith('test:seen:')).length;
    expect(seenCount).toBe(200);
    // The 200th newest id is 0051 (0250 down to 0051 inclusive = 200 items).
    expect(kv.map.get('cal:mail:cfg').watermark).toBe('0250');
    expect(kv.map.get('test:seen:uid-0051')).toBeTruthy();
    expect(kv.map.get('test:seen:uid-0050')).toBeUndefined();
    // Only 2 pages of 100 were needed to reach the 200 cap — the 3rd was never fetched.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('respects the 5-minute throttle unless forced', async () => {
    const list = makeEmailList([]);
    const puter = makePuter({ email: { list } });
    let t = 0;
    const { mailbox } = makeMailbox({ puter, now: () => t });
    await mailbox.rescan({ force: true });
    expect(list).toHaveBeenCalledTimes(1);
    t += 1000;
    await mailbox.rescan();
    expect(list).toHaveBeenCalledTimes(1);
    t += 6 * 60_000;
    await mailbox.rescan();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a broken `new Function` (future CSP) disables local scanning without throwing', async () => {
    const kv = makeKv();
    const puter = makePuter();
    const mailbox = createMailbox({
      kv, store: {}, user: { username: 'n' }, getPuter: () => puter, blocked: () => false,
      source: 'not even valid js (((',
    });
    await expect(mailbox.rescan({ force: true })).resolves.not.toThrow();
    expect(mailbox.status().lastError).toBeTruthy();
  });
});

describe('the publish script and the client agree on the handler name', () => {
  it("scripts/publish-mail-handler.mjs's literal matches HANDLER_NAME", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '../scripts/publish-mail-handler.mjs'), 'utf8');
    // The script is plain Node and cannot import mailbox.js (it uses Vite's
    // `?raw`), so the name is duplicated there on purpose — and this is what
    // keeps the duplicate honest.
    const m = /HANDLER_NAME\s*=\s*['"]([^'"]+)['"]/.exec(src);
    expect(m, 'no HANDLER_NAME literal found in the publish script').toBeTruthy();
    expect(m[1]).toBe(HANDLER_NAME);
  });
});
