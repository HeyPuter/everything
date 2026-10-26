import { afterEach, describe, expect, it, vi } from 'vitest';
import { USERS, WORKER, createHarness } from '../worker/harness.js';
import { createInvites } from '../../src/lib/invites.js';
import { createInboxEntry } from '../../src/views/join/entry.js';
import { t } from '../../src/lib/i18n/index.js';

// jsdom's Blob has no text(); the worker reads proof files with it.
Blob.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };

const byText = (root, text) => [...root.querySelectorAll('button')].find((node) => node.textContent.trim() === text);

describe('invitations inbox', () => {
  afterEach(() => document.body.replaceChildren());

  it('stays hidden without a session, then lists, accepts and opens named invites', async () => {
    const h = await createHarness({ shareHandles: true });
    vi.setSystemTime(h.now());
    const space = await h.trip();
    await (await h.client('alice')).in(space).call('invite.create', { role: 'viewer', named: 'carol' });
    const carol = await h.client('carol');
    const upserts = [];
    const spaces = { list: async () => [], upsert: async (entry) => { upserts.push(entry); return entry; } };
    let session = null;
    const navigate = vi.fn();
    const entry = createInboxEntry(() => ({ app: { navigate }, session }));
    document.body.append(entry.element);
    expect(entry.element.hidden).toBe(true);

    session = { invites: createInvites({ puter: carol.puter, api: carol.api, spaces }) };
    expect(entry.element.hidden).toBe(false);
    await vi.waitFor(() => expect(entry.element.getAttribute('aria-label')).toBe(t('join.inboxCount', { count: '1' })));

    entry.element.click();
    const dialog = await vi.waitFor(() => { const node = document.querySelector('[role=dialog]'); expect(node).toBeTruthy(); return node; });
    await vi.waitFor(() => expect(dialog.textContent).toContain('Lisbon'));
    byText(dialog, t('join.inboxAccept')).click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`#/t/${WORKER}/${space}`));
    expect(upserts[0]).toMatchObject({ ref: { w: WORKER, s: space, k: 'trip' }, role: 'viewer' });
    expect(h.kv()[`sp:${space}:m:${USERS.carol.uuid}`].role).toBe('viewer');
    entry.destroy();
    vi.useRealTimers();
  });
});
