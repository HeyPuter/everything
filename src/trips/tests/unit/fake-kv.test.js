// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
const world = options => { const runtime = createFakePuter({ now: 1_000_000, ...options }); return { runtime, a: runtime.client('alice'), b: runtime.client('bob') }; };

describe('SDK argument and document semantics', () => {
  it('isolates user and app namespaces and clones JSON', async () => {
    const { runtime, a, b } = world(); const input = { x: 1 };
    await a.kv.set('k', input); input.x = 3; const output = await a.kv.get({ key: 'k' }); output.x = 2;
    expect(await a.kv.get('k')).toEqual({ x: 1 }); expect(await b.kv.get('k')).toBeNull();
    expect(await runtime.client('alice', 0, { appUid: 'other' }).kv.get('k')).toBeNull();
    await expect(a.kv.get('k', { appUuid: 'other' })).rejects.toMatchObject({ status: 403 });
  });
  it('supports object/batch sets and ordered batch gets', async () => {
    const { a } = world(); await a.kv.set([{ key: 'a', value: 1 }, { key: 5, value: 2 }]);
    await a.kv.set({ items: [{ key: 'b', value: 3 }] });
    expect(await a.kv.get(['a', 'missing', '5', 'b'])).toEqual([1, null, 2, 3]);
    expect(await a.kv.get({ key: ['b', 'a'] })).toEqual([3, 1]);
  });
  it('preserves positional list quirk and prefix normalization', async () => {
    const { a } = world(); await a.kv.set([{ key: 'p:a', value: 1 }, { key: 'p:b', value: 2 }]);
    expect(await a.kv.list('p:*', { returnValues: true })).toEqual(['p:a', 'p:b']);
    expect(await a.kv.list(' p: ', true)).toEqual([{ key: 'p:a', value: 1 }, { key: 'p:b', value: 2 }]);
    expect(await a.kv.list({ pattern: 'p:*', returnValues: true })).toEqual(await a.kv.list(true));
  });
  it('paginates and streams reverse listings', async () => {
    const { a } = world(); await a.kv.set(['a', 'b', 'c'].map(key => ({ key, value: key })));
    const page = await a.kv.list({ limit: 2, reverse: true, includeTotal: true });
    expect(page).toEqual({ items: ['c', 'b'], cursor: 'b', total: 3 });
    expect(await a.kv.list({ limit: 2, reverse: true, cursor: page.cursor })).toEqual({ items: ['a'], cursor: null });
    const pages = []; for await (const p of a.kv.list({ stream: true, limit: 2 })) pages.push(p.items);
    expect(pages).toEqual([['a', 'b'], ['c']]);
    await expect(a.kv.list({ stream: true, offset: 0 }).next()).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(a.kv.list({ reverse: 'yes' })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('suppresses success callbacks and invokes error callbacks', async () => {
    const { a } = world(); const success = vi.fn(); const failure = vi.fn();
    await a.kv.set('k', 1, success); expect(success).not.toHaveBeenCalled();
    await expect(a.kv.get(undefined, success, failure)).rejects.toMatchObject({ code: 'key_undefined' }); expect(failure).toHaveBeenCalledOnce();
  });
  it('creates missing parents and addresses bracket paths atomically', async () => {
    const { a } = world();
    expect(await a.kv.update('k', { 'nested.title': 'a', rows: [{ n: 1 }], '["literal.dot"]': 2 })).toEqual({ nested: { title: 'a' }, rows: [{ n: 1 }], 'literal.dot': 2 });
    expect(await a.kv.update({ key: 'k', pathAndValueMap: { 'rows[0].n': 2 } })).toMatchObject({ rows: [{ n: 2 }] });
    for (const paths of [{ 'rows[1].n': 3 }, { 'nested.title.x': 1 }]) await expect(a.kv.update('k', paths)).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(a.kv.update('k', { a: 1, 'a.b': 2 })).rejects.toMatchObject({ code: 'bad_request' });
    expect(await a.kv.get('k')).toMatchObject({ nested: { title: 'a' } });
  });
  it('increments strict numbers and treats a misplaced handle as a path map', async () => {
    const { a } = world(); expect(await a.kv.incr('n')).toBe(1);
    expect(await a.kv.decr({ key: 'n', pathAndAmountMap: { '': 3 } })).toBe(-2);
    expect(await a.kv.incr('obj', { 'counts.x': 2 })).toEqual({ counts: { x: 2 } });
    await a.kv.set('n', '1'); await expect(a.kv.incr('n')).rejects.toMatchObject({ code: 'value_not_a_number' });
    await expect(a.kv.incr('obj', { handle: 'wrong-slot' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.kv.incr()).rejects.toMatchObject({ code: 'arguments_required' });
  });
  it('appends lists/scalars, creates missing lists and refuses numbers', async () => {
    const { a } = world(); expect(await a.kv.add('list')).toEqual([1]);
    expect(await a.kv.add('list', [2, { x: 3 }])).toEqual([1, 2, { x: 3 }]);
    expect(await a.kv.add('map', { 'rows.items': ['x'] })).toEqual({ rows: { items: ['x'] } });
    await a.kv.set('n', 1); await expect(a.kv.add('n', 2)).rejects.toMatchObject({ code: 'value_not_a_list' });
  });
  it('removes separate paths, array elements and root', async () => {
    const { a } = world(); await a.kv.set('k', { a: 1, b: 2, rows: ['a', 'b'] });
    expect(await a.kv.remove('k', 'a', 'rows[0]')).toEqual({ b: 2, rows: ['b'] });
    await expect(a.kv.remove('k', ['b'])).rejects.toMatchObject({ code: 'paths_invalid' });
    await expect(a.kv.remove('k')).rejects.toMatchObject({ code: 'arguments_required' });
    expect(await a.kv.remove('k', '')).toBeNull(); expect(await a.kv.get('k')).toBeNull();
  });
  it('preserves, clears and resets TTLs', async () => {
    const { runtime, a } = world(); await a.kv.set('k', { a: 1 }, 1002); await a.kv.update('k', { a: 2 }, false);
    runtime.advance(2001); expect(await a.kv.get('k')).toBeNull();
    await a.kv.update('k', { a: 3 }, '1'); await a.kv.update('k', { b: 4 }, null);
    runtime.advance(2000); expect(await a.kv.get('k')).toEqual({ a: 3, b: 4 });
    await a.kv.expire('k', 1); await a.kv.set('k', 4); runtime.advance(2000); expect(await a.kv.get('k')).toBe(4);
    await a.kv.expire('missing', 1); expect(await a.kv.list('missing')).toEqual(['missing']);
    runtime.advance(1001); expect(await a.kv.list('missing')).toEqual([]);
    await a.kv.expireAt('k', 0); expect(await a.kv.get('k')).toBeNull();
    await expect(a.kv.update('k', { a: 1 }, true)).rejects.toMatchObject({ code: 'ttl_invalid' });
  });
  it('enforces UTF-8 size, nesting, unsafe paths and post-mutation caps', async () => {
    const { a } = world(); await expect(a.kv.set('é'.repeat(513), 1)).rejects.toMatchObject({ code: 'key_too_large' });
    await expect(a.kv.set('k', 'x'.repeat(a.kv.MAX_VALUE_SIZE - 1))).rejects.toMatchObject({ code: 'value_too_large' });
    await expect(a.kv.update('k', { ['a.'.repeat(31) + 'a']: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.kv.update('k', { '__proto__.polluted': 1 })).rejects.toMatchObject({ code: 'bad_request' });
    await a.kv.set('large', { text: 'x'.repeat(a.kv.MAX_VALUE_SIZE - 30) });
    await expect(a.kv.update('large', { more: 'x'.repeat(100) })).rejects.toMatchObject({ code: 'value_too_large' });
    expect((await a.kv.get('large')).more).toBeUndefined(); expect({}.polluted).toBeUndefined();
  });
  it('flushes only the current namespace', async () => {
    const { runtime, a, b } = world(); const other = runtime.client('alice', 0, { appUid: 'other' });
    await Promise.all([a.kv.set('k', 1), b.kv.set('k', 2), other.kv.set('k', 3)]); await a.kv.clear();
    expect(await a.kv.get('k')).toBeNull(); expect(await b.kv.get('k')).toBe(2); expect(await other.kv.get('k')).toBe(3);
  });
});

describe('KV share handles', () => {
  // Alice's app holds the `kvShare` consent for these prefixes at `write`.
  const shared = (options) => {
    const created = world({ shareHandles: true, ...options });
    for (const prefix of ['s:', 't:', 'w:', 'p:', 'x:', 'one:', 'two:']) created.runtime.grantShareConsent('alice', prefix, 'write');
    return created;
  };
  const legacy = (runtime, client, init) => runtime.fetchApi(`https://api.puter.test/events/kv-handles${init.path ?? ''}`, { method: init.method, headers: { Authorization: `Bearer ${client.authToken}` }, body: init.body && JSON.stringify(init.body) });

  it('gates read and write shares on kv.shareHandles and watch shares on events, but never listing or unsharing', async () => {
    const { runtime, a, b } = world();
    runtime.grantShareConsent('alice', 's:', 'write');
    for (const call of [a.kv.share('s:', 'bob'), a.kv.share('s:', 'bob', 'write'), b.kv.get('x', { handle: 'kvh-1' })]) {
      await expect(call).rejects.toMatchObject({ code: 'kv_handles_disabled', status: 403 });
    }
    await expect(a.kv.share('s:', 'bob', 'watch')).rejects.toMatchObject({ code: 'events_kv_handles_disabled', status: 403 });
    await expect(b.events.onLocal('kv:kvh-1:*', () => {})).rejects.toMatchObject({ code: 'events_kv_handles_disabled' });
    expect(await b.kv.listShared()).toEqual({ items: [] });
    expect(await b.kv.listSharedByMe()).toEqual({ items: [] });
    await expect(b.kv.unshare('kvh-1')).rejects.toMatchObject({ code: 'subject_does_not_exist', status: 404 });
  });
  it('writes with onlyIfAbsent only from optConfig, per region, and never in a batch', async () => {
    const { a } = world();
    expect(await a.kv.set('k', 1, { onlyIfAbsent: true })).toBe(true);
    expect(await a.kv.set('k', 2, { onlyIfAbsent: true })).toBe(false);
    expect(await a.kv.set({ key: 'k', value: 3, optConfig: { onlyIfAbsent: true } })).toBe(false);
    // A top-level flag in the object form is not an option the server reads.
    expect(await a.kv.set({ key: 'k', value: 4, onlyIfAbsent: true })).toBe(true);
    expect(await a.kv.get('k')).toBe(4);
    // An expired entry counts as absent.
    await a.kv.set('gone', 1, 1);
    expect(await a.kv.set('gone', 2, { onlyIfAbsent: true })).toBe(true);
    await expect(a.kv.set('k', 5, { onlyIfAbsent: 'yes' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.kv.set([{ key: 'j', value: 1 }], { onlyIfAbsent: true })).rejects.toMatchObject({ code: 'invalid_request' });
    // `update` has no conditional form.
    expect(await a.kv.update('obj', { x: 1 }, { onlyIfAbsent: true })).toEqual({ x: 1 });
    expect(await a.kv.update('obj', { x: 2 }, { onlyIfAbsent: true })).toEqual({ x: 2 });
    const old = world({ onlyIfAbsent: false });
    await old.a.kv.set('k', 1);
    expect(await old.a.kv.set('k', 2, { onlyIfAbsent: true })).toBe(true);
  });
  it('mints read by default and returns the share as the owner sees it', async () => {
    const { a } = shared();
    expect(await a.kv.share('s', 'bob')).toEqual({ handle: expect.stringMatching(/^kvh-/), prefix: 's:', access: 'read', appUid: 'trips', holder: 'bob', label: null, createdAt: 1000 });
    expect(await a.kv.share({ prefix: 't:', recipient: { uid: 'bob' }, access: 'write', appUuid: 'trips', label: ' Trip ' })).toMatchObject({ prefix: 't:', access: 'write', holder: 'bob', label: 'Trip' });
    expect(await a.kv.share({ prefix: 'w:', recipient: { username: 'BOB' }, access: 'watch', label: '   ' })).toMatchObject({ holder: 'bob', label: null });
  });
  it('needs the app\'s kvShare consent for the prefix and level, to share and to revoke', async () => {
    const { runtime, a, b } = world({ shareHandles: true });
    await expect(a.kv.share('q:', 'bob')).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated', status: 403 });
    expect(await a.perms.request('kvShare', { prefix: 'q:', access: 'read' })).toBe(true);
    const read = await a.kv.share('q:', 'bob', 'read');
    expect((await a.kv.share('q:deep:', 'bob', 'watch')).access).toBe('watch');
    await expect(a.kv.share('q:', 'bob', 'write')).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated' });
    await expect(a.perms.request('kvShare', { prefix: 'Q:', access: 'read' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(a.perms.request('kvShare', { prefix: '', access: 'read' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(await a.perms.request('permission', { permission: 'manage:kv-share-write:alice:trips:r' })).toBe(true);
    expect((await a.kv.share('r:', 'bob', 'write')).access).toBe('write');
    runtime.denyPermissions('alice');
    expect(await a.perms.request('kvShare', { prefix: 'z:', access: 'read' })).toBe(false);
    runtime.revokeShareConsent('alice');
    await expect(a.kv.unshare(read.handle)).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated' });
    expect(await b.kv.unshare(read.handle)).toEqual({ handle: read.handle, revokedAt: 1000 });
  });
  it('validates prefixes, levels, labels and recipients', async () => {
    const { runtime, a } = shared();
    await expect(a.kv.share('s:', 'bob', 'admin')).rejects.toMatchObject({ code: 'kv_share_access_invalid', status: 400 });
    for (const prefix of ['s:X:', 's::x', '', ':', 's*', 's:café:', 's\\x:']) await expect(a.kv.share(prefix, 'bob')).rejects.toMatchObject({ code: 'invalid_kv_share_prefix', status: 400 });
    // An app's consent never covers a prefix outside the spelling rules, so the delegation check refuses it first.
    await expect(a.kv.share('S:', 'bob')).rejects.toMatchObject({ code: 'events_kv_handle_not_delegated' });
    // The grant string is capped at 255 characters, so the longest prefix depends on the level.
    const long = `x:${'p'.repeat(227)}`;
    await expect(a.kv.share(long, 'bob', 'write')).rejects.toMatchObject({ code: 'invalid_kv_share_prefix' });
    expect((await a.kv.share(long, 'bob', 'watch')).access).toBe('watch');
    await expect(a.kv.share('s:', 'bob@example.com')).rejects.toMatchObject({ code: 'invalid_recipient', status: 400 });
    await expect(a.kv.share('s:', {})).rejects.toMatchObject({ code: 'invalid_recipient' });
    await expect(a.kv.share('s:', 'nobody')).rejects.toMatchObject({ code: 'subject_does_not_exist', status: 404 });
    await expect(a.kv.share('s:', 'alice')).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(a.kv.share({ prefix: 's:', recipient: 'bob', appUuid: 'other' })).rejects.toMatchObject({ code: 'events_kv_handle_outside_namespace', status: 403 });
    for (const label of [{}, 'a​b', 'x'.repeat(129), 'line\nbreak', 'é́́́']) await expect(a.kv.share({ prefix: 's:', recipient: 'bob', label })).rejects.toMatchObject({ code: 'kv_share_label_invalid', status: 400 });
    runtime.configureUser('carol', { refusesShares: true });
    await expect(a.kv.share('s:', 'carol')).rejects.toMatchObject({ code: 'recipient_not_accepting_shares' });
    runtime.configureUser('alice', { email_confirmed: false });
    await expect(a.kv.share('s:', 'bob')).rejects.toMatchObject({ code: 'account_is_not_verified' });
  });
  it('lists live shares to holders without the owner or prefix, 50 to a page and at most 200', async () => {
    const { runtime, a, b } = shared();
    const first = await a.kv.share({ prefix: 's:', recipient: 'bob', label: 'Lisbon · from alice' });
    const second = await a.kv.share('t:', 'bob', 'write');
    const page = await b.kv.listShared({ limit: 1 });
    expect(page).toEqual({ items: [{ handle: first.handle, access: 'read', appUid: 'trips', label: 'Lisbon · from alice', createdAt: 1000 }], cursor: expect.any(String) });
    expect(await b.kv.listShared({ cursor: page.cursor, includeTotal: true })).toEqual({ items: [{ handle: second.handle, access: 'write', appUid: 'trips', label: null, createdAt: 1000 }], total: 2 });
    await expect(b.kv.listShared({ limit: 0 })).rejects.toMatchObject({ code: 'bad_request' });
    expect((await b.kv.listShared({ limit: 5000 })).items).toHaveLength(2);
    await a.kv.unshare(first.handle);
    expect((await b.kv.listShared()).items.map((item) => item.handle)).toEqual([second.handle]);
    expect(await a.kv.listShared()).toEqual({ items: [] });
    expect(await runtime.client('bob', 0, { appUid: 'other' }).kv.listShared()).toEqual({ items: [] });
  });
  it('records who stopped a share in the owner list, in Unix seconds', async () => {
    const { runtime, a, b } = shared();
    const byHolder = await a.kv.share('s:', 'bob'); const byOwner = await a.kv.share('t:', 'bob', 'watch');
    runtime.advance(5000); await b.kv.unshare(byHolder.handle); await a.kv.unshare(byOwner.handle);
    const { items, total } = await a.kv.listSharedByMe({ includeTotal: true });
    expect(total).toBe(2);
    expect(items).toEqual([
      { handle: byHolder.handle, prefix: 's:', access: 'read', appUid: 'trips', holder: 'bob', label: null, createdAt: 1000, revokedAt: 1005, revokedBy: 'holder' },
      { handle: byOwner.handle, prefix: 't:', access: 'watch', appUid: 'trips', holder: 'bob', label: null, createdAt: 1000, revokedAt: 1005, revokedBy: 'owner' },
    ]);
    expect((await b.kv.listSharedByMe()).items).toEqual([]);
    runtime.renameUser('bob', 'robert');
    expect((await a.kv.listSharedByMe()).items[0].holder).toBe('robert');
  });
  it('unshares idempotently from either side, takes narrower shares along and hides other people\'s handles', async () => {
    const { runtime, a, b } = shared();
    const carol = runtime.client('carol');
    const broad = await a.kv.share('s:', 'bob', 'read');
    const narrow = await a.kv.share('s:u:bob:', 'bob', 'write');
    const other = await a.kv.share('s:u:carol:', 'carol', 'write');
    const stopped = await a.kv.unshare(broad.handle);
    expect(stopped).toEqual({ handle: broad.handle, revokedAt: 1000 });
    expect(await a.kv.unshare(broad.handle)).toEqual(stopped);
    expect(await b.kv.unshare(broad.handle)).toEqual(stopped);
    await expect(b.kv.set('pres', 1, { handle: narrow.handle })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
    expect((await a.kv.listSharedByMe()).items.find((item) => item.handle === narrow.handle)).toMatchObject({ revokedBy: 'owner' });
    expect(await carol.kv.set('pres', 1, { handle: other.handle })).toBe(true);
    await expect(carol.kv.unshare(narrow.handle)).rejects.toMatchObject({ code: 'subject_does_not_exist', status: 404 });
    await expect(b.kv.unshare('kvh-unknown')).rejects.toMatchObject({ code: 'subject_does_not_exist' });
    await expect(b.kv.unshare('')).rejects.toMatchObject({ code: 'invalid_request' });
    // The holder giving up a share takes the narrower ones they hold from the same owner too.
    const unrelated = await a.kv.share('t:', 'carol', 'read');
    await carol.kv.unshare(unrelated.handle);
    expect(await carol.kv.set('pres', 2, { handle: other.handle })).toBe(true);
    const wide = await a.kv.share('s:', 'carol', 'read');
    await carol.kv.unshare(wide.handle);
    await expect(carol.kv.get('pres', { handle: other.handle })).rejects.toMatchObject({ code: 'kv_handle_not_found' });
    // Unsharing works with sharing turned off.
    const late = await a.kv.share('p:', 'bob');
    runtime.flags.shareHandles = false;
    expect((await a.kv.unshare(late.handle)).handle).toBe(late.handle);
  });
  it('returns one not-found body for unknown, revoked, foreign, owner-gone and app-gone handles', async () => {
    const failure = promise => promise.then(() => null, cause => ({ code: cause.code, status: cause.status, message: cause.message }));
    const { runtime, a, b } = shared(); await a.kv.set('s:x', 1);
    const revoked = await a.kv.share('s:', 'bob'); await a.kv.unshare(revoked.handle);
    const { handle } = await a.kv.share('s:', 'bob');
    const gone = shared(); const goneGrant = await gone.a.kv.share('s:', 'bob'); gone.runtime.removeUser('alice');
    const app = shared(); const appGrant = await app.a.kv.share('s:', 'bob'); app.runtime.removeApp('trips');
    const failures = await Promise.all([
      failure(b.kv.get('x', { handle: 'kvh-999' })),
      failure(b.kv.get('x', { handle: 'not-a-handle' })),
      failure(b.kv.get('x', { handle: revoked.handle })),
      failure(runtime.client('carol').kv.get('x', { handle })),
      failure(runtime.client('bob', 0, { appUid: 'other' }).kv.get('x', { handle })),
      failure(gone.b.kv.get('x', { handle: goneGrant.handle })),
      failure(app.b.kv.get('x', { handle: appGrant.handle })),
    ]);
    expect(new Set(failures.map((item) => JSON.stringify(item)))).toEqual(new Set([JSON.stringify({ code: 'kv_handle_not_found', status: 404, message: 'kv: no such share handle' })]));
    expect((await gone.b.kv.listShared()).items).toEqual([]);
    expect((await app.a.kv.listSharedByMe()).items[0]).toMatchObject({ revokedBy: 'system' });
  });
  it('guards levels, options and relative keys', async () => {
    const { a, b } = shared(); await a.kv.set('s:x', 2);
    const read = await a.kv.share('s:', 'bob'); const watch = await a.kv.share('w:', 'bob', 'watch');
    await expect(b.kv.set('x', 3, { handle: read.handle })).rejects.toMatchObject({ code: 'kv_handle_access_denied', status: 403 });
    await expect(b.kv.get('x', { handle: watch.handle })).rejects.toMatchObject({ code: 'kv_handle_access_denied', status: 403 });
    for (const call of [b.kv.get('x', { handle: read.handle, appUuid: 'trips' }), b.kv.get('x', { handle: read.handle, disableSharing: true }), b.kv.flush({ handle: read.handle }), b.kv.get('x', { handle: 5 })]) {
      await expect(call).rejects.toMatchObject({ code: 'kv_handle_option_invalid', status: 400 });
    }
    for (const key of ['', 'k'.repeat(769)]) await expect(b.kv.get(key, { handle: read.handle })).rejects.toMatchObject({ code: 'kv_handle_key_invalid', status: 400 });
    await expect(b.kv.list({ pattern: 'k'.repeat(769), optConfig: { handle: read.handle } })).rejects.toMatchObject({ code: 'kv_handle_key_invalid' });
    expect(await b.kv.get('k'.repeat(768), { handle: read.handle })).toBeNull();
    // The owner may use their own handle.
    expect(await a.kv.get('x', { handle: read.handle })).toBe(2);
  });
  it('hides private entries from handle reads, lists and totals and refuses handle writes to them', async () => {
    const { runtime, a, b } = shared(); await a.kv.set('s:x', 2); await a.kv.set('s:private', { secret: 'x'.repeat(20_000) }, { disableSharing: true });
    const { handle } = await a.kv.share('s:', 'bob', 'write');
    runtime.resetCounters(); expect(await b.kv.get(['x', 'private'], { handle })).toEqual([2, null]);
    expect(runtime.counters().byUser.bob.kvReadUnits).toBe(2);
    expect(await b.kv.list({ returnValues: true, includeTotal: true, limit: 10, optConfig: { handle } })).toEqual({ items: [{ key: 'x', value: 2 }], cursor: null, total: 1 });
    for (const call of [b.kv.set('private', 4, { handle }), b.kv.update('private', { y: 1 }, { handle }), b.kv.del('private', { handle })]) await expect(call).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(await b.kv.set('private', 4, { handle, onlyIfAbsent: true })).toBe(false);
    expect((await a.kv.get('s:private')).secret).toHaveLength(20_000);
  });
  it('never takes a handle from a shorthand object', async () => {
    const { a, b } = shared(); await a.kv.set('s:x', 1);
    const { handle } = await a.kv.share('s:', 'bob', 'write');
    expect(await b.kv.incr('n', { appUuid: 'trips', handle })).toBe(1);
    expect(await b.kv.add('list', { appUuid: 'trips', handle })).toEqual([1]);
    expect(await b.kv.get({ key: 'x', handle })).toBeNull();
    expect(await b.kv.list({ appUuid: 'trips', handle })).toEqual(['list', 'n']);
    expect(await a.kv.get(['s:n', 's:list'])).toEqual([null, null]);
  });
  it('changes a share in place, nests write scopes and sends one notice per new share', async () => {
    const { runtime, a, b } = shared();
    const notices = vi.fn(); await b.events.onLocal('notif:app-user', notices);
    const broad = await a.kv.share({ prefix: 's:', recipient: 'bob', access: 'read', label: 'Lisbon' });
    const narrow = await a.kv.share('s:u:bob:', 'bob', 'write');
    await b.kv.set('pres', { at: 1 }, { handle: narrow.handle }); expect(await b.kv.get('u:bob:pres', { handle: broad.handle })).toEqual({ at: 1 });
    runtime.advance(5000);
    expect(await a.kv.share('s:', 'bob', 'write')).toEqual({ ...broad, access: 'write' });
    expect((await a.kv.share({ prefix: 's:', recipient: 'bob', access: 'write', label: null })).label).toBeNull();
    runtime.configureUser('bob', { blocks: ['alice'] });
    expect((await a.kv.share('s:', 'bob', 'read')).access).toBe('read');
    await expect(a.kv.share('s:', 'bob', 'write')).rejects.toMatchObject({ code: 'recipient_not_accepting_shares' });
    await expect(a.kv.share('t:', 'bob')).rejects.toMatchObject({ code: 'recipient_not_accepting_shares' });
    await runtime.flushEvents();
    expect(notices).toHaveBeenCalledTimes(2);
  });
  it('keeps list keys relative, seals cursors to the handle and bills the holder', async () => {
    const { runtime, a, b } = shared(); await a.kv.set(['a', 'b', 'c'].map(key => ({ key: 'p:' + key, value: key })));
    const { handle } = await a.kv.share('p:', 'bob', 'read'); const other = await a.kv.share('p:', 'carol', 'read'); runtime.resetCounters();
    const p = await b.kv.list({ limit: 2, reverse: true, optConfig: { handle } });
    expect(p).toEqual({ items: ['c', 'b'], cursor: expect.stringMatching(/^kvc\./) });
    expect(await b.kv.list({ cursor: p.cursor, limit: 2, reverse: true, optConfig: { handle } })).toEqual({ items: ['a'], cursor: null });
    await expect(b.kv.list({ cursor: p.cursor, limit: 2, optConfig: { handle } })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(runtime.client('carol').kv.list({ cursor: p.cursor, limit: 2, reverse: true, optConfig: { handle: other.handle } })).rejects.toMatchObject({ code: 'bad_request' });
    expect(runtime.counters().byUser.alice).toBeUndefined(); expect(runtime.counters().byUser.bob.calls['kv.list']).toBe(3);
  });
  it('notifies the holder in the app on creation, at most 5 an hour from one owner', async () => {
    const { runtime, a, b } = shared(); const notified = vi.fn(); const otherApp = vi.fn();
    await b.events.onLocal('notif:app-user', notified); await runtime.client('bob', 0, { appUid: 'other' }).events.onLocal('notif:app-user', otherApp);
    const { handle } = await a.kv.share({ prefix: 's:', recipient: 'bob', label: 'Lisbon · from alice' }); await a.kv.share('s:', 'bob', 'write');
    await runtime.flushEvents();
    expect(notified).toHaveBeenCalledOnce(); expect(otherApp).not.toHaveBeenCalled();
    expect(notified.mock.calls[0][0].event).toMatchObject({ op: 'post', type: 'kv.share.received', audience: 'app-user', appUid: 'trips', self: true });
    expect(notified.mock.calls[0][0].event.notification).toEqual({ type: 'kv.share.received', handle, access: 'read', label: 'Lisbon · from alice', createdAt: 1000 });
    for (const prefix of ['t:', 'w:', 'p:', 'one:', 'two:']) await a.kv.share(prefix, 'bob');
    await runtime.flushEvents();
    expect(notified).toHaveBeenCalledTimes(5);
    runtime.advance(3_600_001); await a.kv.share('x:', 'bob'); await runtime.flushEvents();
    expect(notified).toHaveBeenCalledTimes(6);
  });
  it('serves the legacy watch route with watch as the default level, owner-only revokes', async () => {
    const { runtime, a, b } = shared(); await a.kv.set('s:x', 1);
    const minted = await legacy(runtime, a, { method: 'POST', body: { granteeUid: 'bob', prefix: 's:' } });
    const grant = await minted.json(); expect(minted.status).toBe(200); expect(grant).toMatchObject({ access: 'watch', holder: 'bob', prefix: 's:' });
    await expect(b.kv.get('x', { handle: grant.handle })).rejects.toMatchObject({ code: 'kv_handle_access_denied' });
    const byHolder = await legacy(runtime, b, { method: 'DELETE', path: '/' + grant.handle });
    expect(byHolder.status).toBe(404); expect(await byHolder.json()).toMatchObject({ code: 'subject_does_not_exist' });
    const revoked = await legacy(runtime, a, { method: 'DELETE', path: '/' + grant.handle });
    expect(revoked.status).toBe(200); expect(await revoked.json()).toEqual({ handle: grant.handle, revokedAt: 1000 });
    expect((await runtime.fetchApi('https://api.puter.test/events/kv-handles', { method: 'POST', body: '{}' })).status).toBe(401);
    runtime.setOffline('alice'); await expect(legacy(runtime, a, { method: 'POST', body: { granteeUid: 'bob', prefix: 't:' } })).rejects.toThrow(TypeError);
  });
});

describe('replication, faults and counters', () => {
  it('reproduces duplicate region-local counters and per-item LWW losses', async () => {
    const { runtime, a } = world({ regions: 2 }); const other = runtime.client('alice', 1);
    await a.kv.set('obj', { a: 0, b: 0 }); runtime.flushReplication();
    expect(await a.kv.incr('rev')).toBe(1); expect(await other.kv.incr('rev')).toBe(1);
    await a.kv.update('obj', { a: 1 }); await other.kv.update('obj', { b: 1 }); expect(await a.kv.get('obj')).toEqual({ a: 1, b: 0 });
    runtime.flushReplication(); expect(await a.kv.get('obj')).toEqual({ a: 0, b: 1 }); expect(await other.kv.get('obj')).toEqual({ a: 0, b: 1 });
  });
  it('delays replication, replicates tombstones and claims conditional keys per region', async () => {
    const { runtime, a } = world({ regions: 2 }); const other = runtime.client('alice', 1);
    await a.kv.set('k', 1); expect(await other.kv.get('k')).toBeNull(); runtime.advance(50); expect(await other.kv.get('k')).toBe(1);
    await other.kv.del('k'); runtime.flushReplication(); expect(await a.kv.get('k')).toBeNull();
    // Both regions claim before replication; the later write wins everywhere.
    expect(await a.kv.set('claim', 1, { onlyIfAbsent: true })).toBe(true); expect(await other.kv.set('claim', 2, { onlyIfAbsent: true })).toBe(true);
    runtime.flushReplication();
    expect(await a.kv.get('claim')).toBe(2);
    expect(await a.kv.set('claim', 3, { onlyIfAbsent: true })).toBe(false);
  });
  it('injects scoped 402s and offline without losing data', async () => {
    const { runtime, a, b } = world(); runtime.failNext({ method: 'kv.set', as: 'bob', times: 2 }); await a.kv.set('k', 1);
    await expect(b.kv.set('k', 2)).rejects.toMatchObject({ status: 402 }); await expect(b.kv.set('k', 2)).rejects.toMatchObject({ status: 402 }); await b.kv.set('k', 2);
    runtime.setOffline('alice'); await expect(a.kv.get('k')).rejects.toMatchObject({ code: 'offline' }); runtime.setOffline('alice', false); expect(await a.kv.get('k')).toBe(1);
  });
  it('counts batches once and meters item sizes', async () => {
    const { runtime, a } = world(); await a.kv.set([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]); await a.kv.get(['a', 'b']);
    const stats = runtime.counters(); expect(stats.calls).toEqual({ 'kv.set': 1, 'kv.get': 1 }); expect(stats.kvWriteUnits).toBe(2); expect(stats.kvReadUnits).toBe(2); expect(stats.microCents).toBe(600);
    stats.calls['kv.set'] = 99; expect(runtime.counters().calls['kv.set']).toBe(1);
  });
});

describe('modeled platform limits', () => {
  it('rate-limits a method per user/app across clients and resets by window', async () => {
    const { runtime, a } = world();
    for (let i = 0; i < 400; i++) await a.kv.get('k');
    await expect(runtime.client('alice').kv.get('k')).rejects.toMatchObject({ status: 429 });
    expect(await runtime.client('bob').kv.get('k')).toBeNull();
    runtime.advance(10_001); expect(await a.kv.get('k')).toBeNull();
  });
  it('shares list and concurrency budgets across worker/client sessions', async () => {
    const { runtime, a } = world();
    for (let i = 0; i < 120; i++) await a.kv.list({ limit: 1 });
    await expect(runtime.client('alice', 0, { worker: true }).kv.list({ limit: 1 })).rejects.toMatchObject({ status: 429 });
    const slow = createFakePuter({ latency: 1 }); const client = slow.client('alice');
    const results = await Promise.allSettled(Array.from({ length: 31 }, () => client.kv.get('k')));
    expect(results.filter(r => r.status === 'rejected')[0].reason.status).toBe(429);
  });
  it('enforces handle caps and allows watch-only holders to withdraw', async () => {
    const { runtime, a, b } = world({ shareHandles: true, maxHandles: 1 });
    for (const prefix of ['one:', 'two:']) runtime.grantShareConsent('alice', prefix, 'write');
    const grant = await a.kv.share('one:', 'bob', 'watch');
    await expect(a.kv.share('two:', 'bob', 'read')).rejects.toMatchObject({ code: 'events_kv_handle_limit_reached', status: 409 });
    await b.kv.unshare(grant.handle); expect((await a.kv.share('two:', 'bob', 'read')).access).toBe('read');
  });
  it('budgets 60 shares and unshares a minute per user, and 120 share listings', async () => {
    const { runtime, a, b } = world({ shareHandles: true });
    runtime.grantShareConsent('alice', 'n:', 'write');
    for (let i = 0; i < 30; i++) await a.kv.unshare((await a.kv.share(`n:${i}:`, 'bob')).handle);
    await expect(a.kv.share('n:last:', 'bob')).rejects.toMatchObject({ code: 'too_many_requests', status: 429 });
    for (let i = 0; i < 120; i++) await b.kv.listShared();
    await expect(b.kv.listSharedByMe()).rejects.toMatchObject({ code: 'too_many_requests' });
    runtime.advance(60_001);
    expect((await a.kv.share('n:last:', 'bob')).access).toBe('read');
  });
});

it('bills a replacement set on new size while update bills max old/new', async () => {
  const { runtime, a } = world(); await a.kv.set('k', { text: 'x'.repeat(10_000) }); runtime.resetCounters();
  await a.kv.set('k', 1); expect(runtime.counters().kvWriteUnits).toBe(1);
  await a.kv.set('k', { text: 'x'.repeat(10_000) }); runtime.resetCounters();
  await a.kv.update('k', { '': 1 }); expect(runtime.counters().kvWriteUnits).toBe(10);
});
