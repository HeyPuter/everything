import { afterEach, describe, expect, it, vi } from 'vitest';
import { USERS, WORKER, createHarness, memoryDb } from '../worker/harness.js';
import { K } from '../../worker/keys.js';
import { membersView } from '../../src/views/trip/members/index.js';
import { t } from '../../src/lib/i18n/index.js';

// jsdom's Blob has no text(); the worker reads proof files with it.
Blob.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };

const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => document.querySelector('[role=dialog]');

/** Member entities come straight from the worker's KV, as a synced replica would show them. */
function kvSpace(h, space, role) {
  const entity = (uuid) => h.kv()[K.entity(space, 'member', uuid)];
  const all = () => Object.values(USERS).map((user) => entity(user.uuid)).filter((item) => item && !item.deleted);
  return {
    ref: { w: WORKER, s: space, k: 'trip' }, role,
    get: (type, id) => (type === 'member' ? entity(id) : type === 'meta' ? { id: 'meta', title: 'Lisbon' } : undefined),
    query: () => [],
    members: () => all().map((item) => ({ uid: item.id, name: item.name, role: item.role, color: item.color, active: false, view: '' })),
    subscribe: () => () => {},
    ops: {}, apply: async () => {}, sync: async () => {},
  };
}

describe('members tab against the real worker', () => {
  afterEach(() => { dialog()?.querySelector('.modal-head .icon-btn')?.click(); document.body.replaceChildren(); vi.useRealTimers(); });

  it('creates a personal link, lists it with its label and revokes it', async () => {
    const h = await createHarness();
    // The view computes expiry from Date.now(); align it with the harness clock.
    vi.setSystemTime(h.now());
    const space = await h.trip();
    const alice = await h.client('alice');
    const container = document.createElement('div'); document.body.append(container);
    const view = membersView(container, { space: kvSpace(h, space, 'owner'), session: { api: alice.api, db: memoryDb(USERS.alice.uuid) }, account: { uuid: USERS.alice.uuid },
      puter: alice.puter, app: { navigate: vi.fn() } });
    await vi.waitFor(() => expect(container.textContent).toContain(t('members.linksEmpty')));

    byText(container, t('members.invite')).click();
    [...dialog().querySelectorAll('[role=radio]')].find((node) => node.textContent.startsWith(t('members.invitePersonal'))).click();
    const label = [...dialog().querySelectorAll('input')].find((input) => input.closest('.field')?.textContent.includes(t('members.inviteLabel')));
    label.value = 'maria@example.com';
    dialog().querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(dialog().querySelector('.invite-url')).toBeTruthy());
    const url = dialog().querySelector('.invite-url').value;
    expect(url).toMatch(new RegExp(`#/join/${WORKER}/${space}/[0-9a-f]{32}$`));
    expect(dialog().querySelector('a[href^="mailto:maria@example.com"]')).toBeTruthy();
    await vi.waitFor(() => expect(container.textContent).toContain(t('members.linkFor', { name: 'maria@example.com' })));

    const [record] = (await alice.in(space).call('invite.list')).invites;
    expect(record).toMatchObject({ label: 'maria@example.com', max: 1, role: 'editor' });
    byText(dialog(), t('members.done')).click();

    byText(container, t('members.revoke')).click();
    byText(dialog(), t('members.revoke')).click();
    await vi.waitFor(() => expect(container.textContent).toContain(t('members.linksEmpty')));
    expect(h.kv()[K.inv(space, record.id)].revoked).toBeGreaterThan(0);
    view.destroy();
  });

  it('changes roles, removes members and lets members leave', async () => {
    const h = await createHarness();
    const space = await h.team({ bob: 'editor', carol: 'editor' });
    const alice = await h.client('alice');
    const container = document.createElement('div'); document.body.append(container);
    const owner = membersView(container, { space: kvSpace(h, space, 'owner'), session: { api: alice.api }, account: { uuid: USERS.alice.uuid }, puter: alice.puter, app: { navigate: vi.fn() } });
    const menu = async (name, item) => {
      container.querySelector(`button[aria-label="${t('members.actionsFor', { name })}"]`).click();
      byText(document, item, '.menu-item').click();
    };
    await menu('carol', t('members.makeRole', { role: t('members.role.viewer') }));
    await vi.waitFor(() => expect(h.kv()[K.member(space, USERS.carol.uuid)].role).toBe('viewer'));
    await menu('carol', t('members.remove'));
    byText(dialog(), t('members.remove')).click();
    await vi.waitFor(() => expect(h.kv()[K.member(space, USERS.carol.uuid)].removed).toBeGreaterThan(0));
    owner.destroy();
    container.replaceChildren();

    h.advance(2000);
    const bob = await h.client('bob');
    const removed = [];
    const navigate = vi.fn();
    const member = membersView(container, { space: kvSpace(h, space, 'editor'), session: { api: bob.api, personal: { spaces: { remove: async (ref) => removed.push(ref) } } },
      account: { uuid: USERS.bob.uuid }, puter: bob.puter, app: { navigate } });
    byText(container, t('members.leave')).click();
    byText(dialog(), t('members.leave')).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('#/'));
    expect(removed).toEqual([{ w: WORKER, s: space, k: 'trip' }]);
    expect(h.kv()[K.member(space, USERS.bob.uuid)].removed).toBeGreaterThan(0);
    member.destroy();
  });
});
