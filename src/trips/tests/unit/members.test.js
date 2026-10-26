import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, routeHash } from '../../src/lib/router.js';
import {
  canManage, canRevoke, cleanLabel, expiryAt, grantable, inviteURL, looksLikeEmail, mailtoURL, minimumFor, nextGuestColor, nextPerms, sortMembers, DAY,
} from '../../src/views/trip/members/logic.js';
import { errorMessage } from '../../src/views/trip/members/errors.js';
import { cleanInvites } from '../../src/views/trip/members/invites.js';
import { validPicture } from '../../src/views/trip/members/people.js';
import { joinWithToken, previewFrom } from '../../src/views/join/link.js';
import { membersView } from '../../src/views/trip/members/index.js';
import { t } from '../../src/lib/i18n/index.js';

const W = 'trips-abcdefghij';
const S = '0123456789abcdef';
const TOKEN = 'a'.repeat(32);
const uuid = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const me = (role, manage = role === 'owner') => ({ uid: uuid(1), role, perms: {}, manage });

describe('member rules', () => {
  it('grants only roles below the caller', () => {
    expect(grantable('owner')).toEqual(['editor', 'viewer']);
    expect(grantable('editor')).toEqual(['viewer']);
    expect(grantable('viewer')).toEqual([]);
    expect(grantable(null)).toEqual([]);
  });
  it('lets managers act on members below them, never on themselves', () => {
    expect(canManage(me('owner'), { uid: uuid(2), role: 'editor' })).toBe(true);
    expect(canManage(me('owner'), { uid: uuid(1), role: 'owner' })).toBe(false);
    expect(canManage(me('editor', true), { uid: uuid(2), role: 'editor' })).toBe(false);
    expect(canManage(me('editor', true), { uid: uuid(3), role: 'viewer' })).toBe(true);
    expect(canManage(me('editor', false), { uid: uuid(3), role: 'viewer' })).toBe(false);
    expect(canRevoke(me('editor', true), { role: 'editor' })).toBe(false);
    expect(canRevoke(me('editor', true), { role: 'viewer' })).toBe(true);
  });
  it('stores only permission overrides that differ from the defaults', () => {
    expect(nextPerms({}, 'members.manage', 'editor')).toEqual({ 'members.manage': 'editor' });
    expect(nextPerms({ 'members.manage': 'editor' }, 'members.manage', 'owner')).toBeNull();
    expect(nextPerms({ 'plan.edit': 'owner', 'bogus': 'viewer', 'trip.delete': 'editor' })).toEqual({ 'plan.edit': 'owner' });
    expect(() => nextPerms({}, 'trip.delete', 'editor')).toThrow();
    expect(minimumFor({ 'collab.post': 'viewer' }, 'collab.post')).toBe('viewer');
    expect(minimumFor({ 'collab.post': 'nobody' }, 'collab.post')).toBe('editor');
  });
  it('orders members by role, then the caller, then name', () => {
    const list = [{ uid: 'c', name: 'Cy', role: 'viewer' }, { uid: 'b', name: 'Bo', role: 'editor' }, { uid: 'z', name: 'Al', role: 'editor' }, { uid: 'o', name: 'Ow', role: 'owner' }];
    expect(sortMembers(list, 'b').map((item) => item.uid)).toEqual(['o', 'b', 'z', 'c']);
  });
  it('picks the least used guest color', () => {
    expect(nextGuestColor([])).toBe(1);
    expect(nextGuestColor([{ color: 1 }, { color: 2 }])).toBe(3);
    expect(nextGuestColor([1, 2, 3, 4, 5, 6, 7, 8, 1].map((color) => ({ color })))).toBe(2);
  });
});

describe('invite links', () => {
  it('builds share links without Puter launch parameters', () => {
    expect(inviteURL('https://trips.puter.com/?puter.app_instance_id=1&puter.domain=puter.com#/t/x', { w: W, s: S }, TOKEN))
      .toBe(`https://trips.puter.com/#/join/${W}/${S}/${TOKEN}`);
    expect(inviteURL('http://localhost:5304/mock.html?as=alice', { w: W, s: S }, TOKEN)).toBe(`http://localhost:5304/mock.html?as=alice#/join/${W}/${S}/${TOKEN}`);
    expect(() => inviteURL('https://trips.puter.com/', { w: 'evil.com', s: S }, TOKEN)).toThrow();
    expect(() => inviteURL('https://trips.puter.com/', { w: W, s: S }, 'nope')).toThrow();
  });
  it('round-trips the join route and rejects malformed ones', () => {
    const route = parseRoute(`#/join/${W}/${S}/${TOKEN}`);
    expect(route).toEqual({ name: 'join', worker: W, space: S, token: TOKEN });
    expect(routeHash(route)).toBe(`#/join/${W}/${S}/${TOKEN}`);
    for (const hash of [`#/join/${W}/${S}`, `#/join/evil/${S}/${TOKEN}`, `#/join/${W}/${S}/${TOKEN.toUpperCase()}`, `#/join/${W}/${S}/${TOKEN}/x`]) expect(parseRoute(hash).name).toBe('notFound');
  });
  it('validates personal-link labels like the worker', () => {
    expect(cleanLabel('  Maria ')).toEqual({ value: 'Maria' });
    expect(cleanLabel('   ').error).toBe('required');
    expect(cleanLabel('x'.repeat(81)).error).toBe('tooLong');
    expect(cleanLabel('a\nb').error).toBe('tooLong');
    expect(looksLikeEmail('maria@example.com')).toBe(true);
    expect(looksLikeEmail('Maria')).toBe(false);
    expect(mailtoURL('maria@example.com', 'Hi there', 'A & B')).toBe('mailto:maria@example.com?subject=Hi%20there&body=A%20%26%20B');
  });
  it('keeps the 90-day expiry inside the worker limit', () => {
    expect(expiryAt(14, 1000)).toBe(1000 + 14 * DAY);
    expect(expiryAt(90, 1000)).toBeLessThan(1000 + 90 * DAY);
  });
  it('drops malformed invite list items', () => {
    const good = { id: 'f'.repeat(64), role: 'viewer', exp: 5, max: 1, uses: 0, created: 2, by: uuid(1), label: 'Maria' };
    expect(cleanInvites([good, { ...good, id: 'x' }, { ...good, role: 'owner' }, null])).toEqual([{ ...good, named: '' }]);
  });
  it('accepts only raster data URLs as profile pictures', () => {
    expect(validPicture('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(validPicture('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(validPicture('https://example.com/a.png')).toBe(false);
  });
});

describe('error messages', () => {
  it.each([
    [{ code: 'invite_invalid', status: 404, reason: 'expired' }, 'members.errExpired'],
    [{ code: 'invite_invalid', status: 404, reason: 'revoked' }, 'members.errRevoked'],
    [{ code: 'invite_invalid', status: 404, reason: 'used' }, 'members.errUsed'],
    [{ code: 'invite_invalid', status: 404 }, 'members.errInvalid'],
    [{ code: 'space_full', status: 409 }, 'members.errFull'],
    [{ code: 'space_not_found', status: 404 }, 'members.errGone'],
    [{ code: 'gone', status: 409 }, 'members.errGone'],
    [{ code: 'owner_credit', status: 402 }, 'members.errOwnerCredit'],
    [{ code: 'caller_credit', status: 402 }, 'members.errCallerCredit'],
    [{ code: 'forbidden', status: 403 }, 'members.errForbidden'],
    [{ code: 'not_member', status: 403 }, 'members.errNotMember'],
    [{ code: 'worker_outdated', status: 426 }, 'members.errOutdated'],
    [{ code: 'network', status: 0 }, 'members.errOffline'],
  ])('maps %o', (error, key) => expect(errorMessage(error, { offline: false })).toBe(t(key)));
  it('reads 429 and 404 by context', () => {
    expect(errorMessage({ code: 'rate_limited', status: 429 }, { context: 'invite', offline: false })).toBe(t('members.errInviteBudget'));
    expect(errorMessage({ code: 'rate_limited', status: 429, retryAfter: 600 }, { offline: false })).toBe(t('members.errRateLimitedIn', { minutes: '10' }));
    expect(errorMessage({ code: 'not_member', status: 404 }, { context: 'member', offline: false })).toBe(t('members.errTargetGone'));
  });
});

describe('joining with a link', () => {
  const preview = { ok: true, title: ' Lisbon ', owner: 'alice', role: 'editor', kind: 'trip', exp: 9 };
  it('clamps the preview', () => {
    expect(previewFrom(preview)).toEqual({ title: 'Lisbon', owner: 'alice', role: 'editor', kind: 'trip', exp: 9 });
    expect(() => previewFrom({ ...preview, role: 'owner' })).toThrow();
  });
  it('joins, caches the trip and reports an index failure without throwing', async () => {
    const api = { request: vi.fn(async () => ({ ok: true, space: S, kind: 'trip', role: 'editor', rev: 3, handles: { read: 'r', write: 'w' } })) };
    const spaces = { upsert: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'kv_error' }); }) };
    const joined = await joinWithToken({ api, spaces, worker: W, space: S, token: TOKEN, title: 'Lisbon' });
    expect(JSON.parse(api.request.mock.calls[0][1])).toEqual({ op: 'join', space: S, token: TOKEN });
    expect(joined).toMatchObject({ ref: { w: W, s: S, k: 'trip' }, role: 'editor', indexed: false, entry: { handles: { read: 'r', write: 'w' }, title: 'Lisbon' } });
    expect(spaces.upsert).toHaveBeenCalledTimes(2);
    api.request.mockResolvedValueOnce({ ok: true, space: 'ffffffffffffffff', kind: 'trip', role: 'editor' });
    await expect(joinWithToken({ api, spaces, worker: W, space: S, token: TOKEN })).rejects.toMatchObject({ code: 'invalid_join_response' });
  });
});

function stubSpace({ role, members, meta = {} }) {
  const listeners = new Set();
  const applied = [];
  const entities = { member: members.map((m) => ({ id: m.uid, name: m.name, role: m.role, color: 2 })), guest: [], meta: [{ id: 'meta', title: 'Lisbon', ...meta }] };
  return {
    ref: { w: W, s: S, k: 'trip' }, role, applied,
    get: (type, id) => entities[type]?.find((item) => item.id === id),
    query: (type) => entities[type] ?? [],
    members: () => members.map((m) => ({ active: false, view: '', ...m })),
    subscribe(target, listener) { const entry = { target, listener }; listeners.add(entry); return () => listeners.delete(entry); },
    ops: {
      create: (type, fields) => ({ t: type, id: 'g000000000000001', put: fields }),
      patch: (type, id, { set, unset } = {}) => ({ t: type, id, ...(set ? { set } : {}), ...(unset ? { unset } : {}) }),
      remove: (type, id) => ({ t: type, id, del: true }),
    },
    apply: async (ops) => { applied.push(...ops); },
    sync: async () => {},
  };
}

describe('members view', () => {
  afterEach(() => { document.body.replaceChildren(); });
  const people = [
    { uid: uuid(1), name: 'alice', role: 'owner' },
    { uid: uuid(2), name: 'bob', role: 'editor', active: true, view: 'plan' },
    { uid: uuid(3), name: 'carol', role: 'viewer' },
  ];
  function render(role, uid, meta) {
    const container = document.createElement('div'); document.body.append(container);
    const api = { call: vi.fn(async (_ref, op) => (op === 'invite.list' ? { invites: [] } : { ok: true })) };
    const space = stubSpace({ role, members: people, meta });
    const view = membersView(container, { space, session: { api }, account: { uuid: uid, username: 'x' }, app: { navigate: vi.fn() }, puter: null, window });
    return { container, api, space, view };
  }
  const actions = (container) => [...container.querySelectorAll('.members-list button[aria-label^="Actions for"]')].map((node) => node.getAttribute('aria-label'));

  it('shows owners every control and lists presence', async () => {
    const { container, api } = render('owner', uuid(1));
    expect(container.querySelector('.members-head .btn-primary').hidden).toBe(false);
    expect(actions(container)).toEqual(['Actions for bob', 'Actions for carol']);
    expect(container.textContent).toContain(t('members.activeOn', { view: t('app.plan') }));
    expect(container.querySelectorAll('select.perm-select').length).toBeGreaterThan(5);
    expect(container.querySelector('.members-leave button')).toBeNull();
    await vi.waitFor(() => expect(api.call).toHaveBeenCalledWith(expect.anything(), 'invite.list'));
  });

  it('gives viewers a read-only view with leave', () => {
    const { container, api } = render('viewer', uuid(3));
    expect(container.querySelector('.members-head .btn-primary').hidden).toBe(true);
    expect(actions(container)).toEqual([]);
    expect(container.querySelectorAll('select.perm-select')).toHaveLength(0);
    expect(container.querySelector('.members-leave button').textContent).toContain(t('members.leave'));
    expect(api.call).not.toHaveBeenCalled();
  });

  it('lets editors manage viewers when the owner allows it', () => {
    const { container } = render('editor', uuid(2), { perms: { 'members.manage': 'editor' } });
    expect(actions(container)).toEqual(['Actions for carol']);
  });

  it('saves permission changes as one meta patch', async () => {
    const { container, space } = render('owner', uuid(1));
    const select = [...container.querySelectorAll('select.perm-select')].find((node) => node.dataset.focus === 'perm:members.manage');
    select.value = 'editor';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(space.applied).toEqual([{ t: 'meta', id: 'meta', set: { perms: { 'members.manage': 'editor' } } }]));
  });
});
