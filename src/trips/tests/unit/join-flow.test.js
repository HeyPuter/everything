import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER, createHarness } from '../worker/harness.js';
import { mount } from '../../src/views/join/index.js';
import { t } from '../../src/lib/i18n/index.js';

const button = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);

async function joinView(h, name, space, token, { spaces = [] } = {}) {
  const client = await h.client(name);
  const container = document.createElement('div'); document.body.append(container);
  const upserts = [];
  const personal = { spaces: { list: async () => spaces, upsert: async (entry) => { upserts.push(entry); return entry; } } };
  const app = { navigate: vi.fn() };
  const controller = new AbortController();
  await mount(container, { route: { name: 'join', worker: WORKER, space, token }, session: { api: client.api, personal }, app, signal: controller.signal });
  return { container, app, upserts, controller };
}

// jsdom's Blob has no text(); the worker reads proof files with it.
Blob.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };

describe('join flow against the real worker', () => {
  afterEach(() => document.body.replaceChildren());

  it('previews the invite, joins on confirmation and opens the trip', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const { token } = await (await h.client('alice')).in(space).call('invite.create', { role: 'editor' });
    const { container, app, upserts } = await joinView(h, 'bob', space, token);
    expect(container.querySelector('.join-title').textContent).toBe('Lisbon');
    expect(container.textContent).toContain(t('join.invited', { owner: 'alice', role: t('members.roleLower.editor') }));
    expect(container.textContent).toContain(t('members.roleHint.editor'));
    button(container, t('join.accept')).click();
    await vi.waitFor(() => expect(app.navigate).toHaveBeenCalledWith(`#/t/${WORKER}/${space}`, { replace: true }));
    expect(upserts).toEqual([{ ref: { w: WORKER, s: space, k: 'trip' }, role: 'editor', title: 'Lisbon', files: { mode: 'direct', uid: expect.any(String), inbox: expect.any(String) } }]);
  });

  it.each([['collection', { name: 'Lisbon food' }, 'collections'], ['journey', { title: 'Lisbon diary' }, 'journey']])('uses the %s role hints', async (kind, meta, module) => {
    const h = await createHarness();
    const alice = await h.client('alice');
    const { space } = await alice.call('space.create', { kind, meta });
    const { token } = await alice.in(space).call('invite.create', { role: 'viewer' });
    const { container } = await joinView(h, 'bob', space, token);
    expect(container.textContent).toContain(t(`${module}.roleHint.viewer`));
    expect(container.textContent).not.toContain(t('members.roleHint.viewer'));
  });

  it('explains revoked and used-up links', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const alice = (await h.client('alice')).in(space);
    const revoked = await alice.call('invite.create', { role: 'viewer' });
    await alice.call('invite.revoke', { id: revoked.invite.id });
    const first = await joinView(h, 'bob', space, revoked.token);
    expect(first.container.querySelector('[role=alert]').textContent).toBe(t('members.errRevoked'));
    expect(button(first.container, t('members.retry'))).toBeUndefined();
    const once = await alice.call('invite.create', { role: 'viewer', max: 1 });
    await (await h.client('carol')).in(space).call('join', { token: once.token });
    const second = await joinView(h, 'dave', space, once.token);
    expect(second.container.querySelector('[role=alert]').textContent).toBe(t('members.errUsed'));
  });

  it('offers to open a trip the user already belongs to', async () => {
    const h = await createHarness();
    const space = await h.trip();
    const ref = { w: WORKER, s: space, k: 'trip' };
    const { container, app } = await joinView(h, 'bob', space, 'b'.repeat(32), { spaces: [{ ref, role: 'viewer', title: 'Lisbon' }] });
    expect(container.querySelector('.join-title').textContent).toBe(t('join.already'));
    button(container, t('join.open')).click();
    expect(app.navigate).toHaveBeenCalledWith(`#/t/${WORKER}/${space}`, { replace: true });
  });
});
