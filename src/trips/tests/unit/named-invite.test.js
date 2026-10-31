import { afterEach, describe, expect, it, vi } from 'vitest';
import { USERS, WORKER, createHarness, memoryDb } from '../worker/harness.js';
import { K } from '../../worker/keys.js';
import { membersView } from '../../src/views/trip/members/index.js';
import { cleanUsername, namedErrorMessage } from '../../src/views/trip/members/named/index.js';
import { createInvites } from '../../src/lib/invites.js';
import { t } from '../../src/lib/i18n/index.js';

Blob.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };

const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => document.querySelector('[role=dialog]');

function kvSpace(h, space) {
  const entity = (uuid) => h.kv()[K.entity(space, 'member', uuid)];
  return {
    ref: { w: WORKER, s: space, k: 'trip' }, role: 'owner',
    get: (type, id) => (type === 'member' ? entity(id) : type === 'meta' ? { id: 'meta', title: 'Lisbon' } : undefined),
    query: () => [],
    members: () => Object.values(USERS).map((user) => entity(user.uuid)).filter((item) => item && !item.deleted)
      .map((item) => ({ uid: item.id, name: item.name, role: item.role, color: item.color, active: false, view: '' })),
    subscribe: () => () => {},
    ops: {}, apply: async () => {}, sync: async () => {},
  };
}

async function openDialog(h, space) {
  const alice = await h.client('alice');
  const container = document.createElement('div'); document.body.append(container);
  const view = membersView(container, { space: kvSpace(h, space), session: { api: alice.api, db: memoryDb(USERS.alice.uuid), account: { uuid: USERS.alice.uuid, username: 'alice' } },
    account: { uuid: USERS.alice.uuid }, puter: alice.puter, app: { navigate: vi.fn() } });
  await vi.waitFor(() => expect(container.textContent).toContain(t('members.linksEmpty')));
  byText(container, t('members.invite')).click();
  [...dialog().querySelectorAll('[role=radio]')].find((node) => node.textContent.startsWith(t('sharing.inviteUser'))).click();
  const input = [...dialog().querySelectorAll('input')].find((node) => node.closest('.field')?.textContent.includes(t('sharing.username')));
  const send = (value) => { input.value = value; dialog().querySelector('form').requestSubmit(); };
  return { container, view, input, send };
}

describe('usernames', () => {
  it('accepts Puter usernames, with or without @, and refuses emails, junk and yourself', () => {
    expect(cleanUsername(' @Bob_1.x ')).toEqual({ value: 'Bob_1.x' });
    expect(cleanUsername('')).toEqual({ error: 'required' });
    expect(cleanUsername('bob@example.com')).toEqual({ error: 'email' });
    expect(cleanUsername('bo b')).toEqual({ error: 'invalid' });
    expect(cleanUsername('Alice', 'alice')).toEqual({ error: 'self' });
  });

  it('explains named-invite refusals', () => {
    expect(namedErrorMessage({ code: 'user_not_found', status: 404 })).toBe(t('sharing.errNotFound'));
    expect(namedErrorMessage({ code: 'already_member', status: 409 })).toBe(t('sharing.errAlreadyMember'));
    expect(namedErrorMessage({ code: 'named_invites_unavailable', status: 409 })).toBe(t('sharing.errUnavailable'));
    expect(namedErrorMessage({ code: 'rate_limited', status: 429 })).toBe(t('members.errInviteBudget'));
  });
});

describe('invite by username against the real worker', () => {
  afterEach(() => { dialog()?.querySelector('.modal-head .icon-btn')?.click(); document.body.replaceChildren(); vi.useRealTimers(); });

  it('sends a labelled invitation that the invitee accepts from their inbox', async () => {
    const h = await createHarness({ shareHandles: true });
    vi.setSystemTime(h.now());
    const space = await h.trip();
    const { container, view, send } = await openDialog(h, space);
    send('@bob');
    await vi.waitFor(() => expect(dialog().textContent).toContain(t('sharing.sent', { name: '@bob' })));
    await vi.waitFor(() => expect(container.textContent).toContain(t('members.linkFor', { name: 'bob' })));
    const [record] = (await (await h.client('alice')).in(space).call('invite.list')).invites;
    expect(record).toMatchObject({ named: 'bob', role: 'editor', max: 1 });

    const bob = await h.client('bob');
    const upserts = [];
    const inbox = createInvites({ puter: bob.puter, api: bob.api, spaces: { list: async () => [], upsert: async (entry) => { upserts.push(entry); } }, now: h.now });
    const [invite] = await inbox.list();
    expect(invite).toMatchObject({ title: 'Lisbon', ownerName: 'alice', role: 'editor' });
    await inbox.accept(invite);
    expect(upserts[0]).toMatchObject({ role: 'editor', handles: { read: expect.any(String) }, files: { mode: 'direct', inbox: expect.any(String) } });
    view.destroy();
  });

  it('shows field and worker errors in place', async () => {
    const h = await createHarness({ shareHandles: true });
    vi.setSystemTime(h.now());
    const space = await h.trip();
    const { send, input } = await openDialog(h, space);
    send('alice');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().textContent).toContain(t('sharing.usernameSelf'));
    send('nobody');
    await vi.waitFor(() => expect(dialog().querySelector('[role=alert]').textContent).toBe(t('sharing.errNotFound')));
  });

  it('says when the platform cannot share invitations yet', async () => {
    const h = await createHarness();
    vi.setSystemTime(h.now());
    const space = await h.trip();
    const { send } = await openDialog(h, space);
    send('bob');
    await vi.waitFor(() => expect(dialog().querySelector('[role=alert]').textContent).toBe(t('sharing.errUnavailable')));
  });
});
