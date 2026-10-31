import { describe, expect, it } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createVacayStore } from '../../src/lib/vacay/store.js';
import { createVacaySharing } from '../../src/lib/vacay/share.js';
import { deleteVacayData } from '../../src/lib/vacay/data.js';
import { handleHash } from '../../src/lib/vacay/keys.js';
import { personalKeys, readPersonal } from '../../src/lib/io/data-export.js';

const USERS = {
  alice: { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' },
  bob: { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' },
  carol: { uuid: '00000000-0000-4000-8000-000000000003', username: 'carol' },
  dave: { uuid: '00000000-0000-4000-8000-000000000004', username: 'dave' },
};
const RANGE = { start: '2026-01-01', end: '2026-12-31' };

async function world(options = {}) {
  const fake = createFakePuter({ shareHandles: true, users: Object.values(USERS), ...options });
  const open = async (name, extra = {}) => {
    const puter = fake.client(USERS[name].uuid);
    const store = createVacayStore({ puter, locale: 'de-DE' });
    await store.load();
    const sharing = createVacaySharing({ puter, store, account: USERS[name], label: (who) => `Vacay from ${who}`, ...extra });
    return { puter, store, sharing };
  };
  return { fake, open };
}

describe('vacay store', () => {
  it('writes the plan on first use and indexes every key it writes', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    expect(alice.store.state.plan).toMatchObject({ yearType: 'calendar', holidays: { country: 'DE' } });
    await alice.store.setEntry('2026-07-01', { fraction: 0.5, kind: 'vacation', note: 'Dentist' });
    await alice.store.setCompany('2026-12-24', {});
    await alice.store.setAllowance(2026, { days: 28 });
    const kv = fake.inspectKv(USERS.alice.uuid);
    expect(kv['vacay:e:2026-07-01']).toEqual({ fraction: 0.5, kind: 'vacation', note: 'Dentist' });
    expect(Object.keys(kv['vacay:idx'].e)).toEqual(['2026-07-01']);
    expect(kv['vacay:idx'].allow).toHaveProperty('2026');
    await alice.store.setEntry('2026-07-01', null);
    expect(fake.inspectKv(USERS.alice.uuid)['vacay:e:2026-07-01']).toBeUndefined();
    expect(fake.inspectKv(USERS.alice.uuid)['vacay:idx'].e).toEqual({});
    const again = await open('alice');
    expect(again.store.state.company.has('2026-12-24')).toBe(true);
    expect(again.store.state.allowances.get(2026)).toEqual({ days: 28 });
  });

  it('coalesces rapid writes and reverts to the cloud value when a write fails', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    const first = alice.store.setEntry('2026-03-02', { fraction: 1, kind: 'vacation' });
    const second = alice.store.setEntry('2026-03-02', { fraction: 0.5, kind: 'comp' });
    await Promise.all([first, second]);
    expect(fake.inspectKv(USERS.alice.uuid)['vacay:e:2026-03-02']).toEqual({ fraction: 0.5, kind: 'comp' });
    fake.failNext({ method: 'kv.update', as: USERS.alice.uuid, code: 'insufficient_funds', status: 402 });
    await expect(alice.store.setEntry('2026-03-03', { fraction: 1, kind: 'vacation' })).rejects.toMatchObject({ status: 402 });
    expect(alice.store.state.entries.has('2026-03-03')).toBe(false);
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    const [hash, grant] = Object.entries(alice.store.state.grants)[0];
    fake.failNext({ method: 'kv.update', as: USERS.alice.uuid, code: 'offline', status: 0 });
    await expect(alice.store.setGrant(hash, { ...grant, name: 'robert' })).rejects.toMatchObject({ code: 'offline' });
    expect(alice.store.state.grants[hash]).toEqual(grant);
  });

  it('exports and deletes everything the index names', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    await alice.store.setEntry('2026-07-01', { fraction: 1, kind: 'vacation' });
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    const personal = await readPersonal(alice.puter);
    expect(personal['vacay:e:2026-07-01']).toEqual({ fraction: 1, kind: 'vacation' });
    expect(Object.keys(personal).filter((key) => key.startsWith('vacay:inv:'))).toHaveLength(1);
    expect(personalKeys({})).toEqual(expect.arrayContaining(['vacay:plan', 'vacay:idx']));
    await deleteVacayData(alice.puter);
    expect(Object.keys(fake.inspectKv(USERS.alice.uuid)).filter((key) => key.startsWith('vacay:'))).toEqual([]);
    expect((await alice.puter.kv.listSharedByMe()).items.every((item) => item.revokedAt)).toBe(true);
  });
});

describe('vacay sharing', () => {
  it('shares read-only: the holder discovers, accepts, reads its overlay and pays for the reads', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    await alice.store.setEntry('2026-08-10', { fraction: 1, kind: 'vacation', note: 'Beach' });
    await alice.store.setEntry('2027-01-04', { fraction: 1, kind: 'vacation' });
    const bob = await open('bob');
    const notified = [];
    await bob.sharing.watchInvites(() => notified.push(1));
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    await fake.flushEvents();
    expect(notified).toHaveLength(1);
    await bob.sharing.discover();
    const [invite] = bob.sharing.state.incoming.values();
    expect(invite).toMatchObject({ mode: 'view', name: 'alice', uid: USERS.alice.uuid, complete: true });
    await bob.sharing.accept(invite.h);
    const peer = bob.sharing.state.peers.get(invite.h);
    fake.resetCounters();
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.status).toBe('ok');
    expect([...peer.entries.keys()]).toEqual(['2026-08-10']);
    expect(peer.verified).toBe(null);
    const counters = fake.counters();
    expect(counters.byUser[USERS.bob.uuid].kvReadUnits).toBeGreaterThan(0);
    expect(counters.byUser[USERS.alice.uuid]).toBeUndefined();
    // Private records never reach holders.
    expect(await bob.puter.kv.get(['shares', 'grants'], { handle: peer.handle })).toEqual([null, null]);
    await expect(bob.puter.kv.set('e:2026-08-11', { fraction: 1, kind: 'vacation' }, { handle: peer.handle })).rejects.toMatchObject({ code: 'kv_handle_access_denied' });
  });

  it('delivers live updates through the handle subscription', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    const bob = await open('bob');
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    await bob.sharing.discover();
    const peer = await bob.sharing.accept([...bob.sharing.state.incoming.keys()][0]);
    await bob.sharing.loadPeer(peer, RANGE);
    await bob.sharing.watchPeer(peer, () => RANGE);
    const changes = [];
    bob.sharing.subscribe((change) => changes.push(change));
    await alice.store.setEntry('2026-09-01', { fraction: 0.5, kind: 'vacation' });
    await fake.flushEvents();
    expect(peer.entries.get('2026-09-01')).toEqual({ fraction: 0.5, kind: 'vacation' });
    expect(changes.some((change) => change.live)).toBe(true);
    await alice.store.setEntry('2026-09-01', null);
    await fake.flushEvents();
    expect(peer.entries.has('2026-09-01')).toBe(false);
  });

  it('fuses in both directions, confirms both sides and dissolves from either', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    const carol = await open('carol');
    await alice.sharing.invite({ username: 'carol', mode: 'fused' });
    await carol.sharing.discover();
    const [invite] = carol.sharing.state.incoming.values();
    expect(invite.mode).toBe('fused');
    await carol.sharing.accept(invite.h);
    await alice.sharing.discover();
    expect(alice.sharing.state.incoming.size).toBe(0);
    const alicePeer = [...alice.sharing.state.peers.values()][0];
    const carolPeer = carol.sharing.state.peers.get(invite.h);
    await alice.sharing.loadPeer(alicePeer, RANGE);
    await carol.sharing.loadPeer(carolPeer, RANGE);
    expect(alicePeer).toMatchObject({ mode: 'fused', uid: USERS.carol.uuid, name: 'carol', verified: 'yes' });
    // Puter names the holder by username; the uuid was learned when Carol's acked reply linked the grant.
    expect(Object.values(alice.store.state.grants)).toEqual([expect.objectContaining({ holder: 'carol', uid: USERS.carol.uuid, mode: 'fused' })]);
    expect(carolPeer).toMatchObject({ mode: 'fused', uid: USERS.alice.uuid, verified: 'yes' });

    await carol.sharing.leave(invite.h);
    expect(Object.keys(carol.store.state.grants)).toEqual([]);
    const gone = [];
    alice.sharing.subscribe((change) => { if (change.type === 'gone') gone.push(change.name); });
    await alice.sharing.loadPeer(alicePeer, RANGE);
    expect(gone).toEqual(['carol']);
    expect(alice.sharing.state.peers.size).toBe(0);
    expect(Object.keys(alice.store.state.grants)).toEqual([]);
    expect(Object.keys(fake.inspectKv(USERS.alice.uuid)).filter((key) => key.startsWith('vacay:inv:'))).toEqual([]);
    expect((await alice.puter.kv.listSharedByMe()).items.every((item) => item.revokedAt)).toBe(true);
  });

  it('never confirms a fused invite that claims someone else', async () => {
    const { open } = await world();
    const dave = await open('dave');
    const bob = await open('bob');
    const alice = await open('alice');
    // Dave shares with Bob pretending to be Alice.
    await dave.puter.perms.request('kvShare', { prefix: 'vacay:', access: 'read' });
    const share = await dave.puter.kv.share({ prefix: 'vacay:', recipient: 'bob', access: 'read', label: 'Vacay from alice' });
    const hash = await handleHash(share.handle);
    await dave.store.setInvite(hash, { mode: 'fused', name: 'alice', uid: USERS.alice.uuid, at: 1 });
    await bob.sharing.discover();
    const invite = bob.sharing.state.incoming.get(hash);
    expect(invite).toMatchObject({ name: 'alice', mode: 'fused' });
    await bob.sharing.accept(hash);
    const peer = bob.sharing.state.peers.get(hash);
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.verified).toBe('pending');
    // The real Alice gets Bob's share back but never auto-links it: she invited no one.
    await alice.sharing.discover();
    expect([...alice.sharing.state.incoming.values()]).toMatchObject([{ mode: 'fused', uid: USERS.bob.uuid }]);
    expect(alice.sharing.state.peers.size).toBe(0);
  });

  it('cleans up grants the holder declined and shares the owner revoked', async () => {
    const { open } = await world();
    const alice = await open('alice');
    const bob = await open('bob');
    const carol = await open('carol');
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    await alice.sharing.invite({ username: 'carol', mode: 'view' });
    await bob.sharing.discover();
    await bob.sharing.decline([...bob.sharing.state.incoming.keys()][0]);
    expect(await alice.sharing.reconcile()).toEqual([{ type: 'left', name: 'bob' }]);
    expect(Object.values(alice.store.state.grants).map((grant) => grant.name)).toEqual(['carol']);
    await carol.sharing.discover();
    const peer = await carol.sharing.accept([...carol.sharing.state.incoming.keys()][0]);
    await alice.sharing.revoke(Object.keys(alice.store.state.grants)[0]);
    await carol.sharing.loadPeer(peer, RANGE);
    expect(carol.sharing.state.peers.size).toBe(0);
    expect(carol.store.state.shares).toEqual({});
  });

  it('maps invite errors and handle failures', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    await expect(alice.sharing.invite({ username: 'nobody', mode: 'view' })).rejects.toMatchObject({ code: 'noUser' });
    await expect(alice.sharing.invite({ username: 'bob@example.com', mode: 'view' })).rejects.toMatchObject({ code: 'recipient' });
    await expect(alice.sharing.invite({ username: 'alice', mode: 'view' })).rejects.toMatchObject({ code: 'self' });
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    await expect(alice.sharing.invite({ username: 'bob', mode: 'view' })).rejects.toMatchObject({ code: 'already' });

    const bob = await open('bob');
    await bob.sharing.discover();
    const peer = await bob.sharing.accept([...bob.sharing.state.incoming.keys()][0]);
    await alice.puter.kv.share({ prefix: 'vacay:', recipient: 'bob', access: 'watch' });
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.status).toBe('denied');
    await alice.puter.kv.share({ prefix: 'vacay:', recipient: 'bob', access: 'read' });
    fake.failNext({ method: 'kv.get', as: USERS.bob.uuid, code: 'insufficient_funds', status: 402 });
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.status).toBe('credit');
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.status).toBe('ok');

    fake.flags.shareHandles = false;
    await bob.sharing.loadPeer(peer, RANGE);
    expect(bob.sharing.state.available).toBe(false);
    await expect(alice.sharing.invite({ username: 'carol', mode: 'view' })).rejects.toMatchObject({ code: 'disabled' });
  });

  it('asks for the kvShare consent before sharing and maps the platform refusals', async () => {
    const { fake, open } = await world();
    const alice = await open('alice');
    fake.denyPermissions(USERS.alice.uuid);
    await expect(alice.sharing.invite({ username: 'bob', mode: 'view' })).rejects.toMatchObject({ code: 'consent' });
    fake.denyPermissions(USERS.alice.uuid, false);
    fake.configureUser(USERS.bob.uuid, { refusesShares: true });
    await expect(alice.sharing.invite({ username: 'bob', mode: 'view' })).rejects.toMatchObject({ code: 'refused' });
    const carol = await open('carol');
    let told = 0;
    await carol.sharing.watchInvites(() => { told += 1; });
    await alice.sharing.invite({ username: 'carol', mode: 'view' });
    await fake.flushEvents();
    expect(told).toBe(1);
    expect(Object.values(alice.store.state.grants)).toEqual([expect.objectContaining({ holder: 'carol', mode: 'view' })]);
    expect(Object.values(alice.store.state.grants)[0].uid).toBeUndefined();
    // A withdrawn consent stops the owner revoking; the holder can still leave.
    fake.revokeShareConsent(USERS.alice.uuid);
    await expect(alice.sharing.revoke(Object.keys(alice.store.state.grants)[0])).rejects.toMatchObject({ code: 'consent' });
  });

  it('upgrades a read-only share to planning together', async () => {
    const { open } = await world();
    const alice = await open('alice');
    const bob = await open('bob');
    await alice.sharing.invite({ username: 'bob', mode: 'view' });
    await bob.sharing.discover();
    const peer = await bob.sharing.accept([...bob.sharing.state.incoming.keys()][0]);
    await alice.sharing.upgrade(Object.keys(alice.store.state.grants)[0]);
    await bob.sharing.loadPeer(peer, RANGE);
    expect(peer.upgrade).toBe(true);
    await bob.sharing.accept(peer.h);
    await alice.sharing.discover();
    const alicePeer = [...alice.sharing.state.peers.values()][0];
    await alice.sharing.loadPeer(alicePeer, RANGE);
    await bob.sharing.loadPeer(bob.sharing.state.peers.get(peer.h), RANGE);
    expect(alicePeer.verified).toBe('yes');
    expect(bob.sharing.state.peers.get(peer.h)).toMatchObject({ mode: 'fused', verified: 'yes' });
  });
});
