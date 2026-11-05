/**
 * Twelfth review pass, client libraries. Puter is faked at
 * `puter.workers.exec`, as in tests/store.test.js and
 * tests/client-lib-pass11.test.js.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// The push plumbing (lib/pwa.js) needs a service worker registration this
// runtime has none of: what a test wants of it is stubbed here, the rest is
// the real module.
const pwa = vi.hoisted(() => ({ retire: null }));
vi.mock('../src/lib/pwa.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    retireLegacyPush: (...args) => (pwa.retire ? pwa.retire(...args) : real.retireLegacyPush(...args)),
  };
});

import { formatMessage, previewText, highlightSnippet } from '../src/lib/format.js';
import { linkableText, firstLinkOf } from '../src/shared/limits.js';
import { words } from '../src/shared/search.js';
import { store } from '../src/lib/store.js';
import { idb } from '../src/lib/idb.js';

const REF = 'abc123def0@teamchat-test';
const OTHER = 'other00000@teamchat-test';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

/** Route each call by the end of its path; a handler may return a promise that waits. */
function worker(routes) {
  const calls = [];
  globalThis.puter = {
    workers: {
      exec: async (url, init = {}) => {
        const u = new URL(url);
        calls.push(`${init.method || 'GET'} ${u.pathname}${u.search}`);
        const hit = Object.entries(routes).find(([k]) => u.pathname.endsWith(k));
        if (!hit) return json({ code: 'not_found', message: 'nope' }, 404);
        return hit[1](u.searchParams, init);
      },
    },
  };
  return calls;
}

/** A bootstrap document for a workspace with these channels, all joined. */
const boot = (id, name, channels, extra = {}) => ({
  now: Date.now(),
  workspace: { id, name, channels, members: { 'u-me': { role: 'member', name: 'Me', username: 'me' } } },
  me: { role: 'member', channels: Object.keys(channels), dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} },
  activity: { c: {}, p: {}, w: 1, u: {} },
  ...extra,
});

function resetStore() {
  store.stopPolling();
  store.wsId = null;
  store.ws = null;
  store.me = null;
  store.profile = null;
  store.links = new Map();
  store.convs.clear();
  store._localSeen.clear();
  store._seenAt.clear();
  for (const t of store._readTimers.values()) clearTimeout(t);
  store._readTimers.clear();
  delete globalThis.puter;
}

describe('italics and strikethrough closed by punctuation', () => {
  it('render before a colon, a semicolon, a bracket or a quote, as they do before a period', () => {
    expect(formatMessage('_Note_: read this')).toBe('<em>Note</em>: read this');
    expect(formatMessage('_first_; _second_')).toBe('<em>first</em>; <em>second</em>');
    expect(formatMessage('(_sic_) and [_sic_]')).toBe('(<em>sic</em>) and [<em>sic</em>]');
    expect(formatMessage('"_quoted_" and \'_quoted_\'')).toBe('&quot;<em>quoted</em>&quot; and &#39;<em>quoted</em>&#39;');
    expect(formatMessage('~done~: next')).toBe('<s>done</s>: next');
    // As before: a period, a comma, and the end of the text.
    expect(formatMessage('_a_. _b_, _c_')).toBe('<em>a</em>. <em>b</em>, <em>c</em>');
  });

  it('still leaves an underscore inside a word alone', () => {
    expect(formatMessage('snake_case_name: value')).toBe('snake_case_name: value');
    expect(formatMessage('a_b_c; d')).toBe('a_b_c; d');
  });

  it('is what the worker takes off a link written in italics before a colon, so the address unfurled is the address drawn', () => {
    expect(linkableText('see _https://x.io/a_: now')).toBe('see https://x.io/a : now');
    expect(firstLinkOf('see _https://x.io/a_: now')).toBe('https://x.io/a');
    expect(formatMessage('see _https://x.io/a_: now')).toContain('<em><a href="https://x.io/a" ');
  });
});

describe('the plain-text preview', () => {
  it('keeps the characters of ordinary text that only look like marks', () => {
    expect(previewText('see x_train > 5 and ~/dir')).toBe('see x_train > 5 and ~/dir');
    expect(previewText('set MAX_RETRIES=3 in config_dev')).toBe('set MAX_RETRIES=3 in config_dev');
    expect(previewText('2 * 3 = 6 and a*b')).toBe('2 * 3 = 6 and a*b');
    expect(previewText('https://a.com/some_path/a~b')).toBe('https://a.com/some_path/a~b');
  });

  it('takes off exactly the marks the renderer consumes', () => {
    expect(previewText('_Note_: read **this** ~now~ in `code_x`')).toBe('Note: read this now in code_x');
    expect(previewText('> quoted line\n> more\nreply')).toBe('quoted line more reply');
    expect(previewText('```js\nlet x_y = 1\n```\ndone')).toBe('[code] done');
    // As before: a fenced block on one line, and the length cap.
    expect(previewText('**hi**\n```code```\nthere')).toBe('hi [code] there');
    expect(previewText('x'.repeat(100), 10)).toHaveLength(10);
  });
});

describe('a search snippet in Chinese or Japanese', () => {
  it('marks the stretch of a clause the query covers, not nothing and not the whole clause', () => {
    expect(highlightSnippet('我喜欢猫和狗', words('喜欢猫'))).toBe('我<mark>喜欢猫</mark>和狗');
    expect(highlightSnippet('ガラスの器です', words('ガラス'))).toBe('<mark>ガラス</mark>の器です');
    // Two stretches, and a Latin word beside a clause, as before.
    expect(highlightSnippet('我喜欢猫和狗，也喜欢鸟', words('喜欢'))).toBe('我<mark>喜欢</mark>猫和狗，也<mark>喜欢</mark>鸟');
    expect(highlightSnippet('café 我喜欢猫', words('cafe 喜欢'))).toBe('<mark>café</mark> 我<mark>喜欢</mark>猫');
    // A query of one character yields no pair, and marks nothing, as it finds nothing.
    expect(highlightSnippet('我喜欢猫', words('猫'))).toBe('我喜欢猫');
  });

  it('starts the snippet near the first covered stretch of a long clause', () => {
    const s = highlightSnippet(`${'前'.repeat(200)}喜欢猫${'后'.repeat(50)}`, words('喜欢'), 60);
    expect(s).toContain('<mark>喜欢</mark>');
    expect(s.startsWith('…')).toBe(true);
  });
});

describe('a mention followed by a period or a hyphen', () => {
  const members = { alice: { uuid: 'u1', name: 'Alice' }, 'bob.smith': { uuid: 'u2', name: 'Bob' } };
  const chip = (uuid, name) => `<span class="mention${uuid === 'u1' ? ' mention-me' : ''}" data-uuid="${uuid}">@${name}</span>`;

  it('keeps the punctuation after the chip instead of swallowing it', () => {
    expect(formatMessage('Thanks @alice.', { members, me: 'u1' })).toBe(`Thanks ${chip('u1', 'Alice')}.`);
    expect(formatMessage('@alice... yes', { members, me: 'u1' })).toBe(`${chip('u1', 'Alice')}... yes`);
    expect(formatMessage('@alice - hi, @bob.smith. ok', { members, me: 'u1' })).toBe(`${chip('u1', 'Alice')} - hi, ${chip('u2', 'Bob')}. ok`);
    // A dot inside the handle is part of it, as the worker reads it.
    expect(formatMessage('cc @bob.smith', { members })).toBe(`cc ${chip('u2', 'Bob')}`);
  });

  it('draws @channel. as the broadcast the worker rings for it', () => {
    expect(formatMessage('heads up @channel.')).toBe('heads up <span class="mention mention-broadcast">@channel</span>.');
    expect(formatMessage('@here- now')).toBe('<span class="mention mention-broadcast">@here</span>- now');
  });
});

describe('a bootstrap asked for before a switch away and back', () => {
  afterEach(resetStore);

  it('is not laid over the fresh bootstrap the return brought', async () => {
    // The first opening of the workspace is slow to answer; the user goes
    // to another workspace and comes straight back, and the return's own
    // bootstrap (fresh: a channel joined meanwhile) lands first.
    let releaseStale;
    const stale = new Promise((r) => { releaseStale = r; });
    let reads = 0;
    worker({
      '/api/ws/abc123def0': async () => {
        if (++reads === 1) {
          await stale;
          return json(boot('abc123def0', 'Globex', { c1: { id: 'c1', name: 'ops' } }));
        }
        return json(boot('abc123def0', 'Globex', { c1: { id: 'c1', name: 'ops' }, c2: { id: 'c2', name: 'design' } }));
      },
      '/api/ws/other00000': () => json(boot('other00000', 'Initech', { g: { id: 'g', name: 'general' } })),
      '/sync': () => json({ now: Date.now(), ts: Date.now(), c: {}, p: {}, w: 1, u: 0 }),
    });
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    const first = store.openWorkspace(REF);
    await tick();
    await store.openWorkspace(OTHER);
    const fresh = await store.openWorkspace(REF);
    expect(Object.keys(fresh.workspace.channels)).toEqual(['c1', 'c2']);
    expect(Object.keys(store.ws.channels)).toEqual(['c1', 'c2']);
    releaseStale();
    const late = await first;
    // The late answer is not this workspace's document any more: nothing of it is applied.
    expect(late).toBeNull();
    expect(Object.keys(store.ws.channels)).toEqual(['c1', 'c2']);
    expect(store.isJoined('c2')).toBe(true);
  });
});

describe('unfollowing a thread while a workspace document is on its way', () => {
  afterEach(() => {
    store._notifyPending.clear();
    resetStore();
  });

  it('keeps the Threads badge cleared over a document from before the unfollow, as it keeps the unfollow itself', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let reads = 0;
    const doc = (threads, notify) => json({ now: Date.now(), workspace: store.ws, me: { ...store.me, threads, notify }, activity: { c: {}, p: {}, w: 1, u: {} } });
    worker({
      '/api/ws/abc123def0': async () => {
        if (++reads === 1) {
          // Asked before the unfollow, answered after it: three unread replies, still followed.
          await gate;
          return doc({ c1_t5: 3 }, {});
        }
        // Asked after the write landed: the worker zeroed the count with the flag.
        return doc({}, { c1_t5: { follow: false } });
      },
      '/notify': () => json({ ok: true }),
    });
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: { 'u-me': { role: 'member', name: 'Me', username: 'me' }, u2: { role: 'member', name: 'Two', username: 'two' } } };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: { c1_t5: 3 } };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    Object.assign(store.conv('c1'), { loaded: true, messages: [{ seq: 5, user: 'u2', text: 'root', ts: 1, replyCount: 3, followers: { 'u-me': 1 } }] });
    expect(store.threadBadge()).toBe(3);
    const stale = store.refreshWorkspace();
    await tick();
    await store.followThread('c1', 5, false);
    expect(store.threadBadge()).toBe(0);
    release();
    await stale;
    expect(store.followsThread('c1', 5)).toBe(false);
    expect(store.threadBadge()).toBe(0);
    // A document built after the write is trusted, and agrees.
    await store.refreshWorkspace();
    expect(store.threadBadge()).toBe(0);
    expect(store.followsThread('c1', 5)).toBe(false);
  });
});

describe('a message sent into a shared channel whose host says the standing there has lapsed', () => {
  const HOST = 'host00host@teamchat-test';
  afterEach(resetStore);

  it('is sent once the host has renewed it, under the same client id, rather than shown as failed', async () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { e1: { id: 'e1', name: 'design-acme', shared: { ref: HOST, ch: 'hch', conn: 'conn000001', host: 'Acme' } } }, members: { 'u-me': { role: 'admin', name: 'Me', username: 'me' } } };
    store.me = { role: 'admin', channels: ['e1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    const hostBoot = () => ({
      now: Date.now(),
      workspace: { id: 'host00host', name: 'Acme', channels: { hch: { id: 'hch', name: 'design', count: 3 } }, members: { 'u-me': { role: 'external', name: 'Me', username: 'me', exp: Date.now() + 86_400_000 } } },
      me: { role: 'external', channels: ['hch'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} },
      activity: { c: {}, p: {} },
    });
    // The link loaded a day ago (the laptop slept since); the day the host gives has run out.
    store.links.set(HOST, {
      ref: HOST, ws: hostBoot().workspace, me: hostBoot().me, act: null, since: 0, w: 0, u: 0, convs: new Map([['hch', 'e1']]),
      loaded: true, loading: null, syncing: null, error: null, lost: false, failures: 0, retryAt: 0, lostConvs: new Map(), rejoinAt: {},
    });
    Object.assign(store.conv('e1'), { loaded: true, seq: 6, messages: [{ seq: 6, user: 'u2', text: 'earlier', ts: 1 }] });
    let renewed = false;
    const cids = [];
    const lapsed = () => json({ code: 'reattest', message: 'Your access to this shared channel needs renewing' }, 403);
    const calls = worker({
      '/api/ws/host00host': () => (renewed ? json(hostBoot()) : lapsed()),
      '/channels/e1/attest': () => json({ ref: HOST, ch: 'hch', conn: 'conn000001', token: 'x.y' }),
      '/api/connect/join': () => { renewed = true; return json({ ok: true, exp: Date.now() + 86_400_000 }); },
      '/conv/hch/messages': (q, init) => {
        const body = JSON.parse(init.body);
        cids.push(body.cid);
        if (!renewed) return lapsed();
        return json({ message: { seq: 7, user: 'u-me', text: body.text, ts: 5, kind: 'msg', attachments: [], mentions: [], reactions: {}, replyCount: 0, cid: body.cid } });
      },
    });
    const sent = await store.send('e1', { text: 'morning' });
    expect(sent.seq).toBe(7);
    const c = store.conv('e1');
    expect(c.messages.map((m) => m.seq)).toEqual([6, 7]);
    expect(c.messages.some((m) => m.failed)).toBe(false);
    // Posted twice under one client id, with the renewal in between.
    expect(cids).toHaveLength(2);
    expect(cids[0]).toBe(cids[1]);
    expect(calls.some((x) => x.endsWith('/api/connect/join'))).toBe(true);
    expect(store.links.get(HOST).loaded).toBe(true);
  });
});

describe('signing out with a push subscription made before pushes went through Puter', () => {
  afterEach(() => {
    pwa.retire = null;
    store.workspaces = [];
    delete globalThis.puter;
  });

  it('has every server told at once, within a bound, then signs out', async () => {
    const seen = [];
    pwa.retire = async (refs, waitMs) => { seen.push({ refs, waitMs }); };
    let signedOut = false;
    globalThis.puter = { auth: { signOut: async () => { signedOut = true; } } };
    store.workspaces = [{ ref: 'dead000000@teamchat-x' }, { ref: 'live000000@teamchat-x' }, { ref: 'live111111@teamchat-x' }];
    await store.signOut();
    expect(signedOut).toBe(true);
    expect(seen).toEqual([{ refs: ['dead000000@teamchat-x', 'live000000@teamchat-x', 'live111111@teamchat-x'], waitMs: expect.any(Number) }]);
    expect(seen[0].waitMs).toBeLessThan(8000);
  });

  it('signs out even when letting go of it fails', async () => {
    pwa.retire = async () => { throw new Error('gone'); };
    let signedOut = false;
    globalThis.puter = { auth: { signOut: async () => { signedOut = true; } } };
    store.workspaces = [{ ref: 'live000000@teamchat-x' }];
    await store.signOut();
    expect(signedOut).toBe(true);
  });
});

describe('renewing the member\'s standing on a host, on a device whose clock is off', () => {
  const HOST = 'host00host@teamchat-test';
  afterEach(() => {
    store._clockOffset = 0;
    resetStore();
  });

  it('renews when the host\'s expiry is within the hour by the workers\' clock, though the device runs two hours behind', async () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { e1: { id: 'e1', name: 'design-acme', shared: { ref: HOST, ch: 'hch', conn: 'conn000001', host: 'Acme' } } }, members: { 'u-me': { role: 'admin', name: 'Me', username: 'me' } } };
    store.me = { role: 'admin', channels: ['e1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    // The workers' clock, as the poll's stamps taught it, runs two hours ahead of this device.
    store._clockOffset = 2 * 3600_000;
    const exp = store.serverNow() + 30 * 60_000; // half an hour left, by the host's clock
    store.links.set(HOST, {
      ref: HOST,
      ws: { id: 'host00host', name: 'Acme', channels: { hch: { id: 'hch', name: 'design' } }, members: { 'u-me': { role: 'external', name: 'Me', username: 'me', exp } } },
      me: { role: 'external', channels: ['hch'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} },
      act: null, since: 0, w: 0, u: 0, convs: new Map([['hch', 'e1']]),
      loaded: true, loading: null, syncing: null, error: null, lost: false, failures: 0, retryAt: 0, lostConvs: new Map(), rejoinAt: {},
    });
    const calls = worker({
      '/channels/e1/attest': () => json({ ref: HOST, ch: 'hch', conn: 'conn000001', token: 'x.y' }),
      '/api/connect/join': () => json({ ok: true, exp: exp + 86_400_000 }),
    });
    const link = store.links.get(HOST);
    store._renewLink(link);
    // Measured on the device's clock there were two and a half hours left, and nothing was renewed.
    expect(link.renewing).toBeTruthy();
    await link.renewing;
    expect(calls.some((c) => c.endsWith('/api/connect/join'))).toBe(true);
    expect(link.ws.members['u-me'].exp).toBe(exp + 86_400_000);
  });
});

describe('the offline cache of conversation pages', () => {
  const real = { ...idb };
  afterEach(() => {
    Object.assign(idb, real);
    delete store._pruneCache;
    resetStore();
  });

  it('keeps the newest two hundred pages, letting the oldest go once fifty more have gathered, and never touches the bootstraps', async () => {
    const rows = new Map();
    for (let i = 0; i < 260; i++) rows.set(`conv:ws:c${i}`, { key: `conv:ws:c${i}`, ts: 1000 + i, messages: [] });
    rows.set('ws:abc', { key: 'ws:abc', ts: 5, data: {} });
    let reads = 0;
    Object.assign(idb, {
      keys: async () => [...rows.keys()],
      all: async () => { reads++; return [...rows.values()]; },
      del: async (s, key) => { rows.delete(key); },
    });
    await store._pruneCache();
    expect([...rows.keys()].filter((k) => k.startsWith('conv:'))).toHaveLength(200);
    expect(rows.has('conv:ws:c59')).toBe(false);
    expect(rows.has('conv:ws:c60')).toBe(true);
    expect(rows.has('conv:ws:c259')).toBe(true);
    expect(rows.has('ws:abc')).toBe(true);
    expect(reads).toBe(1);
    // Under the margin again: the keys are counted, the pages are not read.
    await store._pruneCache();
    expect(reads).toBe(1);
  });

  it('is asked for after a page is written', async () => {
    let pruned = 0;
    store._pruneCache = async () => { pruned++; };
    Object.assign(idb, { put: async () => 'conv:x' });
    worker({ '/messages': () => json({ seq: 1, hasMore: false, messages: [{ seq: 1, text: 'a', user: 'u2', ts: 1 }] }) });
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: {} };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    await store.loadConversation('c1');
    await tick();
    expect(pruned).toBe(1);
  });
});

describe('an id that is the name of an inherited property', () => {
  afterEach(resetStore);

  it('names nobody and nothing: no member card, channel or direct message comes out of Object.prototype', () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: { 'u-me': { role: 'admin', name: 'Me', username: 'me' } }, former: {} };
    store.me = { role: 'admin', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    store.links.set('host00host@teamchat-test', { ref: 'host00host@teamchat-test', ws: { name: 'Acme', members: {}, former: {} }, me: { role: 'external', dms: {} }, convs: new Map(), loaded: true, lostConvs: new Map(), rejoinAt: {} });
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const card = store.member(id);
      expect(card.name).toBe('Former member');
      expect(card.gone).toBe(true);
      expect(store.author({ user: id }).name).toBe('Former member');
      expect(store._known(id)).toBe(false);
      expect(store.isAdmin(id)).toBe(false);
      expect(store.isGuest(id)).toBe(false);
      expect(store.channel(id)).toBeNull();
      expect(store.canAccess(id)).toBe(false);
      expect(store.isJoined(id)).toBe(false);
      expect(store.convTitle(id)).toBe('Conversation');
      expect(store.convKind(id)).toBe('channel');
      expect(store.canHuddle(id)).toBe(false);
      expect(store.hostOf(id).ref).toBe(REF);
    }
    // A real member and channel are found as before.
    expect(store.member('u-me').name).toBe('Me');
    expect(store.channel('c1').name).toBe('ops');
  });
});

describe('two messages queued as the connection goes', () => {
  // Node's own `navigator` is a getter on the global: the browser's word on the connection is put in its place for the test.
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const offline = () => Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  afterEach(async () => {
    if (navigatorWas) Object.defineProperty(globalThis, 'navigator', navigatorWas);
    else delete globalThis.navigator;
    for (const e of await store.outbox.list()) await store.outbox.remove(e.id);
    resetStore();
  });

  it('go out in the order they were written, though the first was still on its way when the second was queued', async () => {
    let dropFirst;
    const inFlight = new Promise((_, reject) => { dropFirst = reject; });
    worker({
      '/messages': async (q, init) => {
        const body = JSON.parse(init.body);
        if (body.text === 'first') await inFlight; // rejected below: the request fails for want of a connection
        return json({ message: { seq: 1, user: 'u-me', text: body.text, ts: 5, kind: 'msg', attachments: [], mentions: [], reactions: {}, cid: body.cid } });
      },
    });
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: { 'u-me': { role: 'member', name: 'Me', username: 'me' } } };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    Object.assign(store.conv('c1'), { loaded: true, seq: 0, messages: [] });
    const first = store.send('c1', { text: 'first' });
    await tick(5);
    // The connection drops: the browser says so, and the next message is queued at once.
    offline();
    await store.send('c1', { text: 'second' });
    await tick(5);
    dropFirst(new Error('Failed to fetch'));
    await first;
    const queued = await store.outbox.list();
    expect(queued.map((e) => e.text)).toEqual(['first', 'second']);
    // The window shows them in that order too.
    expect(store.conv('c1').messages.map((m) => m.text)).toEqual(['first', 'second']);
  });
});

describe('the Later count', () => {
  afterEach(() => {
    store._saved = null;
    store._savedDone = new Set();
    store._savedCount = 0;
    resetStore();
  });

  it('counts a message saved twice once, and comes down only for an item not yet done', async () => {
    const items = [{ c: 'c1', s: 1, ts: 100, done: true }, { c: 'c1', s: 2, ts: 90 }];
    const posts = [];
    worker({
      '/saved': (q, init) => {
        if (init.method !== 'POST') return json({ items });
        const b = JSON.parse(init.body);
        posts.push(b);
        // A plain save of a message the worker already holds says so.
        if (b.remove || b.done !== undefined) return json({ ok: true });
        return json({ ok: true, saved: true, already: items.some((i) => i.c === b.conv && i.s === b.seq) });
      },
    });
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: {} };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    await store.loadSaved();
    expect(store.savedCount()).toBe(1); // the done one is not counted
    await store.save('c1', 2); // saved already: a double tap
    expect(store.savedCount()).toBe(1);
    expect(store.isSaved('c1', 2)).toBe(true);
    await store.save('c1', 3);
    expect(store.savedCount()).toBe(2);
    await store.unsave('c1', 1); // removing a done item: nothing to take off
    expect(store.savedCount()).toBe(2);
    expect(store.isSaved('c1', 1)).toBe(false);
    await store.saveDone({ c: 'c1', s: 2 }, true);
    expect(store.savedCount()).toBe(1);
    await store.saveDone({ c: 'c1', s: 2 }, true); // done already: moves nothing
    expect(store.savedCount()).toBe(1);
    await store.saveDone({ c: 'c1', s: 2 }, false);
    expect(store.savedCount()).toBe(2);
    await store.unsave('c1', 2);
    expect(store.savedCount()).toBe(1);
    expect(posts).toHaveLength(7);
  });
});

describe('a reaction tapped twice in quick succession', () => {
  afterEach(resetStore);

  it('reaches the worker as on, then off, the second only once the first was answered', async () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const seen = [];
    worker({
      '/reactions': async (q, init) => {
        const b = JSON.parse(init.body);
        seen.push(b.on);
        if (seen.length === 1) await held; // the first answer is slow
        return json({ ok: true });
      },
    });
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { c1: { id: 'c1', name: 'ops' } }, members: {} };
    store.me = { role: 'member', channels: ['c1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    Object.assign(store.conv('c1'), { loaded: true, seq: 5, messages: [{ seq: 5, user: 'u2', text: 'root', ts: 1, reactions: {} }] });
    const first = store.react('c1', 5, '+1');
    await tick();
    const second = store.react('c1', 5, '+1');
    await tick(5);
    // The screen flipped twice at once; the worker has seen the first toggle alone so far.
    expect(store.conv('c1').messages[0].reactions['+1']).toBeUndefined();
    expect(seen).toEqual([true]);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([true, false]);
  });
});

describe('the notification chime in two tabs of one browser', () => {
  const had = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage') };
  const restore = (name) => {
    if (had[name]) Object.defineProperty(globalThis, name, had[name]);
    else delete globalThis[name];
  };
  afterEach(() => {
    restore('window');
    restore('localStorage');
    vi.resetModules();
  });

  it('rings once for one message: the second tab hears that the first has just rung', async () => {
    let started = 0;
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() { started++; }, stop() {} }; }
    }
    // The browser's storage, shared by its tabs.
    const mem = new Map();
    Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'window', { value: { AudioContext: FakeAudioContext }, configurable: true, writable: true });
    // Two tabs: two instances of the module, with nothing in common but the storage.
    vi.resetModules();
    const tabA = await import('../src/lib/notify.js');
    vi.resetModules();
    const tabB = await import('../src/lib/notify.js');
    tabA.playNotificationSound();
    expect(started).toBe(3); // the two notes and the shimmer
    tabB.playNotificationSound();
    expect(started).toBe(3);
    // Two seconds on, either may ring again.
    mem.set('teamchat:chime', String(Date.now() - 2500));
    tabB.playNotificationSound();
    expect(started).toBe(6);
  });
});

describe('the IndexedDB connection closed under the page', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  afterEach(() => {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had);
    else delete globalThis.indexedDB;
    vi.resetModules();
  });

  it('is opened anew on the next call rather than failing every call from then on', async () => {
    let opens = 0;
    let db = null;
    // A database whose reads answer, and whose open the test counts.
    const fakeDb = () => ({
      objectStoreNames: { contains: () => true },
      close() {},
      transaction() {
        const t = {};
        const req = {};
        queueMicrotask(() => {
          req.result = { key: 'k', n: opens };
          req.onsuccess?.();
          t.oncomplete?.();
        });
        t.objectStore = () => ({ get: () => req });
        return t;
      },
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open() {
          opens++;
          const req = {};
          queueMicrotask(() => {
            req.result = db = fakeDb();
            req.onsuccess?.();
          });
          return req;
        },
      },
      configurable: true,
      writable: true,
    });
    vi.resetModules();
    const { idb } = await import('../src/lib/idb.js');
    expect(await idb.get('cache', 'k')).toEqual({ key: 'k', n: 1 });
    expect(await idb.get('cache', 'k')).toEqual({ key: 'k', n: 1 });
    expect(opens).toBe(1);
    // The browser closes the connection (site data cleared, storage reclaimed).
    db.onclose?.();
    expect(await idb.get('cache', 'k')).toEqual({ key: 'k', n: 2 });
    expect(opens).toBe(2);
  });
});

describe('a host document asked for before the link was loaded afresh', () => {
  const HOST = 'host00host@teamchat-test';
  afterEach(resetStore);

  it('is not laid over the fresher document the reload brought', async () => {
    store.wsId = REF;
    store.profile = { uuid: 'u-me', username: 'me', name: 'Me', prefs: {} };
    store.ws = { id: 'abc123def0', name: 'Globex', channels: { e1: { id: 'e1', name: 'design-acme', shared: { ref: HOST, ch: 'hch', conn: 'conn000001', host: 'Acme' } } }, members: { 'u-me': { role: 'admin', name: 'Me', username: 'me' } } };
    store.me = { role: 'admin', channels: ['e1'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} };
    store.act = { c: {}, p: {}, w: 0, u: 0 };
    const hostBoot = (topic) => ({
      now: Date.now(),
      workspace: { id: 'host00host', name: 'Acme', channels: { hch: { id: 'hch', name: 'design', topic } }, members: { 'u-me': { role: 'external', name: 'Me', username: 'me' } } },
      me: { role: 'external', channels: ['hch'], dms: {}, reads: {}, mentions: {}, notify: {}, threads: {} },
      activity: { c: {}, p: {}, w: 1, u: {} },
    });
    let releaseSlow;
    const slow = new Promise((r) => { releaseSlow = r; });
    let reads = 0;
    worker({
      '/api/ws/host00host': async () => {
        reads++;
        // The second read (a refresh after the host's poll said something changed) is slow, and answers the older document.
        if (reads === 2) {
          await slow;
          return json(hostBoot('Pixels'));
        }
        return json(hostBoot(reads === 1 ? 'Pixels' : 'Vectors'));
      },
    });
    store._syncLinks();
    const link = store.links.get(HOST);
    await link.loading;
    expect(store.ws.channels.e1.topic).toBe('Pixels');
    const refresh = store._refreshLink(link);
    await tick();
    // The host then asked for a fresh attestation (its poll answered 403): the link is loaded anew, and that answer lands first.
    link.loaded = false;
    await store._loadLink(link);
    expect(store.ws.channels.e1.topic).toBe('Vectors');
    releaseSlow();
    await refresh;
    expect(store.ws.channels.e1.topic).toBe('Vectors');
    expect(link.loaded).toBe(true);
  });
});
