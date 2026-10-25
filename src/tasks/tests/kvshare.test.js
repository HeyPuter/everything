import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { installMockPuter, createMockPuter } from './helpers/mock-puter.js';

let Store;
let collab;
let alice, bob; // isolated mock accounts with KV shares
let A, B;       // their stores

const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  installMockPuter();
  ({ Store } = await import('../src/lib/store.js'));
  collab = await import('../src/lib/collab.js');
});

async function storeFor(account, deviceId) {
  localStorage.clear(); // the mirror is per-browser; don't leak one into the next
  const s = new Store();
  s.cloud = account.puter;
  s.deviceId = deviceId;
  s.collabDelay = 0;
  await s.init();
  localStorage.clear();
  return s;
}

beforeEach(async () => {
  alice = createMockPuter({ username: 'alice', kvShares: true });
  bob = createMockPuter({ username: 'bob', kvShares: true });
  A = await storeFor(alice, 'dev-A');
  B = await storeFor(bob, 'dev-B');
});

const ownShare = (account) => [...account.shares.values()].filter((s) => s.owner && s.holder === 'bob').at(-1);
const keysUnder = (account, prefix) => [...account.kvMap.keys()].filter((k) => k.startsWith(prefix));

/** Alice shares a list with bob; bob's app discovers it. */
async function share({ name = 'Groceries' } = {}) {
  const list = await A.addList({ name, icon: 'shopping-cart', slot: 3 });
  expect(await A.enableCollab(list.id)).toEqual({ mode: 'kv' });
  await A.inviteMember(list.id, 'bob');
  expect(await B.discoverShares({ force: true })).toBe(1);
  const mine = B.lists.find((l) => l.collab?.mode === 'kv');
  return { list, mine };
}

describe('sharing', () => {
  it('asks for consent, stores the list under its own prefix and shares it at write', async () => {
    const list = await A.addList({ name: 'Groceries' });
    const t = await A.addTask({ listId: list.id, title: 'Milk' });
    await A.enableCollab(list.id);

    expect(alice.puter.perms.requests).toEqual([
      { resource: 'kvShare', details: { prefix: 'tasks:collab:', access: 'write' } },
    ]);
    const { prefix } = A.listById(list.id).collab;
    expect(collab.isKvPrefix(prefix)).toBe(true);
    expect(alice.kvMap.get(`${prefix}meta`)).toMatchObject({ name: 'Groceries', owner: 'alice' });
    expect(alice.kvMap.get(`${prefix}t:${t.id}`)).toMatchObject({ title: 'Milk' });
    expect(alice.kvMap.get(`${prefix}t:${t.id}`).listId).toBeUndefined();

    const { member } = await A.inviteMember(list.id, '@bob');
    expect(member).toMatchObject({ id: 'bob', name: 'bob' });
    const s = ownShare(alice);
    expect(s).toMatchObject({ prefix, access: 'write', label: 'Groceries' });

    const { members } = await A.collabMembers(list.id);
    expect(members.map((m) => m.id)).toEqual(['bob']);
  });

  it('turns invite failures into messages the owner can act on', async () => {
    const list = await A.addList({ name: 'Groceries' });
    await A.enableCollab(list.id);
    await expect(A.inviteMember(list.id, 'nobody')).rejects.toMatchObject({
      message: 'No Puter user is named "nobody"', code: 'subject_does_not_exist',
    });
    await expect(A.inviteMember(list.id, 'bob@example.com')).rejects.toMatchObject({ code: 'invalid_recipient' });
    await expect(A.inviteMember(list.id, 'alice')).rejects.toThrow(/your own account/);
  });

  it('cleans the list name into a valid label', () => {
    expect(collab.shareLabel('  Trip\nplans​ 2027 ')).toBe('Trip plans 2027');
    expect(collab.shareLabel('x'.repeat(200))).toHaveLength(128);
    expect(new TextEncoder().encode(collab.shareLabel('€'.repeat(200))).length).toBeLessThanOrEqual(512);
    expect(collab.shareLabel('\u0007')).toBeNull();
  });
});

describe('discovery', () => {
  it('adopts a shared list without any handshake, once', async () => {
    const list = await A.addList({ name: 'Groceries', icon: 'shopping-cart', slot: 3 });
    await A.addTask({ listId: list.id, title: 'Milk (from alice)' });
    await A.enableCollab(list.id);
    await A.inviteMember(list.id, 'bob');

    let joined = null;
    B.addEventListener('collab-joined', (e) => { joined = e.detail; });
    expect(await B.discoverShares({ force: true })).toBe(1);
    const mine = B.lists.find((l) => l.collab?.mode === 'kv');
    expect(mine).toMatchObject({ name: 'Groceries', icon: 'shopping-cart', slot: 3 });
    expect(mine.collab).toMatchObject({ role: 'member', ownerName: 'alice', approved: true });
    expect(joined).toMatchObject({ listId: mine.id, name: 'Groceries', owner: 'alice' });

    await B.syncCollab();
    expect(B.tasks.some((t) => t.title === 'Milk (from alice)' && t.listId === mine.id)).toBe(true);

    expect(await B.discoverShares({ force: true })).toBe(0);
    expect(B.lists.filter((l) => l.collab?.mode === 'kv')).toHaveLength(1);
  });

  it("lands on the same list on each of the member's devices", async () => {
    const { mine } = await share();
    const B2 = await storeFor(bob, 'dev-B2');
    await B2.discoverShares({ force: true });
    expect(B2.listById(mine.id)?.collab?.handle).toBe(mine.collab.handle);
    expect(B2.lists.filter((l) => l.collab)).toHaveLength(1);
  });

  it('picks up a share made while the app is open from the notification', async () => {
    await B.startCollabWatch();
    const list = await A.addList({ name: 'Live invite' });
    await A.enableCollab(list.id);
    await A.inviteMember(list.id, 'bob');
    await sleep();
    expect(B.lists.some((l) => l.name === 'Live invite' && l.collab?.mode === 'kv')).toBe(true);
  });

  it('ignores hostile meta written by another member', async () => {
    const { list, mine } = await share();
    const { prefix } = A.listById(list.id).collab;
    alice.kvMap.set(`${prefix}meta`, { ...alice.kvMap.get(`${prefix}meta`), icon: 'constructor', slot: 9999 });
    await B.syncCollab();
    expect(B.listById(mine.id)).toMatchObject({ icon: 'list', slot: 8 });

    // The owner's next pass puts its own meta back.
    await A.syncCollab();
    expect(alice.kvMap.get(`${prefix}meta`)).toMatchObject({ icon: 'shopping-cart', slot: 3 });
  });
});

describe('editing through the handle', () => {
  it('flows both ways and converges with the merge rules', async () => {
    const { list, mine } = await share();
    const t1 = await A.addTask({ listId: list.id, title: 'complete me' });
    const t2 = await A.addTask({ listId: list.id, title: 'delete me' });
    await A.syncCollab();
    await B.syncCollab();

    await B.addTask({ listId: mine.id, title: 'Bread (from bob)' });
    await B.completeTask(t1.id);
    await B.deleteTask(t2.id);
    await B.syncCollab();
    await A.syncCollab();

    expect(A.tasks.some((t) => t.title === 'Bread (from bob)' && t.listId === list.id)).toBe(true);
    expect(A.taskById(t1.id).done).toBe(true);
    expect(A.taskById(t2.id)).toBeNull();
    const { prefix } = A.listById(list.id).collab;
    expect(alice.kvMap.has(`${prefix}t:${t2.id}`)).toBe(false);
    expect(alice.kvMap.get(`${prefix}d:${t2.id}`)).toMatchObject({ id: t2.id });
  });

  it('concurrent edits of one task settle on the newer one', async () => {
    const { list } = await share();
    const t = await A.addTask({ listId: list.id, title: 'contested' });
    await A.syncCollab();
    await B.syncCollab();

    await A.updateTask(t.id, { title: 'alice version' });
    await sleep(5);
    await B.updateTask(t.id, { title: 'bob version (newer)' });
    await A.syncCollab();
    await B.syncCollab();
    await A.syncCollab();
    expect(A.taskById(t.id).title).toBe('bob version (newer)');
    expect(B.taskById(t.id).title).toBe('bob version (newer)');
  });

  it("the owner's rename reaches members through meta", async () => {
    const { list, mine } = await share();
    await A.updateList(list.id, { name: 'Groceries & household' });
    await A.syncCollab();
    await B.syncCollab();
    expect(B.listById(mine.id).name).toBe('Groceries & household');
  });

  it('a member cannot delete or hijack tasks outside the shared list', async () => {
    const { list } = await share();
    const priv = await A.addList({ name: 'Private' });
    const secret = await A.addTask({ listId: priv.id, title: 'secret' });
    await A.syncCollab();

    const handle = B.lists.find((l) => l.collab?.mode === 'kv').collab.handle;
    await bob.puter.kv.set(`d:${secret.id}`, { id: secret.id, at: Date.now() + 60000 }, { handle });
    await bob.puter.kv.set(`t:${secret.id}`, { id: secret.id, title: 'hijacked', updatedAt: Date.now() + 60000 }, { handle });
    await A.syncCollab();

    expect(A.taskById(secret.id)).toMatchObject({ title: 'secret', listId: priv.id });
    expect(A.deletedTasks.some((d) => d.id === secret.id)).toBe(false);
    expect(A.tasks.filter((x) => x.id === secret.id)).toHaveLength(1);
    expect(A.listById(list.id).collab).toBeTruthy();
  });

  it('live events bring changes in without waiting for focus', async () => {
    const { list, mine } = await share();
    await A.startCollabWatch();
    await B.startCollabWatch();
    await sleep();

    await A.addTask({ listId: list.id, title: 'pushed live' });
    await A.syncCollab(); // what the debounced post-save sync does
    await sleep(30);
    expect(B.tasks.some((t) => t.title === 'pushed live' && t.listId === mine.id)).toBe(true);

    await B.addTask({ listId: mine.id, title: 'pushed back' });
    await B.syncCollab();
    await sleep(30);
    expect(A.tasks.some((t) => t.title === 'pushed back')).toBe(true);
  });
});

describe('ending access', () => {
  it('revoking a member leaves them a private copy and stops the flow', async () => {
    const { list, mine } = await share();
    await A.addTask({ listId: list.id, title: 'was shared' });
    await A.syncCollab();
    await B.syncCollab();

    await A.removeMember(list.id, 'bob');
    expect(ownShare(alice)).toMatchObject({ revokedBy: 'owner' });
    expect((await A.collabMembers(list.id)).members).toHaveLength(0);

    let ended = null;
    B.addEventListener('collab-ended', (e) => { ended = e.detail; });
    await B.syncCollab();
    const copy = B.listById(mine.id);
    expect(copy.collab).toBeNull();
    expect(copy.pastCollab).toMatchObject({ ownerId: 'alice' });
    expect(B.tasks.some((t) => t.title === 'was shared')).toBe(true);
    expect(ended?.listId).toBe(mine.id);

    // The handle no longer reaches alice's store.
    await B.addTask({ listId: mine.id, title: 'private now' });
    await B.syncCollab();
    await A.syncCollab();
    expect(A.tasks.some((t) => t.title === 'private now')).toBe(false);
    await expect(bob.puter.kv.get('meta', { handle: mine.collab?.handle || ownShare(alice).handle }))
      .rejects.toMatchObject({ code: 'kv_handle_not_found' });
  });

  it('a handle that stops working converts the list to a private copy', async () => {
    const { list, mine } = await share();
    await A.addTask({ listId: list.id, title: 'kept' });
    await A.syncCollab();
    await B.syncCollab();

    await alice.puter.kv.unshare(ownShare(alice).handle); // e.g. revoked from another app
    await B.syncCollab();
    expect(B.listById(mine.id).collab).toBeNull();
    expect(B.tasks.some((t) => t.title === 'kept')).toBe(true);
  });

  it('stopping collaboration revokes everyone and clears the prefix', async () => {
    const { list, mine } = await share();
    const { prefix } = A.listById(list.id).collab;
    await A.disableCollab(list.id);

    expect(ownShare(alice).revokedAt).toBeTruthy();
    expect(keysUnder(alice, prefix)).toEqual([]);
    expect(A.listById(list.id).collab).toBeNull();

    await B.syncCollab();
    expect(B.listById(mine.id).collab).toBeNull();
  });

  it('leaving drops the share and the list without deleting anything for the others', async () => {
    const { list, mine } = await share();
    const t = await A.addTask({ listId: list.id, title: 'stays for alice' });
    await A.syncCollab();
    await B.syncCollab();
    expect(B.taskById(t.id)).toBeTruthy();

    await sleep(5);
    await B.leaveCollab(mine.id);
    expect(B.listById(mine.id)).toBeNull();
    expect(ownShare(alice)).toMatchObject({ revokedBy: 'holder' });

    await A.syncCollab();
    expect(A.taskById(t.id)).toBeTruthy();
    expect(await B.discoverShares({ force: true })).toBe(0);
  });

  it('a leave whose unshare failed is retried, and the share is not re-adopted meanwhile', async () => {
    const { mine } = await share();
    const realUnshare = bob.puter.kv.unshare;
    bob.puter.kv.unshare = async () => { throw { code: 'too_many_requests', message: 'slow down' }; };
    await B.leaveCollab(mine.id);
    expect(ownShare(alice).revokedAt).toBeNull();
    expect(await B.discoverShares({ force: true })).toBe(0);

    bob.puter.kv.unshare = realUnshare;
    await B.syncCollab(); // carries the retry
    expect(ownShare(alice)).toMatchObject({ revokedBy: 'holder' });
  });

  it('a member can be invited back after leaving', async () => {
    const { list, mine } = await share();
    await B.leaveCollab(mine.id);
    await A.inviteMember(list.id, 'bob');
    expect(await B.discoverShares({ force: true })).toBe(1);
    await A.addTask({ listId: list.id, title: 'after the re-invite' });
    await A.syncCollab();
    await B.syncCollab();
    expect(B.tasks.some((t) => t.title === 'after the re-invite')).toBe(true);
  });
});

describe('consent and fallback', () => {
  it('a refused consent shares nothing', async () => {
    alice.puter.perms.consent = false;
    const list = await A.addList({ name: 'Private' });
    await expect(A.enableCollab(list.id)).rejects.toMatchObject({ code: 'consent_denied' });
    expect(A.listById(list.id).collab).toBeNull();
    expect([...alice.kvMap.keys()].some((k) => k.startsWith('tasks:collab:'))).toBe(false);
    expect(alice.fileMap.size).toBe(0); // no fallback to public links either
  });

  it('asks with the permission string on SDKs without the kvShare resource', async () => {
    delete alice.puter.perms.Resource;
    await share();
    expect(alice.puter.perms.requests[0]).toEqual({
      resource: 'permission',
      details: { permission: 'manage:kv-share-write:uuid-alice-' + alice.accountId + ':app-tasks-test:tasks:collab' },
    });
  });

  it('uses linked replicas on an SDK without KV shares', async () => {
    const carol = createMockPuter({ username: 'carol' });
    const C = await storeFor(carol, 'dev-C');
    expect(C.collabMode()).toBe('link');
    const list = await C.addList({ name: 'Old SDK' });
    const res = await C.enableCollab(list.id);
    expect(res.invite).toContain('#/join?m=');
    expect(C.listById(list.id).collab.mode).toBeUndefined();
  });

  it('falls back to an invite link when the deployment turns shares off', async () => {
    const dana = createMockPuter({ username: 'dana', kvShares: true, kvSharesDisabled: true });
    const D = await storeFor(dana, 'dev-D');
    const list = await D.addList({ name: 'No shares here' });
    await D.addTask({ listId: list.id, title: 'via links' });
    await D.enableCollab(list.id);
    const res = await D.inviteMember(list.id, 'bob');

    expect(res.fallback).toBe(true);
    expect(D.collabMode()).toBe('link');
    expect(D.listById(list.id).collab.mode).toBeUndefined();
    expect([...dana.kvMap.keys()].some((k) => k.startsWith('tasks:collab:'))).toBe(false);

    // The link works as before.
    const { confirm } = await B.joinCollab(collab.parseJoinHash('#' + res.invite.split('#')[1]));
    const payload = collab.parseConfirmHash('#' + confirm.split('#')[1]);
    await D.approveMember(payload.listId, payload.member);
    await D.syncCollab();
    await B.syncCollab();
    expect(B.tasks.some((t) => t.title === 'via links')).toBe(true);
  });

  it('a collaboration already on linked replicas keeps working on a KV-capable SDK', async () => {
    const list = await A.addList({ name: 'Started on links' });
    const realShare = alice.puter.kv.share;
    delete alice.puter.kv.share; // an older SDK started it
    const { invite } = await A.enableCollab(list.id);
    alice.puter.kv.share = realShare;

    const { confirm } = await B.joinCollab(collab.parseJoinHash('#' + invite.split('#')[1]));
    const payload = collab.parseConfirmHash('#' + confirm.split('#')[1]);
    await A.approveMember(payload.listId, payload.member);
    await A.addTask({ listId: list.id, title: 'still on links' });
    await A.syncCollab();
    await B.syncCollab();
    expect(B.tasks.some((t) => t.title === 'still on links')).toBe(true);
    expect(A.listById(list.id).collab.manifestUrl).toBeTruthy();
    expect(await A.enableCollab(list.id)).toEqual({ invite });
  });
});
