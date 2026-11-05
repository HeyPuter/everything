import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { instantiateWorker, makeKv, sha256Hex } from './helpers/worker-harness.js';

const RAW = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/workers/rsvp-worker.js'),
  'utf8',
);

const SECRET = 'test-admin-secret';
const AUTH = { authorization: `Bearer ${SECRET}` };
const HOUR = 3_600_000;
const PAGE = 'https://app.test/rsvp.html';
const WORKER_ORIGIN = 'https://test-worker.puter.work';

async function loadWorker(kv = makeKv()) {
  const source = RAW.replace('__RSVP_ADMIN_SECRET_HASH__', await sha256Hex(SECRET))
    .replace('__RSVP_WORKER_VERSION__', 'test')
    .replace('__RSVP_PAGE_URL__', PAGE);
  return instantiateWorker(source, { kv });
}

/** Parse a redirect Location into { page, w, t, s }. */
function parseRedirect(res) {
  const loc = res.headers.get('location') || '';
  const [page, fragment] = loc.split('#');
  const params = new URLSearchParams(fragment || '');
  return { page, w: params.get('w'), t: params.get('t'), s: params.get('s') };
}

function eventPayload(overrides = {}) {
  const start = Date.now() + 24 * HOUR;
  return {
    id: 'evt-1',
    title: 'Team offsite',
    start,
    end: start + 2 * HOUR,
    allDay: false,
    location: 'Pier 39',
    description: 'Bring sunscreen',
    organizerName: 'Nariman',
    organizerEmail: 'host@example.com',
    recurLabel: '',
    expiresAt: start + 2 * HOUR,
    tz: 'America/Los_Angeles',
    hour12: true,
    ...overrides,
  };
}

async function sync(worker, { event = eventPayload(), guests, reissue = [] } = {}) {
  const res = await worker.call('POST', '/admin/sync', {
    headers: AUTH,
    json: { event, guests, reissue },
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('rsvp worker: admin auth', () => {
  let worker;
  beforeEach(async () => {
    worker = await loadWorker();
  });

  it('rejects admin routes without a bearer token', async () => {
    for (const [method, route] of [
      ['GET', '/admin/ping'],
      ['GET', '/admin/responses'],
      ['POST', '/admin/sync'],
      ['POST', '/admin/revoke'],
    ]) {
      const res = await worker.call(method, route, { json: method === 'POST' ? {} : undefined });
      expect(res.status, route).toBe(401);
    }
  });

  it('rejects a wrong secret and accepts the right one', async () => {
    const bad = await worker.call('GET', '/admin/ping', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.status).toBe(401);
    const good = await worker.call('GET', '/admin/ping', { headers: AUTH });
    expect(good.status).toBe(200);
    expect((await good.json()).version).toBe('test');
  });

  it('reports the baked-in runtime, null under the harness', async () => {
    const res = await worker.call('GET', '/admin/ping', { headers: AUTH });
    expect((await res.json()).runtime).toBeNull();

    // Read per request: the same worker reports a preamble that arrives later.
    globalThis.__PUTER_PREAMBLE_VERSION__ = '2.6.2+63f857ce3';
    try {
      const res2 = await worker.call('GET', '/admin/ping', { headers: AUTH });
      expect((await res2.json()).runtime).toBe('2.6.2+63f857ce3');
    } finally {
      delete globalThis.__PUTER_PREAMBLE_VERSION__;
    }
  });
});

describe('rsvp worker: sync + tokens', () => {
  let worker;
  beforeEach(async () => {
    worker = await loadWorker();
  });

  it('rejects event ids outside the app id alphabet and caps the guest list', async () => {
    for (const id of ['evt*glob', 'a:b', 'evt 1', 'x'.repeat(201), '']) {
      const res = await worker.call('POST', '/admin/sync', {
        headers: AUTH,
        json: { event: { ...eventPayload(), id }, guests: [] },
      });
      expect(res.status, JSON.stringify(id)).toBe(400);
    }
    const many = Array.from({ length: 205 }, (_, i) => ({ email: `g${i}@example.com` }));
    const data = await sync(worker, { guests: many });
    expect(Object.keys(data.links).length).toBe(200);
  });

  it('issues one link per guest and stores only token hashes', async () => {
    const data = await sync(worker, {
      guests: [
        { email: 'a@example.com', name: 'Ada' },
        { email: 'b@example.com' },
      ],
    });
    expect(Object.keys(data.links).sort()).toEqual(['a@example.com', 'b@example.com']);
    for (const token of Object.values(data.links)) {
      expect(token).toMatch(/^[0-9a-f]{40}$/);
      // The raw token must appear NOWHERE in storage — only its hash does.
      const dump = JSON.stringify([...worker.kv.map.entries()]);
      expect(dump).not.toContain(token);
      expect(dump).toContain(await sha256Hex(token));
    }
  });

  it('keeps existing tokens on a plain re-sync (idempotent)', async () => {
    const first = await sync(worker, { guests: [{ email: 'a@example.com' }] });
    const second = await sync(worker, { guests: [{ email: 'a@example.com' }] });
    expect(second.links).toEqual({}); // nothing new issued
    const api = await worker.call('GET', `/api/rsvp/${first.links['a@example.com']}`);
    expect(api.status).toBe(200); // old link still live
  });

  it('revokes the token of a removed guest but keeps the others', async () => {
    const { links } = await sync(worker, {
      guests: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    });
    await sync(worker, { guests: [{ email: 'a@example.com' }] });
    expect((await worker.call('GET', `/api/rsvp/${links['b@example.com']}`)).status).toBe(404);
    expect((await worker.call('GET', `/api/rsvp/${links['a@example.com']}`)).status).toBe(200);
  });

  it('reissue mints a fresh link and kills the old one', async () => {
    const first = await sync(worker, { guests: [{ email: 'a@example.com' }] });
    const second = await sync(worker, {
      guests: [{ email: 'a@example.com' }],
      reissue: ['a@example.com'],
    });
    const fresh = second.links['a@example.com'];
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(first.links['a@example.com']);
    expect(
      (await worker.call('GET', `/api/rsvp/${first.links['a@example.com']}`)).status,
    ).toBe(404);
    expect((await worker.call('GET', `/api/rsvp/${fresh}`)).status).toBe(200);
  });

  it('revoke kills the event, every guest link, and every stored answer', async () => {
    const { links } = await sync(worker, { guests: [{ email: 'a@example.com' }] });
    await worker.call('POST', `/api/rsvp/${links['a@example.com']}`, {
      json: { status: 'accepted' },
    });
    const res = await worker.call('POST', '/admin/revoke', {
      headers: AUTH,
      json: { eventId: 'evt-1' },
    });
    expect(res.status).toBe(200);
    expect((await worker.call('GET', `/api/rsvp/${links['a@example.com']}`)).status).toBe(404);
    expect(worker.kv.map.has('rsvpw:evt:evt-1')).toBe(false);
    expect(worker.kv.map.has('rsvpw:resp:evt-1:a@example.com')).toBe(false);
  });

  it('revoke refuses an id outside the sync alphabet, so a glob can never sweep other events', async () => {
    // Two independent events, each with a stored answer.
    const a = await sync(worker, { event: eventPayload({ id: 'evt-1' }), guests: [{ email: 'a@example.com' }] });
    const b = await sync(worker, { event: eventPayload({ id: 'evt-2' }), guests: [{ email: 'b@example.com' }] });
    await worker.call('POST', `/api/rsvp/${a.links['a@example.com']}`, { json: { status: 'accepted' } });
    await worker.call('POST', `/api/rsvp/${b.links['b@example.com']}`, { json: { status: 'declined' } });

    for (const eventId of ['*', 'evt-1*', '*:*', 'evt 1', 'evt:1']) {
      const res = await worker.call('POST', '/admin/revoke', { headers: AUTH, json: { eventId } });
      expect(res.status, eventId).toBe(400);
    }

    // Every answer is still standing.
    expect(worker.kv.map.has('rsvpw:resp:evt-1:a@example.com')).toBe(true);
    expect(worker.kv.map.has('rsvpw:resp:evt-2:b@example.com')).toBe(true);
  });
});

describe('rsvp worker: no HTML — human links redirect to the app page', () => {
  let worker;
  let token;
  beforeEach(async () => {
    worker = await loadWorker();
    const { links } = await sync(worker, { guests: [{ email: 'a@example.com', name: 'Ada' }] });
    token = links['a@example.com'];
  });

  it('GET /rsvp/<token> 303s to the app page with worker + token in the fragment', async () => {
    const res = await worker.call('GET', `/rsvp/${token}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const redirect = parseRedirect(res);
    expect(redirect.page).toBe(PAGE);
    expect(redirect.w).toBe(WORKER_ORIGIN);
    expect(redirect.t).toBe(token);
    expect(redirect.s).toBeNull(); // nothing was recorded
  });

  it('unknown tokens also just redirect — the page resolves validity via the API', async () => {
    const res = await worker.call('GET', '/rsvp/' + 'f'.repeat(40));
    expect(res.status).toBe(303);
    expect(parseRedirect(res).page).toBe(PAGE);
  });

  it('a botched PAGE_URL substitution still redirects absolutely (regression: redirect loop)', async () => {
    // Deploy with the placeholder left in — a RELATIVE Location would resolve
    // back onto the worker's own route and loop forever ("too many redirects").
    const source = RAW.replace('__RSVP_ADMIN_SECRET_HASH__', await sha256Hex(SECRET)).replace(
      '__RSVP_WORKER_VERSION__',
      'test',
    );
    const broken = instantiateWorker(source, { kv: makeKv() });
    const { links } = await sync(broken, { guests: [{ email: 'a@example.com' }] });
    const res = await broken.call('GET', `/rsvp/${links['a@example.com']}`);
    expect(res.status).toBe(303);
    const loc = res.headers.get('location') || '';
    expect(loc.startsWith('https://calendar.puter.com/rsvp.html#')).toBe(true);
  });

  it('an admin sync never clobbers a guest answer (per-guest response keys)', async () => {
    // Guest answers…
    await worker.call('POST', `/api/rsvp/${token}`, {
      json: { status: 'declined', comment: 'away' },
    });
    // …then the host edits the event, triggering a re-sync of the membership.
    const data = await sync(worker, {
      event: eventPayload({ title: 'Team offsite (moved)' }),
      guests: [{ email: 'a@example.com', name: 'Ada' }],
    });
    expect(data.guests['a@example.com'].status).toBe('declined');
    expect(data.guests['a@example.com'].comment).toBe('away');
    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].guests['a@example.com'].status).toBe('declined');
  });

  it('removing a guest also deletes their stored answer', async () => {
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    await sync(worker, { guests: [] });
    expect(worker.kv.map.has('rsvpw:resp:evt-1:a@example.com')).toBe(false);
  });

  it('reports responses back to the admin API', async () => {
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'declined' } });
    const data = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    const guest = data.events['evt-1'].guests['a@example.com'];
    expect(guest.status).toBe('declined');
    expect(guest.respondedAt).toBeGreaterThan(0);
    // Token hashes never leave the worker.
    expect(JSON.stringify(data)).not.toContain('tokenHash');
  });

  it('pulls every event\'s responses in a fixed number of reads, however many are synced', async () => {
    // This route is polled every minute for as long as the calendar is open,
    // and a host's synced events only ever accumulate — so it must not cost a
    // read (or a list) per event.
    for (let i = 2; i <= 6; i++) {
      await sync(worker, {
        event: eventPayload({ id: `evt-${i}` }),
        guests: [{ email: `g${i}@example.com` }, { email: `h${i}@example.com` }],
      });
    }
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    worker.kv.get.mockClear();
    worker.kv.list.mockClear();
    const data = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(Object.keys(data.events)).toHaveLength(6);
    expect(data.events['evt-1'].guests['a@example.com'].status).toBe('accepted');
    expect(data.events['evt-4'].guests['g4@example.com'].status).toBe('needs-action');
    expect(data.events['evt-4'].guests['h4@example.com'].name).toBe('');
    expect(worker.kv.get).not.toHaveBeenCalled();
    expect(worker.kv.list.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('rsvp worker: one-click links (/rsvp/<token>/<action>)', () => {
  const BROWSER = {
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  };
  let worker;
  let token;
  beforeEach(async () => {
    worker = await loadWorker();
    const { links } = await sync(worker, { guests: [{ email: 'a@example.com' }] });
    token = links['a@example.com'];
  });

  const answer = () => worker.kv.map.get('rsvpw:resp:evt-1:a@example.com');

  it('an action named after an Object.prototype key records nothing and does not claim to', async () => {
    const res = await worker.call('GET', `/rsvp/${token}/constructor`, {
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    expect(res.status).toBe(303);
    expect(parseRedirect(res).s).toBeNull();
    expect(worker.kv.map.has('rsvpw:resp:evt-1:a@example.com')).toBe(false);
  });

  it('a browser click records the answer, then redirects with the saved flag', async () => {
    const res = await worker.call('GET', `/rsvp/${token}/accept`, { headers: BROWSER });
    expect(res.status).toBe(303);
    const redirect = parseRedirect(res);
    expect(redirect.page).toBe(PAGE);
    expect(redirect.t).toBe(token);
    expect(redirect.s).toBe('1');
    expect(answer().status).toBe('accepted');
  });

  it('supports all action words and canonical aliases', async () => {
    for (const [action, status] of [
      ['decline', 'declined'],
      ['maybe', 'tentative'],
      ['yes', 'accepted'],
      ['no', 'declined'],
      ['tentative', 'tentative'],
    ]) {
      await worker.call('GET', `/rsvp/${token}/${action}`, { headers: BROWSER });
      expect(answer().status, action).toBe(status);
    }
  });

  it('unknown actions and unknown tokens redirect without recording', async () => {
    for (const path of [`/rsvp/${token}/party`, `/rsvp/${'f'.repeat(40)}/accept`]) {
      const res = await worker.call('GET', path, { headers: BROWSER });
      expect(res.status, path).toBe(303);
      expect(parseRedirect(res).s, path).toBeNull();
    }
    expect(answer()).toBeUndefined();
  });

  it('preserves a note the guest left earlier', async () => {
    await worker.call('POST', `/api/rsvp/${token}`, {
      json: { status: 'tentative', comment: 'flight pending' },
    });
    await worker.call('GET', `/rsvp/${token}/accept`, { headers: BROWSER });
    expect(answer()).toMatchObject({ status: 'accepted', comment: 'flight pending' });
  });

  it('scanners and unfurlers are redirected but never record', async () => {
    for (const ua of [
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'WhatsApp/2.23.20 A',
      'curl/8.4.0',
      undefined, // no user-agent at all
    ]) {
      const res = await worker.call('GET', `/rsvp/${token}/accept`, {
        headers: ua ? { 'user-agent': ua } : {},
      });
      expect(res.status, String(ua)).toBe(303);
      expect(parseRedirect(res).s, String(ua)).toBeNull(); // no saved flag
      expect(answer(), String(ua)).toBeUndefined(); // nothing recorded
    }
  });

  it('a browser prefetch (Sec-Purpose) never records either', async () => {
    const res = await worker.call('GET', `/rsvp/${token}/accept`, {
      headers: { ...BROWSER, 'sec-purpose': 'prefetch;prerender' },
    });
    expect(res.status).toBe(303);
    expect(answer()).toBeUndefined();
  });

  it('after the event ends, one-click links redirect without recording', async () => {
    const start = Date.now() - 3 * HOUR;
    await sync(worker, {
      event: eventPayload({ start, end: start + HOUR, expiresAt: start + HOUR }),
      guests: [{ email: 'a@example.com' }],
    });
    const res = await worker.call('GET', `/rsvp/${token}/accept`, { headers: BROWSER });
    expect(res.status).toBe(303);
    expect(parseRedirect(res).s).toBeNull();
    expect(answer()).toBeUndefined();
  });
});

describe('rsvp worker: JSON API (/api/rsvp)', () => {
  let worker;
  let token;
  beforeEach(async () => {
    worker = await loadWorker();
    const { links } = await sync(worker, { guests: [{ email: 'a@example.com', name: 'Ada' }] });
    token = links['a@example.com'];
  });

  it('GET returns the invitation as machine-readable JSON', async () => {
    const res = await worker.call('GET', `/api/rsvp/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    // Personal data behind capability URLs must never be cached.
    expect(res.headers.get('cache-control')).toBe('no-store');
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.event.title).toBe('Team offsite');
    expect(data.event.location).toBe('Pier 39');
    expect(data.event.ended).toBe(false);
    expect(typeof data.event.when).toBe('string');
    expect(data.guest).toEqual({ email: 'a@example.com', name: 'Ada' });
    expect(data.response).toEqual({ status: 'needs-action', respondedAt: 0, comment: '' });
    expect(data.allowedStatuses).toEqual(['accepted', 'declined', 'tentative']);
  });

  it('serves the synced meeting link — held to the exact Puter Meetings shape', async () => {
    const join = 'https://meetings.puter.com/#/m/abcd-efgh-ijkl';
    await sync(worker, {
      event: eventPayload({ meetingUrl: join }),
      guests: [{ email: 'a@example.com', name: 'Ada' }],
    });
    const data = await (await worker.call('GET', `/api/rsvp/${token}`)).json();
    expect(data.event.meetingUrl).toBe(join);
  });

  it('drops a meeting link that is not a Puter Meetings room URL (imported foreign links stay off the page)', async () => {
    for (const bad of [
      'https://evil.example/#/m/abcd-efgh-ijkl',
      'https://meetings.puter.com.evil.example/#/m/abcd-efgh-ijkl',
      'https://meetings.puter.com/#/m/ABCD-EFGH-IJKL',
      'javascript:alert(1)',
    ]) {
      await sync(worker, {
        event: eventPayload({ meetingUrl: bad }),
        guests: [{ email: 'a@example.com', name: 'Ada' }],
      });
      const data = await (await worker.call('GET', `/api/rsvp/${token}`)).json();
      expect(data.event.meetingUrl, bad).toBe('');
    }
  });

  it('POST records an answer and GET reflects it', async () => {
    const post = await worker.call('POST', `/api/rsvp/${token}`, {
      json: { status: 'accepted', comment: 'see you there' },
    });
    expect(post.status).toBe(200);
    const posted = await post.json();
    expect(posted.ok).toBe(true);
    expect(posted.response.status).toBe('accepted');
    expect(posted.response.respondedAt).toBeGreaterThan(0);

    const data = await (await worker.call('GET', `/api/rsvp/${token}`)).json();
    expect(data.response.status).toBe('accepted');
    expect(data.response.comment).toBe('see you there');
  });

  it('PUT is equivalent to POST (sets the current answer)', async () => {
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    const put = await worker.call('PUT', `/api/rsvp/${token}`, { json: { status: 'declined' } });
    expect(put.status).toBe(200);
    expect(worker.kv.map.get('rsvpw:resp:evt-1:a@example.com').status).toBe('declined');
  });

  it('errors are JSON with machine-readable codes', async () => {
    const missing = await worker.call('GET', '/api/rsvp/' + 'f'.repeat(40));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('not_found');

    const bad = await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'partying' } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_status');
  });

  it('410 event_ended after the event is over (GET still readable)', async () => {
    const start = Date.now() - 3 * HOUR;
    await sync(worker, {
      event: eventPayload({ start, end: start + HOUR, expiresAt: start + HOUR }),
      guests: [{ email: 'a@example.com' }],
    });
    const post = await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    expect(post.status).toBe(410);
    expect((await post.json()).error).toBe('event_ended');
    const get = await worker.call('GET', `/api/rsvp/${token}`);
    expect(get.status).toBe(200);
    expect((await get.json()).event.ended).toBe(true);
  });

  it('a revoked guest gets not_found on the API too', async () => {
    await sync(worker, { guests: [] });
    expect((await worker.call('GET', `/api/rsvp/${token}`)).status).toBe(404);
    expect(
      (await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } })).status,
    ).toBe(404);
  });
});

describe('rsvp worker: expiry', () => {
  it('shows an ended event read-only and refuses new responses', async () => {
    const worker = await loadWorker();
    const start = Date.now() - 3 * HOUR;
    const { links } = await sync(worker, {
      event: eventPayload({ start, end: start + HOUR, expiresAt: start + HOUR }),
      guests: [{ email: 'a@example.com' }],
    });
    const token = links['a@example.com'];

    const get = await worker.call('GET', `/api/rsvp/${token}`);
    expect(get.status).toBe(200); // still readable
    expect((await get.json()).event.ended).toBe(true);

    const post = await worker.call('POST', `/api/rsvp/${token}`, {
      json: { status: 'accepted' },
    });
    expect(post.status).toBe(410);
  });

  it('never expires an endless series (expiresAt null)', async () => {
    const worker = await loadWorker();
    const start = Date.now() - 365 * 24 * HOUR;
    const { links } = await sync(worker, {
      event: eventPayload({ start, end: start + HOUR, expiresAt: null, recurLabel: 'Weekly on Monday' }),
      guests: [{ email: 'a@example.com' }],
    });
    const res = await worker.call('POST', `/api/rsvp/${links['a@example.com']}`, {
      json: { status: 'accepted' },
    });
    expect(res.status).toBe(200);
  });
});

describe('rsvp worker: notifying the host', () => {
  let kv;
  let notify;
  let worker;
  let token;
  beforeEach(async () => {
    kv = makeKv();
    notify = vi.fn(async () => 'n-1');
    const source = RAW.replace('__RSVP_ADMIN_SECRET_HASH__', await sha256Hex(SECRET))
      .replace('__RSVP_WORKER_VERSION__', 'test')
      .replace('__RSVP_PAGE_URL__', PAGE);
    worker = instantiateWorker(source, { kv, me: { puter: { kv, notifications: { notify } } } });
    const { links } = await sync(worker, { guests: [{ email: 'a@example.com', name: 'Ada' }] });
    token = links['a@example.com'];
  });

  it('tells the host who answered what, grouped per guest and event', async () => {
    const res = await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    expect(res.status).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    const [n] = notify.mock.calls[0];
    expect(n).toMatchObject({
      title: 'Ada accepted Team offsite',
      target: '/?event=evt-1',
      data: { eventId: 'evt-1' },
      channel: 'calendar',
    });
    expect(n.group).toMatch(/^rsvp:[0-9a-f]{64}$/);
    expect(n.group.length).toBeLessThanOrEqual(128);
  });

  it('a comment becomes the text; the same answer again stays quiet', async () => {
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'tentative', comment: 'Might be late' } });
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Ada said maybe to Team offsite', text: '“Might be late”' });
    await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'tentative', comment: 'Might be late' } });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a one-click answer notifies too', async () => {
    const res = await worker.call('GET', `/rsvp/${token}/decline`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    expect(res.status).toBe(303);
    expect(notify.mock.calls[0][0].title).toBe('Ada declined Team offsite');
  });

  it('a failing notify never fails the answer', async () => {
    notify.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 'forbidden' }));
    const res = await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' } });
    expect(res.status).toBe(200);
    expect((await res.json()).response.status).toBe('accepted');
  });

  it('hands the send to waitUntil instead of holding the response for it', async () => {
    let release;
    notify.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const waitUntil = vi.fn();
    const res = await worker.call('POST', `/api/rsvp/${token}`, { json: { status: 'accepted' }, waitUntil });
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release('n-1');
    await waitUntil.mock.calls[0][0];
  });
});

describe('rsvp worker: guest suggestions', () => {
  let worker;
  let tokens;
  beforeEach(async () => {
    worker = await loadWorker();
    const { links } = await sync(worker, {
      guests: [
        { email: 'a@example.com', name: 'Ada' },
        { email: 'b@example.com', name: 'Bob' },
      ],
    });
    tokens = links;
  });

  const suggest = (token, fields) =>
    worker.call('POST', `/api/rsvp/${token}/guests`, {
      body: new URLSearchParams(fields).toString(),
    });

  it('records a suggestion (urlencoded, like the page sends) and echoes it back', async () => {
    const res = await suggest(tokens['a@example.com'], {
      email: 'Sara@Example.com',
      name: 'Sara',
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.suggestion.email).toBe('sara@example.com'); // normalized
    expect(out.suggestion.name).toBe('Sara');
    expect(typeof out.suggestion.at).toBe('number');

    // The proposer sees their own pending suggestion on GET…
    const mine = await (await worker.call('GET', `/api/rsvp/${tokens['a@example.com']}`)).json();
    expect(mine.suggestions).toEqual([
      { email: 'sara@example.com', name: 'Sara', at: out.suggestion.at },
    ]);
    // …another guest does not (whom Ada proposed is not Bob's business)…
    const theirs = await (await worker.call('GET', `/api/rsvp/${tokens['b@example.com']}`)).json();
    expect(theirs.suggestions).toEqual([]);
    // …and the admin pull carries it, with the proposer named.
    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].suggestions).toEqual([
      { email: 'sara@example.com', name: 'Sara', by: 'a@example.com', at: out.suggestion.at },
    ]);
  });

  it('the admin pull survives kv.list truncating the flat suggestion scan', async () => {
    // Live puter.kv silently truncates big flat lists; the event scan already
    // fans out per hex char, and the suggestion scan must too, or pending
    // suggestions silently vanish from the per-minute pull.
    const kv = makeKv();
    const realList = kv.list.getMockImplementation();
    kv.list.mockImplementation(async (pattern, rv) => {
      const out = await realList(pattern, rv);
      return pattern === 'rsvpw:sug:*' ? out.slice(0, 400) : out;
    });
    const big = await loadWorker(kv);
    const now = Date.now();
    for (let i = 0; i < 450; i++) {
      const id = `${(i % 16).toString(16)}-${i}`; // hex first char, like uid() ids
      kv.map.set(`rsvpw:evt:${id}`, { snapshot: {}, guests: {}, updatedAt: now });
      kv.map.set(`rsvpw:sug:${id}:s@example.com`, {
        email: 's@example.com',
        name: '',
        by: 'a@example.com',
        at: now,
      });
    }
    const pulled = await (await big.call('GET', '/admin/responses', { headers: AUTH })).json();
    const total = Object.values(pulled.events).reduce((n, e) => n + e.suggestions.length, 0);
    expect(total).toBe(450);
  });

  it('re-suggesting the same address is idempotent — one entry, original timestamp kept', async () => {
    const first = await (await suggest(tokens['a@example.com'], { email: 's@example.com' })).json();
    const again = await (
      await suggest(tokens['b@example.com'], { email: 's@example.com', name: 'Sam' })
    ).json();
    expect(again.suggestion.at).toBe(first.suggestion.at); // no re-announcement in the app
    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].suggestions.length).toBe(1);
    expect(pulled.events['evt-1'].suggestions[0].by).toBe('b@example.com'); // latest proposer
    expect(pulled.events['evt-1'].suggestions[0].name).toBe('Sam');
  });

  it('rejects garbage: bad email, existing guests, the organizer, dead tokens', async () => {
    for (const email of ['', 'not-an-email', 'a@b', ' ', 'x'.repeat(255) + '@e.com']) {
      const res = await suggest(tokens['a@example.com'], { email });
      expect(res.status, JSON.stringify(email)).toBe(400);
      expect((await res.json()).error).toBe('invalid_email');
    }
    for (const email of ['b@example.com', 'HOST@example.com']) {
      const res = await suggest(tokens['a@example.com'], { email });
      expect(res.status, email).toBe(409);
      expect((await res.json()).error).toBe('already_invited');
    }
    const dead = await suggest('f'.repeat(40), { email: 's@example.com' });
    expect(dead.status).toBe(404);
  });

  it('refuses suggestions once the event has ended', async () => {
    const start = Date.now() - 3 * HOUR;
    const { links } = await sync(worker, {
      event: eventPayload({ id: 'evt-past', start, end: start + HOUR, expiresAt: start + HOUR }),
      guests: [{ email: 'a@example.com' }],
    });
    const res = await suggest(links['a@example.com'], { email: 's@example.com' });
    expect(res.status).toBe(410);
  });

  it('caps pending suggestions per event, but never blocks updating an existing one', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await suggest(tokens['a@example.com'], { email: `s${i}@example.com` });
      expect(res.status).toBe(200);
    }
    const over = await suggest(tokens['a@example.com'], { email: 'one-more@example.com' });
    expect(over.status).toBe(429);
    expect((await over.json()).error).toBe('suggestion_limit');
    const update = await suggest(tokens['b@example.com'], { email: 's3@example.com', name: 'S3' });
    expect(update.status).toBe(200);
  });

  it('settles a suggestion the moment its address shows up on the guest list', async () => {
    await suggest(tokens['a@example.com'], { email: 'sara@example.com', name: 'Sara' });
    // The organizer approved: the app re-syncs with Sara as a member.
    const data = await sync(worker, {
      guests: [
        { email: 'a@example.com', name: 'Ada' },
        { email: 'b@example.com', name: 'Bob' },
        { email: 'sara@example.com', name: 'Sara' },
      ],
    });
    expect(data.suggestions).toEqual([]); // settled, not pending
    expect(await worker.kv.get('rsvpw:sug:evt-1:sara@example.com')).toBeNull(); // key retired
    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].suggestions).toEqual([]);
  });

  it('dismiss drops the suggestion (admin only, idempotent)', async () => {
    await suggest(tokens['a@example.com'], { email: 'sara@example.com' });
    const noAuth = await worker.call('POST', '/admin/suggestions/dismiss', {
      json: { eventId: 'evt-1', email: 'sara@example.com' },
    });
    expect(noAuth.status).toBe(401);
    const bad = await worker.call('POST', '/admin/suggestions/dismiss', {
      headers: AUTH,
      json: { eventId: 'evt-1' },
    });
    expect(bad.status).toBe(400);
    const ok = await worker.call('POST', '/admin/suggestions/dismiss', {
      headers: AUTH,
      json: { eventId: 'evt-1', email: 'Sara@Example.com' }, // normalized like the write
    });
    expect(ok.status).toBe(200);
    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].suggestions).toEqual([]);
    // Dismissing what is already gone still succeeds.
    const again = await worker.call('POST', '/admin/suggestions/dismiss', {
      headers: AUTH,
      json: { eventId: 'evt-1', email: 'sara@example.com' },
    });
    expect(again.status).toBe(200);
  });

  it('revoking an event deletes its pending suggestions with it', async () => {
    await suggest(tokens['a@example.com'], { email: 'sara@example.com' });
    await worker.call('POST', '/admin/revoke', { headers: AUTH, json: { eventId: 'evt-1' } });
    expect((await worker.kv.list('rsvpw:sug:*')).length).toBe(0);
  });

  it('reads filter settled suggestions but never delete — only /admin/sync retires keys', async () => {
    await suggest(tokens['a@example.com'], { email: 'sara@example.com' });
    // Sara reaches membership out-of-band (as a stale read would see it).
    const record = worker.kv.map.get('rsvpw:evt:evt-1');
    record.guests['sara@example.com'] = { name: 'Sara', tokenHash: 'x'.repeat(64) };
    worker.kv.map.set('rsvpw:evt:evt-1', record);

    const pulled = await (await worker.call('GET', '/admin/responses', { headers: AUTH })).json();
    expect(pulled.events['evt-1'].suggestions).toEqual([]); // filtered…
    const mine = await (await worker.call('GET', `/api/rsvp/${tokens['a@example.com']}`)).json();
    expect(mine.suggestions).toEqual([]);
    expect(worker.kv.map.has('rsvpw:sug:evt-1:sara@example.com')).toBe(true); // …not deleted

    await sync(worker, {
      guests: [
        { email: 'a@example.com', name: 'Ada' },
        { email: 'b@example.com', name: 'Bob' },
        { email: 'sara@example.com', name: 'Sara' },
      ],
    });
    expect(worker.kv.map.has('rsvpw:sug:evt-1:sara@example.com')).toBe(false);
  });
});
