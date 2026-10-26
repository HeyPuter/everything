// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { install } from '../../worker/app.js';
import { K } from '../../worker/keys.js';
import { USERS, createHarness, expectError } from './harness.js';

async function joined(h, space, name, role = 'editor') {
  const alice = (await h.client('alice')).in(space);
  const { token } = await alice.call('invite.create', { role });
  const client = await h.client(name);
  return { client, member: client.in(space), result: await client.in(space).call('join', { token }) };
}

describe('handle renewal (open {renew})', () => {
  it('re-mints handles the member lost and keeps live ones without a write', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const { client, member, result } = await joined(h, space, 'bob');
    const { handles } = result;
    expect((await member.call('open', { renew: true })).handles).toEqual(handles);
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toMatchObject(handles);

    // Giving up the read handle also retires the narrower write handle inside it.
    expect(await client.puter.kv.unshare(handles.read)).toEqual({ handle: handles.read, revokedAt: expect.any(Number) });
    await expect(client.puter.kv.set('u:x', 1, { handle: handles.write })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
    // Without renew the record still names the dead handle.
    expect((await member.call('open')).handles).toEqual(handles);
    const renewed = (await member.call('open', { renew: true })).handles;
    expect(renewed.read).not.toBe(handles.read);
    expect(renewed.write).not.toBe(handles.write);
    expect((await client.puter.kv.get('sig', { handle: renewed.read })).rev).toBeGreaterThan(0);
    expect(h.kv()[K.handles(space, USERS.bob.uuid)]).toMatchObject(renewed);
  });

  it('ignores renew beyond 3 per 10 minutes per member', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const { client, member, result } = await joined(h, space, 'bob');
    for (let i = 0; i < 3; i++) await member.call('open', { renew: true });
    await client.puter.kv.unshare(result.handles.read);
    expect((await member.call('open', { renew: true })).handles.read).toBe(result.handles.read);
    h.advance(10 * 60_000);
    expect((await member.call('open', { renew: true })).handles.read).not.toBe(result.handles.read);
  });

  it('gives the owner no handles and refuses non-members and removed members', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const alice = (await h.client('alice')).in(space);
    expect((await alice.call('open', { renew: true })).handles).toBeUndefined();
    const dave = (await h.client('dave')).in(space);
    await expectError(dave.call('open', { renew: true }), 403, 'not_member');
    const { client, member, result } = await joined(h, space, 'bob');
    await alice.call('member.remove', { uuid: USERS.bob.uuid });
    await expectError(member.call('open', { renew: true }), 403, 'not_member');
    await expect(client.puter.kv.get('sig', { handle: result.handles.read })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
  });

  it('keeps members on path C without the owner\'s kvShare consent, and mints once it is given', async () => {
    const h = await createHarness({ shareHandles: true, shareConsent: false });
    const space = await h.trip();
    const { member, result } = await joined(h, space, 'bob');
    expect(result.handles).toBeUndefined();
    expect(h.world.counters().byUser[USERS.alice.uuid].calls['kv.share']).toBe(1);
    // The refusal backs off for 10 minutes instead of costing a mint on every open.
    expect((await member.call('open', { renew: true })).handles).toBeUndefined();
    expect(h.world.counters().byUser[USERS.alice.uuid].calls['kv.share']).toBe(1);
    h.world.grantShareConsent('alice', 'shared:', 'write');
    h.advance(10 * 60_000);
    const { handles } = await member.call('open', { renew: true });
    expect(handles).toEqual({ read: expect.stringMatching(/^kvh-/), write: expect.stringMatching(/^kvh-/) });
  });

  it('re-shares direct-file folders the member dropped', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const { client, member, result } = await joined(h, space, 'bob');
    expect(result.files).toMatchObject({ mode: 'direct', uid: expect.any(String), inbox: expect.any(String) });
    await client.puter.fs.unshare({ uid: result.files.uid, recipient: 'bob' });
    await expect(client.puter.fs.stat({ uid: result.files.uid })).rejects.toMatchObject({ code: 'permission_denied' });
    expect((await member.call('open', { renew: true })).files).toEqual(result.files);
    expect((await client.puter.fs.stat({ uid: result.files.uid })).is_dir).toBe(true);
  });

  it('costs 2 handle mints, 2 file shares and a membership re-read, plus one record write only when an id changed', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const { client, member } = await joined(h, space, 'bob');
    await member.call('open');
    const owner = () => h.world.counters().byUser[USERS.alice.uuid]?.calls ?? {};
    const kv = (calls) => Object.entries(calls).filter(([method]) => method.startsWith('kv.') && method !== 'kv.share').reduce((n, [, count]) => n + count, 0);
    h.advance(10_000);
    h.world.resetCounters();
    await member.call('open');
    const plain = kv(owner());
    h.world.resetCounters();
    await member.call('open', { renew: true });
    expect(owner()['kv.share']).toBe(2);
    expect(owner()['fs.share']).toBe(2);
    expect(kv(owner())).toBeLessThanOrEqual(plain + 1);
    expect(owner()['kv.set'] ?? 0).toBe(0);
    await client.puter.kv.unshare((await member.call('open')).handles.read);
    h.world.resetCounters();
    await member.call('open', { renew: true });
    expect(kv(owner())).toBeLessThanOrEqual(plain + 2);
    expect(owner()['kv.set']).toBe(1);
  });

  it('takes back folder re-shares made from a stale member cache while a removal lands', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const second = 'trips-abcdefghik';
    await h.world.registerWorker(second, { owner: USERS.alice.uuid, setup: ({ router, me }) => install({ router, me, options: { now: h.now } }) });
    const { client, result } = await joined(h, space, 'bob');
    const viaSecond = (input) => client.api.request(second, JSON.stringify({ op: 'open', space, ...input }));
    await viaSecond({});
    await (await h.client('alice')).in(space).call('member.remove', { uuid: USERS.bob.uuid });
    await h.settle();
    // The record a slow removal has not deleted yet.
    await (await h.client('alice')).puter.kv.set(K.handles(space, USERS.bob.uuid), { files: true, inbox: result.files.inbox });
    await expectError(viaSecond({ renew: true }), 403, 'not_member');
    expect((await client.puter.fs.listShared()).items).toEqual([]);
  });

  it('leaves a viewer without an inbox when renewing', async () => {
    const h = await createHarness({ shareHandles: true });
    const space = await h.trip();
    const { member, result } = await joined(h, space, 'carol', 'viewer');
    expect(result.files).toMatchObject({ mode: 'direct', uid: expect.any(String) });
    expect(result.files.inbox).toBeUndefined();
    expect((await member.call('open', { renew: true })).files.inbox).toBeUndefined();
  });
});
