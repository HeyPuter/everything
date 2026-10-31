// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { install } from '../../worker/app.js';
import { K, P } from '../../worker/keys.js';
import { USERS, WORKER, createHarness, expectError, id } from './harness.js';

async function setup(options) {
  const h = await createHarness(options);
  const space = await h.trip();
  const alice = await h.client('alice');
  return { h, space, alice: alice.in(space), clients: { alice } };
}

describe('link invites', () => {
  it('stores only the token hash and joins with role, member entity and ACL entry', async () => {
    const { h, space, alice } = await setup();
    const { token, invite } = await alice.call('invite.create', { role: 'editor', max: 2 });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(h.kv())).not.toContain(token);
    expect(h.kv()[K.inv(space, invite.id)]).toMatchObject({ role: 'editor', max: 2, by: USERS.alice.uuid });
    const bob = (await h.client('bob')).in(space);
    expect(await bob.call('join.preview', { token })).toMatchObject({ title: 'Lisbon', owner: 'alice', role: 'editor', kind: 'trip' });
    const joined = await bob.call('join', { token });
    expect(joined).toMatchObject({ space, kind: 'trip', role: 'editor', rev: 2, files: { mode: 'direct' } });
    expect(joined.handles).toBeUndefined();
    expect(h.kv()[K.member(space, USERS.bob.uuid)]).toMatchObject({ role: 'editor', username: 'bob', via: 'link' });
    expect(h.kv()[K.entity(space, 'member', USERS.bob.uuid)]).toMatchObject({ name: 'bob', role: 'editor', id: USERS.bob.uuid });
    expect(await bob.call('join', { token })).toMatchObject({ role: 'editor', rev: 2 });
    expect(h.kv()[K.invc(space, invite.id)]).toBe(1);
    const list = await alice.call('invite.list');
    expect(list.invites).toEqual([expect.objectContaining({ id: invite.id, role: 'editor', uses: 1, max: 2 })]);
  });

  it('enforces max uses, expiry and revocation', async () => {
    const { h, alice, space } = await setup();
    const { token } = await alice.call('invite.create', { role: 'viewer', max: 1 });
    await (await h.client('bob')).in(space).call('join', { token });
    await expectError((await h.client('carol')).in(space).call('join', { token }), 404, 'invite_invalid');
    const short = await alice.call('invite.create', { role: 'viewer', exp: h.now() + 60_000 });
    h.advance(61_000);
    await expectError((await h.client('carol')).in(space).call('join.preview', { token: short.token }), 404, 'invite_invalid');
    const revoked = await alice.call('invite.create', { role: 'viewer' });
    await alice.call('invite.revoke', { id: revoked.invite.id });
    await expectError((await h.client('dave')).in(space).call('join', { token: revoked.token }), 404, 'invite_invalid');
    expect((await alice.call('invite.list')).invites).toEqual([]);
  });

  it('says why an invite cannot be used', async () => {
    const { h, alice, space } = await setup();
    const reason = async (promise) => (await expectError(promise, 404, 'invite_invalid')).reason;
    const carol = (await h.client('carol')).in(space);
    const once = await alice.call('invite.create', { role: 'viewer', max: 1 });
    await (await h.client('bob')).in(space).call('join', { token: once.token });
    expect(await reason(carol.call('join.preview', { token: once.token }))).toBe('used');
    const revoked = await alice.call('invite.create', { role: 'viewer' });
    await alice.call('invite.revoke', { id: revoked.invite.id });
    expect(h.kv()[K.inv(space, revoked.invite.id)]).toMatchObject({ revoked: h.now(), role: 'viewer' });
    expect(await reason(carol.call('join', { token: revoked.token }))).toBe('revoked');
    await expectError(alice.call('invite.revoke', { id: revoked.invite.id }), 404, 'not_found');
    const short = await alice.call('invite.create', { role: 'viewer', exp: h.now() + 60_000 });
    h.advance(61_000);
    expect(await reason(carol.call('join.preview', { token: short.token }))).toBe('expired');
    expect(await reason(carol.call('join', { token: 'f'.repeat(32) }))).toBe('invalid');
    h.advance(31 * 86_400_000);
    expect(await reason(carol.call('join.preview', { token: short.token }))).toBe('invalid');
  });

  it('keeps a display label on personal links', async () => {
    const { alice } = await setup();
    const { invite } = await alice.call('invite.create', { role: 'viewer', max: 1, label: '  Maria  ' });
    expect(invite).toMatchObject({ label: 'Maria', max: 1 });
    expect((await alice.call('invite.list')).invites).toEqual([expect.objectContaining({ id: invite.id, label: 'Maria' })]);
    for (const label of ['', '   ', 'x'.repeat(81), 'a\nb', 7]) await expectError(alice.call('invite.create', { role: 'viewer', label }), 400, 'invalid_label');
    await expectError(alice.call('invite.create', { role: 'viewer', label: 'Bob', named: 'bob' }), 400, 'invalid_label');
  });

  it('limits failed joins to 8 per 10 minutes per account', async () => {
    const { h, space } = await setup();
    const dave = (await h.client('dave')).in(space);
    for (let i = 0; i < 8; i++) await expectError(dave.call('join', { token: '0'.repeat(32) }), 404, 'invite_invalid');
    await expectError(dave.call('join.preview', { token: '1'.repeat(32) }), 429, 'rate_limited');
    expect(Object.keys(h.kv()).filter((key) => key.includes(':fail:')).every((key) => /:fail:[^:]+:\d+$/.test(key))).toBe(true);
    h.advance(600_000);
    await expectError(dave.call('join', { token: '2'.repeat(32) }), 404, 'invite_invalid');
  });

  it('stops reading for an account at the failed-join limit', async () => {
    const { h, space } = await setup();
    const dave = (await h.client('dave')).in(space);
    for (let i = 0; i < 8; i++) await expectError(dave.call('join', { token: String(i).padStart(32, '0') }), 404, 'invite_invalid');
    h.world.resetCounters();
    for (let i = 0; i < 10; i++) await expectError(dave.call('join.preview', { token: 'a'.repeat(32) }), 429, 'rate_limited');
    expect(h.world.counters().byUser[USERS.alice.uuid]?.calls['kv.get'] ?? 0).toBe(0);
  });

  it('lets editors with members.manage invite viewers only', async () => {
    const { h, space, alice } = await setup();
    await alice.call('commit', { ops: [{ opId: id('o'), t: 'meta', id: 'meta', set: { perms: { 'members.manage': 'editor' } } }] });
    const { token } = await alice.call('invite.create', { role: 'editor' });
    const bob = (await h.client('bob')).in(space);
    await bob.call('join', { token });
    h.advance(6000);
    await expectError(bob.call('invite.create', { role: 'editor' }), 403, 'forbidden');
    expect((await bob.call('invite.create', { role: 'viewer' })).token).toBeTruthy();
    await expectError(bob.call('invite.create', { role: 'owner' }), 400, 'invalid_role');
    const carol = (await h.client('carol')).in(space);
    await expectError(carol.call('invite.create', { role: 'viewer' }), 403, 'not_member');
  });

  it('caps live invites per space', async () => {
    const { h, space, alice, clients } = await setup();
    const live = { role: 'viewer', exp: h.now() + 86_400_000, max: 1, by: USERS.alice.uuid, created: h.now() };
    await clients.alice.puter.kv.set(K.invs(space), Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i).padStart(64, '0'), live])));
    await expectError(alice.call('invite.create', { role: 'viewer' }), 409, 'invite_limit');
  });

  it('caps invites per member per day with the window in the key', async () => {
    const { h, space, alice, clients } = await setup();
    const day = Math.floor(h.now() / 86_400_000);
    await clients.alice.puter.kv.set(K.rl(space, 'inv', USERS.alice.uuid, day), 50);
    await expectError(alice.call('invite.create', { role: 'viewer' }), 429, 'rate_limited');
    h.advance(86_400_000);
    expect((await alice.call('invite.create', { role: 'viewer' })).token).toBeTruthy();
  });
});

describe('roles and removal', () => {
  it('changes roles below the caller and updates the member entity', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('invite.create', { role: 'editor', max: 5 });
    await (await h.client('bob')).in(space).call('join', { token });
    await (await h.client('carol')).in(space).call('join', { token });
    const changed = await alice.call('member.role', { uuid: USERS.carol.uuid, role: 'viewer' });
    expect(changed.role).toBe('viewer');
    expect(h.kv()[K.entity(space, 'member', USERS.carol.uuid)].role).toBe('viewer');
    const bob = (await h.client('bob')).in(space);
    await expectError(bob.call('member.role', { uuid: USERS.carol.uuid, role: 'editor' }), 403, 'forbidden');
    await expectError(alice.call('member.role', { uuid: USERS.alice.uuid, role: 'viewer' }), 403, 'forbidden');
    h.advance(2000);
    await expectError((await h.client('carol')).in(space).call('commit', { ops: [{ opId: id('o'), t: 'place', id: id('p'), put: { name: 'X' } }] }), 403, 'forbidden');
  });

  it('removes a member everywhere and requires a newer invite to return', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { token } = await alice.call('invite.create', { role: 'editor', max: 5 });
    const bobClient = await h.client('bob');
    const bob = bobClient.in(space);
    const joined = await bob.call('join', { token });
    expect(joined.handles).toEqual({ read: expect.any(String), write: expect.any(String) });
    await bobClient.puter.kv.set('pres', { at: 1, view: 'plan' }, { handle: joined.handles.write });
    expect(h.kv()[`${K.region(space, USERS.bob.uuid)}pres`]).toEqual({ at: 1, view: 'plan' });
    const removed = await alice.call('member.remove', { uuid: USERS.bob.uuid });
    await h.settle();
    expect(removed.removed).toBe(true);
    const record = h.kv()[K.member(space, USERS.bob.uuid)];
    expect(record.removed).toBeGreaterThan(record.joined);
    expect(h.kv()[K.entity(space, 'member', USERS.bob.uuid)]).toMatchObject({ deleted: true });
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toBeUndefined();
    expect(h.kv()[`${K.region(space, USERS.bob.uuid)}pres`]).toBeUndefined();
    await expect(bobClient.puter.kv.get('sig', { handle: joined.handles.read })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
    h.advance(2000);
    await expectError(bob.call('open'), 403, 'not_member');
    await expectError(bob.call('join', { token }), 404, 'invite_invalid');
    h.advance(1000);
    const fresh = await alice.call('invite.create', { role: 'viewer' });
    expect((await bob.call('join', { token: fresh.token })).role).toBe('viewer');
    expect(h.kv()[K.entity(space, 'member', USERS.bob.uuid)]).toMatchObject({ role: 'viewer', name: 'bob' });
  });

  it('revokes grants minted from a stale cache while a removal lands', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const second = 'trips-abcdefghik';
    await h.world.registerWorker(second, { owner: USERS.alice.uuid, setup: ({ router, me }) => install({ router, me, options: { now: h.now } }) });
    const { token } = await alice.call('invite.create', { role: 'editor' });
    const bob = await h.client('bob');
    await bob.in(space).call('join', { token });
    const viaSecond = (op) => bob.api.request(second, JSON.stringify({ op, space }));
    await viaSecond('open');
    await alice.call('member.remove', { uuid: USERS.bob.uuid });
    await h.settle();
    // The second isolate still holds Bob's member record, so it mints fresh grants, then sees the removal.
    const minted = h.world.counters().calls['kv.share'];
    await expectError(viaSecond('open'), 403, 'not_member');
    expect(h.world.counters().calls['kv.share']).toBe(minted + 2);
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toBeUndefined();
    const live = (await (await h.client('alice')).puter.kv.listSharedByMe()).items.filter((item) => item.holder === USERS.bob.uuid && !item.revokedAt);
    expect(live).toEqual([]);
    expect((await bob.puter.fs.listShared()).items).toEqual([]);
  });

  it('retries failed revocations from owner maintenance', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { token } = await alice.call('invite.create', { role: 'editor' });
    const bob = await h.client('bob');
    const { handles } = await bob.in(space).call('join', { token });
    h.world.failNext({ method: 'kv.unshare', as: USERS.alice.uuid, status: 503, code: 'unavailable', times: 2 });
    await alice.call('member.remove', { uuid: USERS.bob.uuid });
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toMatchObject({ revoke: true });
    expect((await bob.puter.kv.get('sig', { handle: handles.read })).rev).toBeGreaterThan(0);
    h.advance(3_600_000);
    await alice.call('open');
    await h.settle();
    await expect(bob.puter.kv.get('sig', { handle: handles.read })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toBeUndefined();
  });

  it('keeps a removal when a role change for the same member races it', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('invite.create', { role: 'editor' });
    await (await h.client('bob')).in(space).call('join', { token });
    await Promise.all([alice.call('member.role', { uuid: USERS.bob.uuid, role: 'viewer' }).catch(() => {}), alice.call('member.remove', { uuid: USERS.bob.uuid })]);
    h.advance(2000);
    await expectError((await h.client('bob')).in(space).call('open'), 403, 'not_member');
  });

  it('lets members leave but not the owner', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const carol = (await h.client('carol')).in(space);
    await carol.call('join', { token });
    await carol.call('leave');
    h.advance(2000);
    await expectError(carol.call('open'), 403, 'not_member');
    await expectError(alice.call('leave'), 409, 'owner_cannot_leave');
    await expectError(alice.call('member.remove', { uuid: USERS.carol.uuid }), 404, 'not_member');
  });
});

describe('handles and named invites (KV shares)', () => {
  it('mints a read handle on shared:<id>: and a write handle on the member region', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const bobClient = await h.client('bob');
    const { handles } = await bobClient.in(space).call('join', { token });
    expect(await bobClient.puter.kv.get('e:meta:meta', { handle: handles.read })).toMatchObject({ title: 'Lisbon' });
    expect((await bobClient.puter.kv.get('sig', { handle: handles.read })).rev).toBe(2);
    const listed = await bobClient.puter.kv.list({ pattern: 'e:*', returnValues: true, limit: 1000, optConfig: { handle: handles.read } });
    expect(listed.items.map((item) => item.key).sort()).toEqual([`e:member:${USERS.alice.uuid}`, `e:member:${USERS.bob.uuid}`, 'e:meta:meta']);
    await expect(bobClient.puter.kv.set('e:meta:meta', {}, { handle: handles.read })).rejects.toMatchObject({ code: 'kv_handle_access_denied' });
    await expect(bobClient.puter.kv.get(`sp:${space}:acl`, { handle: handles.read })).resolves.toBeNull();
    expect((await bobClient.in(space).call('open')).handles).toEqual(handles);
  });

  it('drops handles the member revoked from their record so the next open mints working ones', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const bobClient = await h.client('bob');
    const { handles } = await bobClient.in(space).call('join', { token });
    await bobClient.puter.kv.unshare(handles.read);
    h.advance(3_600_000);
    await alice.call('open');
    await h.settle();
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).not.toHaveProperty('read');
    const reopened = (await bobClient.in(space).call('open')).handles;
    expect(reopened).toEqual({ read: expect.any(String), write: expect.any(String) });
    expect((await bobClient.puter.kv.get('sig', { handle: reopened.read })).rev).toBeGreaterThan(0);
  });

  it('mints missing handles lazily on open once the platform allows it', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const bob = (await h.client('bob')).in(space);
    expect((await bob.call('join', { token })).handles).toBeUndefined();
    h.world.flags.shareHandles = true;
    expect((await bob.call('open')).handles).toBeUndefined();
    h.advance(11 * 60_000);
    expect((await bob.call('open')).handles).toEqual({ read: expect.any(String), write: expect.any(String) });
  });

  it('shares a labelled stub with the invitee, who joins by invite id or declines', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const carolClient = await h.client('carol');
    const notifications = [];
    await carolClient.puter.events.onLocal('notif:trips:app-user', ({ event }) => notifications.push(event.notification));
    const { invite, token } = await alice.call('invite.create', { role: 'editor', named: 'carol' });
    expect(token).toBeUndefined();
    await h.world.flushEvents();
    expect(notifications).toEqual([{ type: 'kv.share.received', handle: expect.stringMatching(/^kvh-/), label: 'Lisbon · from alice', access: 'read', createdAt: Math.floor(h.now() / 1000) }]);
    const shared = await carolClient.puter.kv.listShared();
    const stub = await carolClient.puter.kv.get('info', { handle: shared.items[0].handle });
    expect(stub).toMatchObject({ worker: WORKER, space, kind: 'trip', title: 'Lisbon', ownerName: 'alice', role: 'editor', invite: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const dave = (await h.client('dave')).in(space);
    await expectError(dave.call('join', { invite: stub.invite }), 404, 'invite_invalid');
    const carol = carolClient.in(space);
    expect(await carol.call('join.preview', { invite: stub.invite })).toMatchObject({ role: 'editor', owner: 'alice' });
    expect((await carol.call('join', { invite: stub.invite })).role).toBe('editor');
    await h.settle();
    expect(h.kv()[K.member(space, USERS.carol.uuid)].via).toBe('named');
    expect(h.kv()[K.inv(space, invite.id)]).toBeUndefined();
    expect(h.kv()[K.stub(stub.invite)]).toBeUndefined();
    expect((await carolClient.puter.kv.listShared()).items.map((item) => item.label)).not.toContain('Lisbon · from alice');
    const second = await alice.call('invite.create', { role: 'viewer', named: 'dave' });
    const daveShares = await (await h.client('dave')).puter.kv.listShared();
    const daveStub = await (await h.client('dave')).puter.kv.get('info', { handle: daveShares.items[0].handle });
    await dave.call('invite.decline', { invite: daveStub.invite });
    expect(h.kv()[K.inv(space, second.invite.id)]).toBeUndefined();
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'carol' }), 409, 'already_member');
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'nobody' }), 404, 'user_not_found');
  });

  it('binds a named invite to its holder across a username change', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { invite: created } = await alice.call('invite.create', { role: 'viewer', named: 'Carol' });
    const carolClient = await h.client('carol');
    const [item] = (await carolClient.puter.kv.listShared()).items;
    const { invite } = await carolClient.puter.kv.get('info', { handle: item.handle });
    // Puter resolves the typed name and names the holder by its own spelling.
    expect(h.kv()[K.inv(space, created.id)]).toMatchObject({ named: 'Carol', holder: 'carol', handle: item.handle });
    // As if Carol had renamed since: re-sharing the stub to her uuid answers with its handle, which proves she holds it.
    await (await h.client('alice')).puter.kv.update(K.inv(space, created.id), { holder: 'carol-before' });
    h.world.resetCounters();
    expect((await carolClient.in(space).call('join', { invite })).role).toBe('viewer');
    expect(h.world.counters().byUser[USERS.alice.uuid].calls['kv.share']).toBeGreaterThanOrEqual(1);
    // Someone else holding the secret is refused, and the probe share made for them is taken back.
    const second = await alice.call('invite.create', { role: 'viewer', named: 'bob' });
    const bobClient = await h.client('bob');
    const bobShare = (await bobClient.puter.kv.listShared()).items[0];
    const secret = (await bobClient.puter.kv.get('info', { handle: bobShare.handle })).invite;
    const dave = await h.client('dave');
    await expectError(dave.in(space).call('join', { invite: secret }), 404, 'invite_invalid');
    expect((await dave.puter.kv.listShared()).items).toEqual([]);
    expect(h.kv()[K.inv(space, second.invite.id)]).toMatchObject({ holder: 'bob' });
  });

  it('maps refused stub shares to named-invite errors', async () => {
    const { h, alice } = await setup({ shareHandles: true });
    h.world.configureUser('dave', { refusesShares: true });
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'dave' }), 409, 'recipient_refused');
    h.world.revokeShareConsent('alice');
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'dave' }), 409, 'share_consent_required');
    h.world.grantShareConsent('alice', 'shared:', 'write');
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'alice' }), 400, 'invalid_username');
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'nobody' }), 404, 'user_not_found');
  });

  it('keeps a renamed member\'s read handle during maintenance and drops handles of former members', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    const { token } = await alice.call('invite.create', { role: 'viewer' });
    const bobClient = await h.client('bob');
    const { handles } = await bobClient.in(space).call('join', { token });
    // As if Bob had renamed: the listing names holders by their current username.
    h.world.renameUser('bob', 'robert');
    // A stray share to someone who is not a member.
    const stray = await (await h.client('alice')).puter.kv.share({ prefix: `shared:${space}:`, recipient: 'dave', access: 'read' });
    h.advance(3_600_000);
    await alice.call('open');
    await h.settle();
    expect((await bobClient.puter.kv.get('sig', { handle: handles.read })).rev).toBeGreaterThan(0);
    const listed = (await (await h.client('alice')).puter.kv.listSharedByMe()).items;
    expect(listed.find((item) => item.handle === stray.handle)).toMatchObject({ revokedAt: expect.any(Number), revokedBy: 'owner' });
    expect(listed.find((item) => item.handle === handles.read)).toMatchObject({ holder: 'robert', revokedAt: null });
  });

  it('unshares expired named-invite stubs during owner maintenance', async () => {
    const { h, space, alice } = await setup({ shareHandles: true });
    await alice.call('invite.create', { role: 'viewer', named: 'dave', exp: h.now() + 60_000 });
    const dave = await h.client('dave');
    expect((await dave.puter.kv.listShared()).items).toHaveLength(1);
    h.advance(3_600_000);
    await alice.call('open');
    await h.settle();
    expect((await dave.puter.kv.listShared()).items).toEqual([]);
    expect(h.kv()[K.invs(space)]).toEqual({});
  });

  it('reports named invites as unavailable without KV shares', async () => {
    const { alice } = await setup();
    await expectError(alice.call('invite.create', { role: 'viewer', named: 'bob' }), 409, 'named_invites_unavailable');
  });
});

describe('direct file access at join', () => {
  it('shares files read and the member inbox write when the owner can share', async () => {
    const { h, space, alice } = await setup();
    const { token } = await alice.call('invite.create', { role: 'editor' });
    const bobClient = await h.client('bob');
    const joined = await bobClient.in(space).call('join', { token });
    expect(joined.files).toMatchObject({ mode: 'direct', uid: expect.any(String), inbox: expect.any(String) });
    expect(h.kv()[K.filesMode(space)]).toBe('direct');
    const listed = await bobClient.puter.fs.listShared();
    expect(listed.items.map((item) => item.mode).sort()).toEqual(['read', 'write']);
    const inbox = `/alice/AppData/trips/${P.inboxOf(space, USERS.bob.uuid)}`;
    expect((await bobClient.puter.fs.write(`${inbox}/a.txt`, 'hello')).path).toBe(`${inbox}/a.txt`);
  });

  it('falls back to proxied files when the owner cannot share', async () => {
    const { h, space, alice } = await setup({ ownerVerified: false });
    const { token } = await alice.call('invite.create', { role: 'editor' });
    const joined = await (await h.client('bob')).in(space).call('join', { token });
    expect(joined.files).toEqual({ mode: 'proxied' });
    expect(h.kv()[K.filesMode(space)]).toBe('proxied');
  });
});
