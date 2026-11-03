// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { calendar } from '../../worker/engine/public.js';
import { project } from '../../worker/engine/projection.js';
import { K } from '../../worker/keys.js';
import { ORIGIN, USERS, createHarness, expectError, id } from './harness.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new TextEncoder().encode('%PDF-1.7\n...');
const anonymous = async (h, path) => (await h.client('dave')).puter.workers.exec(ORIGIN + path, { headers: { 'x-puter-no-auth': '1' } });

async function setup() {
  const h = await createHarness({ ownerVerified: false });
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const alice = (await h.client('alice')).in(space);
  const bob = await h.client('bob');
  const place = id('p');
  const res = id('r');
  const exp = id('e');
  await bob.in(space).call('commit', { ops: [
    { opId: id('o'), t: 'place', id: place, put: { name: 'Belém', rating: { [USERS.bob.uuid]: 5 }, tags: { [USERS.bob.uuid]: ['secret'] } } },
    { opId: id('o'), t: 'res', id: res, put: { type: 'flight', title: 'TP1', status: 'confirmed', code: 'ABC123', legs: [{ from: { code: 'LIS' }, to: { code: 'OPO' }, dep: { date: '2027-05-01' }, arr: { date: '2027-05-01' }, code: 'SEAT9' }] } },
    { opId: id('o'), t: 'exp', id: exp, put: { name: 'Taxi', amount: 1500, currency: 'EUR', payers: [], split: { mode: 'equal', parts: [{ who: USERS.bob.uuid }] } } },
    { opId: id('o'), t: 'msg', id: id('m'), put: { text: 'see you' } },
  ] });
  return { h, space, alice, bob, ids: { place, res, exp } };
}

describe('share links', () => {
  it('returns the token once, keeps only its hash and filters the projection by toggles', async () => {
    const { h, space, alice, ids } = await setup();
    const { token, share } = await alice.call('share.set', { on: true, plan: true, bookings: true });
    expect(share).toMatchObject({ on: true, plan: true, bookings: true });
    expect(JSON.stringify(h.kv())).not.toContain(token);
    expect(h.kv()[K.secrets(space)].shareTokenHash).toMatch(/^[0-9a-f]{64}$/);
    h.advance(121_000);
    const response = await anonymous(h, `/pub/${space}/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const view = await response.json();
    expect(view.meta).toEqual({ title: 'Lisbon', currency: 'EUR', start: '2027-05-01', end: '2027-05-04' });
    expect(view.ents.map((entity) => entity.t).sort()).toEqual(['place', 'res']);
    const place = view.ents.find((entity) => entity.id === ids.place);
    expect(place.rating).toBeUndefined();
    expect(place.tags).toBeUndefined();
    expect(place.by).toBeUndefined();
    const res = view.ents.find((entity) => entity.id === ids.res);
    expect(res.code).toBeUndefined();
    expect(res.legs[0].code).toBeUndefined();
    expect(JSON.stringify(view)).not.toMatch(/shareTokenHash|perms|ABC123|secret/);
    expect(view.members.map((member) => member.name).sort()).toEqual(['A.', 'B.', 'C.']);
  });

  it('rotates, revokes and expires tokens; only share.manage may change them', async () => {
    const { h, space, alice } = await setup();
    const bob = (await h.client('bob')).in(space);
    await expectError(bob.call('share.set', { on: true }), 403, 'forbidden');
    const first = await alice.call('share.set', { on: true, plan: true });
    const second = await alice.call('share.set', { rotate: true });
    expect(second.token).not.toBe(first.token);
    expect((await anonymous(h, `/pub/${space}/${first.token}`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${second.token}`)).status).toBe(200);
    await alice.call('share.set', { exp: h.now() + 60_000 });
    h.advance(61_000);
    expect((await anonymous(h, `/pub/${space}/${second.token}`)).status).toBe(404);
    const third = await alice.call('share.set', { rotate: true, exp: null });
    expect((await anonymous(h, `/pub/${space}/${third.token}`)).status).toBe(200);
    await alice.call('share.set', { revoke: true });
    h.advance(31_000);
    expect((await anonymous(h, `/pub/${space}/${third.token}`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/not-a-token`)).status).toBe(404);
  });

  it('refreshes the projection from a rebuilt snapshot after ten minutes', async () => {
    const { h, space, alice, bob } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true });
    const before = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: id('p'), put: { name: 'Sintra' } }] });
    h.advance(31_000);
    expect((await (await anonymous(h, `/pub/${space}/${token}`)).json()).ents).toHaveLength(before.ents.length);
    h.advance(10 * 60_000);
    await anonymous(h, `/pub/${space}/${token}`);
    await h.settle();
    h.advance(31_000);
    const after = await (await anonymous(h, `/pub/${space}/${token}`)).json();
    expect(after.ents.map((entity) => entity.name)).toContain('Sintra');
  });

  it('costs the owner no reads for guessed tokens once the space is cached', async () => {
    const { h, space, alice } = await setup();
    await alice.call('share.set', { on: true });
    expect((await anonymous(h, `/pub/${space}/${'0'.repeat(32)}`)).status).toBe(404);
    h.world.resetCounters();
    for (let i = 1; i < 20; i++) expect((await anonymous(h, `/pub/${space}/${String(i).padStart(32, '0')}`)).status).toBe(404);
    expect(h.world.counters().byUser[USERS.alice.uuid]?.calls['kv.get'] ?? 0).toBe(0);
  });

  // Hundreds of requests: well under a second alone, past 5 s on a loaded machine.
  it('keeps serving the real link while someone guesses tokens', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true });
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    for (let i = 1; i <= 610; i++) await anonymous(h, `/pub/${space}/${String(i).padStart(32, '0')}`);
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
  }, 30_000);

  it('never serves a cached projection past the share expiry', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, exp: h.now() + 10_000 });
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    h.advance(11_000);
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(404);
  });

  it('applies a share expiry set through a generic commit', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true });
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { 'share.exp': h.now() + 60_000 } }] });
    h.advance(61_000);
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(404);
  });

  it('limits feed token rotation per member', async () => {
    const { h, space } = await setup();
    const carol = (await h.client('carol')).in(space);
    for (let i = 0; i < 10; i++) await carol.call('feed.set', { rotate: true });
    await expectError(carol.call('feed.set', { rotate: true }), 429, 'rate_limited');
  });

  it('rate-limits each token per isolate', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true });
    for (let i = 0; i < 60; i++) expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(429);
  });

  it('serves referenced raster images inline and everything else as a download', async () => {
    const { h, space, alice, bob, ids } = await setup();
    const image = id('f');
    const doc = id('f');
    const loose = id('f');
    for (const [fileId, bytes, name, mime, link] of [[image, PNG, 'pic.png', 'image/png', { t: 'place', id: ids.place }], [doc, PDF, 'ticket.pdf', 'application/pdf', { t: 'res', id: ids.res }], [loose, PNG, 'x.png', 'image/png', { t: 'exp', id: ids.exp }]]) {
      await bob.raw('PUT', `/files/${space}/${fileId}`, { body: bytes, signed: `PUT /files/${space}/${fileId}` });
      await bob.in(space).call('file.put', { fileId, name, mime, sha256: 'b'.repeat(64), kind: 'user' });
      await bob.in(space).call('commit', { ops: [{ opId: id('o'), t: 'file', id: fileId, set: { links: [link] } }] });
    }
    const { token } = await alice.call('share.set', { on: true, plan: true, bookings: true });
    h.advance(121_000);
    // Attachments need the files toggle.
    expect((await anonymous(h, `/pub/${space}/${token}/f/${image}`)).status).toBe(404);
    await alice.call('share.set', { files: true });
    h.advance(121_000);
    const png = await anonymous(h, `/pub/${space}/${token}/f/${image}`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toBeNull();
    const pdf = await anonymous(h, `/pub/${space}/${token}/f/${doc}`);
    expect(pdf.headers.get('content-type')).toBe('application/octet-stream');
    expect(pdf.headers.get('content-disposition')).toBe('attachment; filename="ticket.pdf"');
    expect((await anonymous(h, `/pub/${space}/${token}/f/${loose}`)).status).toBe(404);
  });

  it('projects collections and journeys with their own toggles', () => {
    const snapshot = { rev: 3, at: 1, ents: [
      { t: 'meta', id: 'meta', name: 'Saved', perms: {} },
      { t: 'saved', id: '1', name: 'A', rating: { u: 1 }, status: 'want', order: 'a', by: 'u' },
      { t: 'entry', id: '2', title: 'Day', loc: { lat: 1, lng: 2 } },
    ] };
    expect(project(snapshot, 'collection', { on: true }).ents).toEqual([{ t: 'saved', id: '1', name: 'A', status: 'want', order: 'a' }]);
    expect(project(snapshot, 'journey', { on: true, timeline: true }).ents).toEqual([{ t: 'entry', id: '2', title: 'Day' }]);
    expect(project(snapshot, 'journey', { on: true, timeline: true, map: true }).ents[0].loc).toEqual({ lat: 1, lng: 2 });
  });

  it('strips trip refs from public collection and journey entries', () => {
    const src = { trip: { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' }, placeId: '0000000000000002' };
    const snapshot = { rev: 1, at: 1, ents: [{ t: 'saved', id: '1', name: 'A', src }, { t: 'entry', id: '2', title: 'Day', src }] };
    expect(JSON.stringify(project(snapshot, 'collection', { on: true }))).not.toContain('trips-abcdefghij');
    expect(JSON.stringify(project(snapshot, 'journey', { on: true, timeline: true }))).not.toContain('trips-abcdefghij');
  });
});

describe('share.set and the public route', () => {
  const realUuids = Object.values(USERS).map((user) => user.uuid);

  it('answers 304 for a matching ETag and a new ETag after a toggle change', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true });
    const first = await anonymous(h, `/pub/${space}/${token}`);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get('access-control-expose-headers')).toContain('etag');
    const again = await (await h.client('dave')).puter.workers.exec(`${ORIGIN}/pub/${space}/${token}`, { headers: { 'x-puter-no-auth': '1', 'If-None-Match': `W/${etag}` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    await alice.call('share.set', { bookings: true });
    const changed = await (await h.client('dave')).puter.workers.exec(`${ORIGIN}/pub/${space}/${token}`, { headers: { 'x-puter-no-auth': '1', 'If-None-Match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect((await changed.json()).ents.some((entity) => entity.t === 'res')).toBe(true);
  });

  it('serves repeat views from the isolate cache without owner KV or FS ops', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true });
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    h.world.resetCounters();
    for (let i = 0; i < 10; i++) expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    const calls = h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {};
    expect(Object.entries(calls).filter(([name, count]) => /^(kv|fs)\./.test(name) && count > 0)).toEqual([]);
  });

  it('applies code toggles to the next request on the same isolate', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, bookings: true, codes: true });
    expect(JSON.stringify(await (await anonymous(h, `/pub/${space}/${token}`)).json())).toContain('ABC123');
    await alice.call('share.set', { codes: false });
    expect(JSON.stringify(await (await anonymous(h, `/pub/${space}/${token}`)).json())).not.toContain('ABC123');
  });

  it('never sends member uuids over the public route', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, plan: true, bookings: true, costs: true, chat: true, packing: true, files: true, codes: true });
    const text = await (await anonymous(h, `/pub/${space}/${token}`)).text();
    for (const uuid of realUuids) expect(text).not.toContain(uuid);
    const view = JSON.parse(text);
    expect(view.v).toBe(2);
    expect(view.ents.find((entity) => entity.t === 'exp').split.parts[0].who).toBe(view.members.find((member) => member.name === 'B.').id);
  });

  it('caps browser caching at the link expiry', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('share.set', { on: true, exp: h.now() + 12_000 });
    expect((await anonymous(h, `/pub/${space}/${token}`)).headers.get('cache-control')).toBe('public, max-age=12');
    await alice.call('share.set', { exp: null });
    expect((await anonymous(h, `/pub/${space}/${token}`)).headers.get('cache-control')).toBe('public, max-age=30');
  });

  it('stamps since when a token is minted and stores the display currency', async () => {
    const { h, alice } = await setup();
    const created = await alice.call('share.set', { on: true, costs: true, cur: 'USD' });
    expect(created.share).toMatchObject({ on: true, costs: true, cur: 'USD', since: h.now() });
    h.advance(5000);
    const toggled = await alice.call('share.set', { chat: true, cur: null });
    expect(toggled.token).toBeUndefined();
    expect(toggled.share).toMatchObject({ since: created.share.since, cur: null, chat: true });
    const rotated = await alice.call('share.set', { rotate: true });
    expect(rotated.share.since).toBe(h.now());
  });

  it('mints a new token when a revoked link is turned back on', async () => {
    const { h, space, alice } = await setup();
    const first = await alice.call('share.set', { on: true, plan: true });
    const revoked = await alice.call('share.set', { revoke: true });
    expect(revoked.share.on).toBe(false);
    expect(h.kv()[K.secrets(space)].shareTokenHash).toBeNull();
    const again = await alice.call('share.set', { on: true });
    expect(again.token).toMatch(/^[0-9a-f]{32}$/);
    expect(again.token).not.toBe(first.token);
    expect((await anonymous(h, `/pub/${space}/${first.token}`)).status).toBe(404);
    expect((await anonymous(h, `/pub/${space}/${again.token}`)).status).toBe(200);
  });

  it('validates toggles, currency and expiry', async () => {
    const { h, alice } = await setup();
    await expectError(alice.call('share.set', { plan: 'yes' }), 400, 'invalid_share');
    await expectError(alice.call('share.set', { files: 1 }), 400, 'invalid_share');
    await expectError(alice.call('share.set', { cur: 'usd' }), 400, 'invalid_share');
    await expectError(alice.call('share.set', { exp: h.now() - 1 }), 400, 'invalid_expiry');
    await expectError(alice.call('share.set', { exp: 1.5 }), 400, 'invalid_expiry');
  });

  it('needs share.manage: owner by default, editors when the owner allows it, never viewers or outsiders', async () => {
    const { h, space, alice } = await setup();
    const bob = (await h.client('bob')).in(space);
    const carol = (await h.client('carol')).in(space);
    const dave = (await h.client('dave')).in(space);
    await expectError(bob.call('share.set', { on: true }), 403, 'forbidden');
    await expectError(carol.call('share.set', { on: true }), 403, 'forbidden');
    await expectError(dave.call('share.set', { on: true }), 403);
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { perms: { 'share.manage': 'editor' } } }] });
    h.advance(2000);
    const { token } = await bob.call('share.set', { on: true, plan: true });
    expect((await anonymous(h, `/pub/${space}/${token}`)).status).toBe(200);
    await expectError(carol.call('share.set', { rotate: true }), 403, 'forbidden');
    await expectError(carol.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { 'share.codes': true } }] }), 403);
  });

  it('keeps share toggles out of reach for viewers through generic commits', async () => {
    const { space, h } = await setup();
    const carol = (await h.client('carol')).in(space);
    await expectError(carol.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { 'share.on': true } }] }), 403);
  });
});

describe('ICS feeds', () => {
  it('gives each member a feed token and serves a valid calendar', async () => {
    const { h, space } = await setup();
    const carol = (await h.client('carol')).in(space);
    const feed = await carol.call('feed.set');
    expect(feed.path).toBe(`/ics/${space}/${USERS.carol.uuid}/${feed.token}.ics`);
    expect(await carol.call('feed.set')).toMatchObject({ exists: true });
    const response = await anonymous(h, feed.path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('max-age=900');
    const text = await response.text();
    expect(text).toContain('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n');
    expect(text).toContain('DTSTART;VALUE=DATE:20270501\r\nDTEND;VALUE=DATE:20270505\r\nSUMMARY:Lisbon');
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect((await anonymous(h, `/ics/${space}/${USERS.bob.uuid}/${feed.token}.ics`)).status).toBe(404);
    const rotated = await carol.call('feed.set', { rotate: true });
    expect((await anonymous(h, feed.path)).status).toBe(404);
    expect((await anonymous(h, rotated.path)).status).toBe(200);
    await (await h.client('alice')).in(space).call('member.remove', { uuid: USERS.carol.uuid });
    h.advance(2000);
    expect((await anonymous(h, rotated.path)).status).toBe(404);
  });

  it('keeps serving a checked feed while someone guesses feed paths', async () => {
    const { h, space } = await setup();
    const feed = await (await h.client('carol')).in(space).call('feed.set');
    expect((await anonymous(h, feed.path)).status).toBe(200);
    for (let i = 0; i < 310; i++) await anonymous(h, `/ics/${space}/00000000-0000-4000-8000-${String(i).padStart(12, '0')}/${'0'.repeat(32)}.ics`);
    expect((await anonymous(h, feed.path)).status).toBe(200);
  }, 30_000);

  it('never lets a bare CR or control character into calendar lines', () => {
    const text = calendar('0000000000000001', 'trip', { title: 'Trip\rBEGIN:VALARM\u0007\u000b', start: '2027-01-01' }, 0);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n\u0007\u000b]/);
    expect(text).toContain('X-WR-CALNAME:Trip\\nBEGIN:VALARM\r\n');
  });

  it('escapes and folds calendar text', () => {
    const text = calendar('0000000000000001', 'trip', { title: `A, b; c\\d\n${'é'.repeat(80)}`, start: '2027-01-01' }, 0);
    expect(text).toContain('X-WR-CALNAME:A\\, b\\; c\\\\d\\n');
    expect(text.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(calendar('0000000000000001', 'trip', { title: 'Undated' }, 0)).not.toContain('VEVENT');
  });
});
