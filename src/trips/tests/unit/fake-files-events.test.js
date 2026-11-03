// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
// Alice's app holds the `kvShare` consent on `s:`.
const world = options => { const runtime = createFakePuter({ now: 1_000_000, shareHandles: true, ...options }); runtime.grantShareConsent('alice', 's:', 'write'); return { runtime, a: runtime.client('alice'), b: runtime.client('bob') }; };

describe('filesystem permissions and read credentials', () => {
  it('resolves app-relative paths and uid access while isolating namespaces', async () => {
    const { runtime, a, b } = world(); const file = await a.fs.write('nested/file.txt', 'hello', { createMissingParents: true });
    expect(file.path).toBe('/alice/AppData/trips/nested/file.txt'); expect(file.owner.uuid).toBe('alice');
    expect(await (await a.fs.read(file.uid)).text()).toBe('hello');
    await expect(b.fs.read(file.uid)).rejects.toMatchObject({ status: 403 });
    await expect(runtime.client('alice', 0, { appUid: 'other' }).fs.stat(file.uid)).rejects.toMatchObject({ status: 403 });
    await expect(a.fs.write('../../escape', 'x', { createMissingParents: true })).rejects.toMatchObject({ status: 403 });
  });
  it('grants inherited read access and withdraws it immediately', async () => {
    const { a, b } = world(); const folder = await a.fs.mkdir('files'); const file = await a.fs.write('files/a.txt', 'a');
    expect(await a.fs.share(folder.uid, 'bob', 'read')).toHaveLength(1);
    expect((await b.fs.listShared()).items[0].item.uid).toBe(folder.uid);
    expect((await b.fs.readdir(folder.uid))[0].uid).toBe(file.uid);
    expect(await (await b.fs.read(file.uid)).text()).toBe('a');
    await expect(b.fs.write(file.uid, 'b')).rejects.toMatchObject({ status: 403 });
    expect(await a.fs.unshare(folder.uid, 'bob')).toEqual({ revoked: 1 });
    await expect(b.fs.stat(file.uid)).rejects.toMatchObject({ status: 403 });
  });
  it('charges uploads to the writer and assigns bytes to the shared folder owner', async () => {
    const { runtime, a, b } = world(); const folder = await a.fs.mkdir('inbox'); await a.fs.share(folder.uid, 'bob', 'write'); runtime.resetCounters();
    const file = await b.fs.write(folder.path + '/a.txt', 'content'); expect(file.owner.uuid).toBe('alice');
    expect(runtime.counters().byUser.bob.fsWriteOps).toBe(1); expect(runtime.counters().byUser.alice).toBeUndefined();
    expect(await (await a.fs.read(file.uid)).text()).toBe('content'); await b.fs.delete(file.uid);
    await expect(a.fs.stat(file.uid)).rejects.toMatchObject({ status: 404 });
  });
  it('preserves uids across moves and recursively deletes folders', async () => {
    const { a } = world(); const folder = await a.fs.mkdir('files'); const file = await a.fs.write('files/a', 'a');
    await a.fs.rename(folder.uid, 'renamed'); expect((await a.fs.stat(file.uid)).path).toBe('/alice/AppData/trips/renamed/a');
    await expect(a.fs.delete(folder.uid, { recursive: false })).rejects.toMatchObject({ code: 'directory_not_empty' });
    await a.fs.delete(folder.uid); await expect(a.fs.read(file.uid)).rejects.toMatchObject({ status: 404 });
  });
  it('checks read URLs on use for expiry, grant removal, revocation and deletion', async () => {
    const { runtime, a, b } = world(); const file = await a.fs.write('proof', 'value'); await a.fs.share(file.uid, 'bob', 'read');
    const holderURL = await b.fs.getReadURL(file.uid, '1h'); expect(await (await runtime.readURL(holderURL)).text()).toBe('value');
    await a.fs.unshare(file.uid, 'bob'); await expect(runtime.readURL(holderURL)).rejects.toMatchObject({ status: 403 });
    const expires = await a.fs.getReadURL(file.uid, 1); runtime.advance(1001); await expect(runtime.readURL(expires)).rejects.toMatchObject({ status: 403 });
    const url = await a.fs.getReadURL(file.uid); await a.fs.revokeReadURL(url); await expect(runtime.readURL(url)).rejects.toMatchObject({ status: 403 });
    const deleted = await a.fs.getReadURL(file.uid); await a.fs.delete(file.uid); await expect(runtime.readURL(deleted)).rejects.toMatchObject({ status: 403 });
  });
  it('keeps signed links valid until file deletion', async () => {
    const { runtime, a } = world(); const file = await a.fs.write('a', 'a'); const signed = await a.fs.sign('trips', file.uid);
    runtime.advance(1000 * 86400 * 365); expect(await (await runtime.readURL(signed.items.url)).text()).toBe('a');
    await expect(a.fs.revokeReadURL(signed.token)).rejects.toMatchObject({ status: 403 });
    await a.fs.delete(file.uid); await expect(runtime.readURL(signed.items.url)).rejects.toMatchObject({ status: 403 });
  });
  it('models the verification gate separately from KV sharing', async () => {
    const { runtime, b } = world(); const a = runtime.client({ uuid: 'alice', username: 'alice', verified: false }); const folder = await a.fs.mkdir('f');
    await expect(a.fs.share(folder.uid, 'bob', 'read')).rejects.toMatchObject({ code: 'verification_required' });
    const handle = await a.kv.share('s:', 'bob', 'read'); expect((await b.kv.listShared()).items[0].handle).toBe(handle.handle);
  });
});

describe('local subscriptions', () => {
  it('delivers {event}, relative keys, includeValue, self and viaWorker marking', async () => {
    const { runtime, a, b } = world(); const { handle } = await a.kv.share('s:', 'bob', 'read'); const receive = vi.fn(); const own = vi.fn();
    await b.events.onLocal(`kv:${handle}:*`, receive, { includeValue: true }); await a.events.onLocal('kv:trips:s:*', own);
    await runtime.client('alice', 0, { worker: true }).kv.set('s:x', { n: 1 }); await runtime.flushEvents();
    expect(receive.mock.calls[0][0].event).toMatchObject({ key: 'x', value: { n: 1 }, self: false, viaWorker: true, subject: `kv:${handle}:x` });
    expect(own.mock.calls[0][0].event).toMatchObject({ key: 's:x', self: true, viaWorker: true, seq: 0 }); expect(own.mock.calls[0][0].event).not.toHaveProperty('value');
    await a.kv.set('s:y', 1); await runtime.flushEvents();
    expect(own.mock.calls[1][0].event).toMatchObject({ key: 's:y', self: true, viaWorker: false });
    // A holder's own write through the handle is `self` for the holder and not for the owner.
    const write = await a.kv.share('s:', 'bob', 'write'); expect(write.handle).toBe(handle);
    await b.kv.set('z', 1, { handle }); await runtime.flushEvents();
    expect(receive.mock.calls.at(-1)[0].event).toMatchObject({ key: 'z', self: true, viaWorker: false }); expect(own.mock.calls.at(-1)[0].event).toMatchObject({ key: 's:z', self: false });
  });
  it('omits large/private values and revokes queued deliveries', async () => {
    const { runtime, a, b } = world(); const { handle } = await a.kv.share('s:', 'bob', 'read'); const receive = vi.fn();
    const sub = await b.events.onLocal(`kv:${handle}:*`, receive, { includeValue: true });
    await a.kv.set('s:big', 'a'.repeat(17 * 1024)); await a.kv.set('s:private', 1, { disableSharing: true }); await runtime.flushEvents();
    expect(receive).toHaveBeenCalledOnce(); expect(receive.mock.calls[0][0].event).not.toHaveProperty('value');
    await a.kv.unshare(handle); await a.kv.set('s:new', 1); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce(); await sub.off();
    // A stopped, unknown or foreign handle reads like a subject that does not exist; a handle needs a key.
    await expect(b.events.onLocal(`kv:${handle}:*`, receive)).rejects.toMatchObject({ code: 'subject_does_not_exist', status: 404 });
    const live = await a.kv.share('s:', 'bob', 'read');
    await expect(runtime.client('carol').events.onLocal(`kv:${live.handle}:*`, receive)).rejects.toMatchObject({ code: 'subject_does_not_exist' });
    await expect(b.events.onLocal(`kv:${live.handle}`, receive)).rejects.toMatchObject({ code: 'invalid_kv_handle_key' });
    await expect(b.events.onLocal(`kv:${live.handle}:a*b`, receive)).rejects.toMatchObject({ code: 'invalid_kv_pattern' });
  });
  it('lets watch-only holders subscribe but prevents reads', async () => {
    const { runtime, a, b } = world(); const { handle } = await a.kv.share('s:', 'bob', 'watch'); const receive = vi.fn();
    await b.events.onLocal(`kv:${handle}:x`, receive, { includeValue: true }); await expect(b.kv.get('x', { handle })).rejects.toMatchObject({ status: 403 });
    await a.kv.set('s:x', 1); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce();
  });
  it('delivers cross-region events and reconnect gaps while offline changes are missed', async () => {
    const { runtime, a } = world({ regions: 2 }); const receive = vi.fn(); await runtime.client('alice', 1).events.onLocal('kv:trips:*', receive);
    await a.kv.set('k', 1); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce();
    runtime.setOffline('alice'); runtime.setOffline('alice', false); await runtime.flushEvents(); expect(receive.mock.calls[1][0].event).toMatchObject({ op: 'gap', reason: 'reconnect' });
  });
  it('delivers shared FS events and stops after unshare or unsubscribe', async () => {
    const { runtime, a, b } = world(); const folder = await a.fs.mkdir('files'); await a.fs.share(folder.uid, 'bob', 'read'); const receive = vi.fn();
    const sub = await b.events.onLocal(`fs:${folder.path}/**:add`, receive); const file = await a.fs.write('files/a', 'a'); await runtime.flushEvents();
    expect(receive.mock.calls[0][0].event).toMatchObject({ uid: file.uid, op: 'add', self: false });
    await sub.off(); await a.fs.write('files/b', 'b'); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce();
    await a.fs.unshare(folder.uid, 'bob'); await expect(b.events.onLocal(`fs:${folder.path}`, receive)).rejects.toMatchObject({ status: 403 });
  });
});

describe('credential and event limits', () => {
  it('rate-limits minting read URLs per user and expires the window', async () => {
    const { runtime, a } = world(); const file = await a.fs.write('proof', 'x');
    for (let i = 0; i < 20; i++) await a.fs.getReadURL(file.uid);
    await expect(a.fs.getReadURL(file.uid)).rejects.toMatchObject({ status: 429 });
    runtime.advance(3_600_001); expect(await a.fs.getReadURL(file.uid)).toContain('/token-read?');
  });
  it('emits TTL events without includeValue and delivers share notifications', async () => {
    const { runtime, a, b } = world(); const receive = vi.fn(); const notif = vi.fn();
    await a.events.onLocal('kv:trips:k', receive, { includeValue: true }); await b.events.onLocal('notif:app-user', notif);
    await a.kv.set('k', 1); await a.kv.expire('k', 1); await a.kv.share('s:', 'bob', 'read'); await runtime.flushEvents();
    expect(receive.mock.calls[1][0].event).toMatchObject({ op: 'expire' }); expect(receive.mock.calls[1][0].event).not.toHaveProperty('value');
    expect(notif.mock.calls[0][0].event.notification.type).toBe('kv.share.received');
  });
});

it('allows overwriting a directly write-shared file without granting its parent', async () => {
  const { a, b } = world(); const file = await a.fs.write('private-parent/file', 'first', { createMissingParents: true });
  await a.fs.share(file.uid, 'bob', 'write');
  await b.fs.write(file.uid, 'second'); expect(await (await a.fs.read(file.uid)).text()).toBe('second');
  await expect(b.fs.write('/alice/AppData/trips/private-parent/other', 'x')).rejects.toMatchObject({ status: 403 });
});
it('refuses moving directories into descendants without changing any path', async () => {
  const { a } = world(); const parent = await a.fs.mkdir('parent'); const child = await a.fs.mkdir('parent/child'); const file = await a.fs.write('parent/child/file', 'x');
  await expect(a.fs.move(parent.uid, child.uid)).rejects.toMatchObject({ code: 'invalid_request' });
  expect((await a.fs.stat(parent.uid)).path).toBe(parent.path); expect((await a.fs.stat(child.uid)).path).toBe(child.path); expect((await a.fs.stat(file.uid)).path).toBe(file.path);
});

it('prevents a different client from removing a subscription by id', async () => {
  const { runtime, a, b } = world(); const receive = vi.fn(); const sub = await a.events.onLocal('kv:trips:k', receive);
  await expect(b.events.unsubscribe(sub.subId)).rejects.toMatchObject({ status: 403 });
  await a.kv.set('k', 1); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce();
  await a.events.unsubscribe(sub.subId); await a.kv.set('k', 2); await runtime.flushEvents(); expect(receive).toHaveBeenCalledOnce();
  expect(runtime.counters().calls['events.unsubscribe']).toBe(2);
});
it('shares readURL mint limits across app namespaces', async () => {
  const { runtime, a } = world(); const other = runtime.client('alice', 0, { appUid: 'other' });
  const file = await a.fs.write('proof', 'x'); const second = await other.fs.write('proof', 'x');
  for (let i = 0; i < 20; i++) await a.fs.getReadURL(file.uid);
  await expect(other.fs.getReadURL(second.uid)).rejects.toMatchObject({ status: 429 });
});
it('delivers handle events to the handle owner as well as its holder', async () => {
  const { runtime, a } = world(); const { handle } = await a.kv.share('s:', 'bob', 'read'); const receive = vi.fn();
  await a.events.onLocal(`kv:${handle}:*`, receive, { includeValue: true });
  await a.kv.set('s:k', 1); await runtime.flushEvents(); expect(receive.mock.calls[0][0].event).toMatchObject({ key: 'k', value: 1, self: true });
});
it('allows paid accounts to share files without separate phone/card verification', async () => {
  const { runtime, b } = world(); const paid = runtime.client({ uuid: 'alice', username: 'alice', verified: false, paid: true }); const file = await paid.fs.write('file', 'x');
  await paid.fs.share(file.uid, 'bob', 'read'); expect(await (await b.fs.read(file.uid)).text()).toBe('x');
});
