/**
 * Web Push from the worker: the encryption and VAPID pieces are checked by
 * decrypting what a fake push service receives, the way a browser would.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boot, as, USERS, workspaceWith } from './helpers/harness.js';
import { KEYS } from '../src/shared/blocks.js';
import { encryptPayload, vapidAuth, vapidKeys, fromB64url, b64url, pushAllowed } from '../worker/push.js';

const { alice, bob, carol } = USERS;
const subtle = crypto.subtle;
const enc = new TextEncoder();
let rt;
let received;
const realFetch = globalThis.fetch;

async function subscriber() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair, auth,
    subscription: { endpoint: `https://push.example.com/send/${b64url(crypto.getRandomValues(new Uint8Array(8)))}`, keys: { p256dh: b64url(await subtle.exportKey('raw', pair.publicKey)), auth: b64url(auth) } },
  };
}

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let o = 0; for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; } return out; };

/** What a browser does with an aes128gcm push body. */
async function decrypt(sub, body) {
  const buf = new Uint8Array(body);
  const salt = buf.slice(0, 16);
  const idlen = buf[20];
  const asPub = buf.slice(21, 21 + idlen);
  const cipher = buf.slice(21 + idlen);
  const uaPub = new Uint8Array(await subtle.exportKey('raw', sub.pair.publicKey));
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.pair.privateKey, 256));
  const ikm = await hkdf(sub.auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  const end = plain.lastIndexOf(2);
  return new TextDecoder().decode(plain.slice(0, end));
}

beforeEach(async () => {
  rt = await boot();
  received = [];
  globalThis.fetch = async (url, init) => {
    received.push({ url: String(url), headers: init.headers, body: new Uint8Array(await new Response(init.body).arrayBuffer()) });
    return new Response('', { status: 201 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(rt.kv._calls.list).toBe(0);
});

describe('push crypto', () => {
  it('encrypts a payload a subscriber can decrypt, and signs VAPID tokens', async () => {
    const sub = await subscriber();
    const body = await encryptPayload(sub.subscription, JSON.stringify({ hello: 'world' }));
    expect(JSON.parse(await decrypt(sub, body))).toEqual({ hello: 'world' });
    const keys = await vapidKeys();
    expect(fromB64url(keys.pub)).toHaveLength(65);
    const auth = await vapidAuth(sub.subscription.endpoint, keys);
    expect(auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const [, jwt] = /t=([^,]+)/.exec(auth);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromB64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    const pub = await subtle.importKey('raw', fromB64url(keys.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromB64url(sig), enc.encode(`${h}.${c}`))).toBe(true);
    // The key pair is stable per worker.
    expect((await vapidKeys()).pub).toBe(keys.pub);
  });

  it('respects a device\'s pause and quiet hours', () => {
    const now = Date.UTC(2026, 7, 26, 22, 30); // 22:30 UTC
    expect(pushAllowed(null, now)).toBe(true);
    expect(pushAllowed({ pauseUntil: now + 1000 }, now)).toBe(false);
    expect(pushAllowed({ pauseUntil: now - 1000 }, now)).toBe(true);
    // 22:00–08:00 local in a UTC+2 zone: 22:30 UTC is 00:30 local, inside.
    expect(pushAllowed({ tzOffset: 120, dnd: { enabled: true, from: 22 * 60, to: 8 * 60 } }, now)).toBe(false);
    // Same window in UTC-8: 14:30 local, outside.
    expect(pushAllowed({ tzOffset: -480, dnd: { enabled: true, from: 22 * 60, to: 8 * 60 } }, now)).toBe(true);
    expect(pushAllowed({ dnd: { enabled: false, from: 0, to: 1439 } }, now)).toBe(true);
  });
});

describe('push routes and delivery', () => {
  const post = (u, wsId, conv, text) => as(u).post(`/api/ws/${wsId}/conv/${conv}/messages`, { text });

  it('suppresses legacy Web Push while a member has recent visible presence', async () => {
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const dev = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription });
    await as(bob).get(`/api/ws/${wsId}/sync?since=0&hb=1`);
    await post(alice, wsId, general.id, '@bob present');
    expect(received).toHaveLength(0);
    await rt.kv.remove(KEYS.activity(wsId), `p.${bob.uuid}`);
    await post(alice, wsId, general.id, '@bob away');
    expect(received).toHaveLength(1);
  });

  it('subscribes a device and pushes mentions and direct messages, encrypted, with the deep link', async () => {
    const { wsId, general } = await workspaceWith(alice, [bob, carol]);
    const key = await as(bob).get(`/api/ws/${wsId}/push/key`);
    expect(fromB64url(key.data.key)).toHaveLength(65);
    const dev = await subscriber();
    expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: { endpoint: 'http://insecure', keys: dev.subscription.keys } })).status).toBe(400);
    // The worker will POST to this endpoint later, so private and loopback hosts are refused like any outbound URL.
    for (const bad of ['https://10.0.0.5/push', 'https://localhost/push', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://user:pw@push.example.com/x']) {
      expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: { endpoint: bad, keys: dev.subscription.keys } })).status, bad).toBe(400);
    }
    const r = await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription, prefs: { tzOffset: 0, dnd: { enabled: false } } });
    expect(r.ok).toBe(true);
    const doc = await rt.kv.get(KEYS.member(wsId, bob.uuid));
    expect(Object.values(doc.push)[0].endpoint).toBe(dev.subscription.endpoint);

    // A mention pushes to bob; a plain message does not.
    await post(alice, wsId, general.id, 'nothing for anyone');
    expect(received).toHaveLength(0);
    const m = await post(alice, wsId, general.id, 'hey @bob look');
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe(dev.subscription.endpoint);
    expect(received[0].headers['Content-Encoding']).toBe('aes128gcm');
    expect(received[0].headers.Authorization).toMatch(/^vapid /);
    expect(received[0].headers.TTL).toBe('3600');
    const payload = JSON.parse(await decrypt(dev, received[0].body));
    expect(payload).toMatchObject({ title: 'alice in #general', body: 'hey @bob look', tag: `${wsId}@teamchat-api.test:mention-${general.id}` });
    expect(payload.route).toBe(`#/ws/${wsId}@teamchat-api.test/c/${general.id}/m/${m.data.message.seq}`);
    // A direct message pushes as 'message'.
    const dm = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    await post(alice, wsId, dm, 'psst');
    expect(received).toHaveLength(2);
    expect(JSON.parse(await decrypt(dev, received[1].body))).toMatchObject({ title: 'alice', body: 'psst' });
    // In a group, a message that names someone else is a plain message to
    // the others: at "mentions only" bob hears nothing, and a plain message
    // at the default level reaches him as a message, not as a mention.
    const group = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid, carol.uuid] })).data.conv;
    await as(bob).put(`/api/ws/${wsId}/conv/${group}/notify`, { level: 'mentions' });
    await post(alice, wsId, group, '@carol look at this');
    expect(received).toHaveLength(2);
    await post(alice, wsId, group, '@bob and you');
    expect(received).toHaveLength(3);
    expect(JSON.parse(await decrypt(dev, received[2].body)).tag).toBe(`${wsId}@teamchat-api.test:mention-${group}`);
    await as(bob).put(`/api/ws/${wsId}/conv/${group}/notify`, { level: 'all' });
    await post(alice, wsId, group, '@carol again');
    expect(received).toHaveLength(4);
    expect(JSON.parse(await decrypt(dev, received[3].body)).tag).toBe(`${wsId}@teamchat-api.test:message-${group}`);
    // A mention of bob himself at "all messages" is still a mention (the
    // preview-off body would say so) but wears the message tag: the page
    // announces the carrying message, and the two banners must coalesce.
    await post(alice, wsId, group, '@bob at all messages');
    expect(received).toHaveLength(5);
    expect(JSON.parse(await decrypt(dev, received[4].body))).toMatchObject({ tag: `${wsId}@teamchat-api.test:message-${group}`, body: '@bob at all messages' });
    received.length = 2;
    // A mention in a private channel bob is not in pushes nothing to him.
    const secret = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'secret', private: true })).data.channel;
    await post(alice, wsId, secret.id, '@bob you cannot read this');
    expect(received).toHaveLength(2);
    // Muting the channel silences its pushes; "nothing" too; carol has no device.
    await as(bob).put(`/api/ws/${wsId}/conv/${general.id}/notify`, { mute: true });
    await post(alice, wsId, general.id, '@bob again');
    expect(received).toHaveLength(2);
    await as(bob).put(`/api/ws/${wsId}/conv/${general.id}/notify`, { mute: false, level: 'nothing' });
    await post(alice, wsId, general.id, '@bob once more');
    expect(received).toHaveLength(2);
    // "All messages" pushes every message in that channel.
    await as(bob).put(`/api/ws/${wsId}/conv/${general.id}/notify`, { level: 'all' });
    await post(alice, wsId, general.id, 'plain');
    expect(received).toHaveLength(3);
    // Pause: nothing while paused.
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription, prefs: { pauseUntil: Date.now() + 60_000 } });
    await post(alice, wsId, general.id, '@bob paused');
    expect(received).toHaveLength(3);
    // Preview off: the body says who, not what.
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription, prefs: {}, preview: false });
    await post(alice, wsId, dm, 'secret text');
    expect(JSON.parse(await decrypt(dev, received[3].body)).body).toBe('New message');
    // Unsubscribe; and a dead endpoint is dropped by itself.
    await as(bob).del(`/api/ws/${wsId}/push`, { endpoint: dev.subscription.endpoint });
    expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).push).toEqual({});
    const dead = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dead.subscription });
    globalThis.fetch = async () => new Response('', { status: 410 });
    await post(alice, wsId, dm, 'gone?');
    expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).push).toEqual({});
  });

  it('pushes a channel set to "all messages" only while its member is still in it', async () => {
    const { wsId } = await workspaceWith(alice, [bob]);
    const dev = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription });
    const ch = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'busy' })).data.channel;
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ch.id}/join`, {})).ok).toBe(true);
    await as(bob).put(`/api/ws/${wsId}/conv/${ch.id}/notify`, { level: 'all' });
    await post(alice, wsId, ch.id, 'first');
    expect(received).toHaveLength(1);
    expect((await as(bob).post(`/api/ws/${wsId}/channels/${ch.id}/leave`, {})).ok).toBe(true);
    await post(alice, wsId, ch.id, 'after leaving');
    expect(received).toHaveLength(1);
  });

  it('carries an "all messages" setting made before the index existed into it when the member opens the workspace', async () => {
    const { wsId } = await workspaceWith(alice, [bob]);
    const dev = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription });
    const ch = (await as(alice).post(`/api/ws/${wsId}/channels`, { name: 'older' })).data.channel;
    await as(bob).post(`/api/ws/${wsId}/channels/${ch.id}/join`, {});
    await rt.kv.update(KEYS.member(wsId, bob.uuid), { [`notify.${ch.id}.level`]: 'all' });
    await post(alice, wsId, ch.id, 'not yet');
    expect(received).toHaveLength(0);
    await as(bob).get(`/api/ws/${wsId}`);
    await vi.waitFor(async () => expect((await rt.kv.get(KEYS.member(wsId, bob.uuid))).naSync).toBe(1));
    await post(alice, wsId, ch.id, 'now');
    expect(received).toHaveLength(1);
  });

  it('pushes a huddle started in a direct message as a call, previews off or on', async () => {
    const { wsId } = await workspaceWith(alice, [bob]);
    const dev = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription, prefs: {}, preview: false });
    const dm = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    const r = await as(alice).post(`/api/ws/${wsId}/conv/${dm}/huddle`, { invite: 'NJ-AAA111' });
    expect(r.ok).toBe(true);
    expect(received).toHaveLength(1);
    const quiet = JSON.parse(await decrypt(dev, received[0].body));
    // The event is no secret, so the body names it even with previews off, rather than "Mentioned you".
    // And a call keeps the mention tag whatever the level: the page's huddle banner carries the same.
    expect(quiet).toMatchObject({ title: 'alice', body: 'started a huddle', tag: `${wsId}@teamchat-api.test:mention-${dm}` });
    expect(quiet.route).toContain(`/c/${dm}/m/`);
    // A muted direct message rings nobody; joining tells nobody again.
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { mute: true });
    await as(alice).del(`/api/ws/${wsId}/conv/${dm}/huddle`);
    await as(alice).post(`/api/ws/${wsId}/conv/${dm}/huddle`, { invite: 'NJ-AAA222' });
    expect(received).toHaveLength(1);
  });

  it('pushes a reply inside a direct message like the direct message itself', async () => {
    const { wsId, general } = await workspaceWith(alice, [bob, carol]);
    const dev = await subscriber();
    await as(bob).post(`/api/ws/${wsId}/push`, { subscription: dev.subscription });
    const dm = (await as(alice).post(`/api/ws/${wsId}/dms`, { members: [bob.uuid] })).data.conv;
    const root = (await post(bob, wsId, dm, 'a question')).data.message.seq;
    const thread = `${dm}_t${root}`;
    const reply = await post(alice, wsId, thread, 'an answer');
    expect(reply.ok).toBe(true);
    expect(received).toHaveLength(1);
    const payload = JSON.parse(await decrypt(dev, received[0].body));
    // Tagged the way the page announces a reply to the thread's followers
    // (reply-{thread}), so the two banners for one reply coalesce.
    expect(payload).toMatchObject({ title: 'alice', body: 'an answer', tag: `${wsId}@teamchat-api.test:reply-${thread}` });
    expect(payload.route).toBe(`#/ws/${wsId}@teamchat-api.test/c/${dm}/t/${root}/m/${reply.data.message.seq}`);
    // The direct message's own setting governs its threads; a reply in a channel thread is not a direct message.
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { mute: true });
    await post(alice, wsId, thread, 'quiet');
    expect(received).toHaveLength(1);
    const chRoot = (await post(bob, wsId, general.id, 'in public')).data.message.seq;
    // A reply in a channel thread reaches its followers (bob wrote the root) as a reply.
    await post(alice, wsId, `${general.id}_t${chRoot}`, 'plain reply');
    expect(received).toHaveLength(2);
    expect(JSON.parse(await decrypt(dev, received[1].body)).tag).toBe(`${wsId}@teamchat-api.test:reply-${general.id}_t${chRoot}`);
    // A mention inside a channel thread is tagged by the channel; the deep
    // link still opens the thread.
    const hit = await post(alice, wsId, `${general.id}_t${chRoot}`, '@bob see this');
    expect(received).toHaveLength(3);
    const threadMention = JSON.parse(await decrypt(dev, received[2].body));
    expect(threadMention.tag).toBe(`${wsId}@teamchat-api.test:mention-${general.id}`);
    expect(threadMention.route).toBe(`#/ws/${wsId}@teamchat-api.test/c/${general.id}/t/${chRoot}/m/${hit.data.message.seq}`);
    // A mention inside the direct message's own thread keeps the mention tag
    // even at "all messages": the page's incoming path never announces
    // thread messages, so its mention banner (tagged by the DM) is the one
    // this push must coalesce with.
    await as(bob).put(`/api/ws/${wsId}/conv/${dm}/notify`, { mute: false });
    await post(alice, wsId, thread, '@bob especially');
    expect(received).toHaveLength(4);
    expect(JSON.parse(await decrypt(dev, received[3].body)).tag).toBe(`${wsId}@teamchat-api.test:mention-${dm}`);
  });

  it('caps devices per member', async () => {
    const { wsId } = await workspaceWith(alice, [bob]);
    for (let i = 0; i < 5; i++) expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: (await subscriber()).subscription })).ok).toBe(true);
    expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: (await subscriber()).subscription })).status).toBe(400);
  });
});

describe('client ids', () => {
  it('makes a retried send land once', async () => {
    const { wsId, general } = await workspaceWith(alice, [bob]);
    const send = () => as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'only once', cid: 'c_abcdef123456' });
    const first = await send();
    const again = await send();
    expect(again.data.duplicate).toBe(true);
    expect(again.data.message.seq).toBe(first.data.message.seq);
    const page = await as(bob).get(`/api/ws/${wsId}/conv/${general.id}/messages`);
    expect(page.data.messages.filter((m) => m.text === 'only once')).toHaveLength(1);
    // Different people, same client id: two messages (ids are per sender).
    expect((await as(bob).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'mine', cid: 'c_abcdef123456' })).data.duplicate).toBeUndefined();
    expect((await as(alice).post(`/api/ws/${wsId}/conv/${general.id}/messages`, { text: 'bad id', cid: 'nope!' })).ok).toBe(true);
  });

  it('bounds the stored subscription fields', async () => {
    const { wsId } = await workspaceWith(alice, [bob]);
    const good = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } };
    expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: good })).ok).toBe(true);
    const long = { ...good, endpoint: `https://push.example.com/send/${'x'.repeat(3000)}` };
    expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: long })).status).toBe(400);
    const bigKey = { ...good, keys: { p256dh: 'p'.repeat(5000), auth: 'a'.repeat(22) } };
    expect((await as(bob).post(`/api/ws/${wsId}/push`, { subscription: bigKey })).status).toBe(400);
  });
});
