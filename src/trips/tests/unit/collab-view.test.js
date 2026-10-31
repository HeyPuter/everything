import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { fileLinks } from '../../src/shared/file-links.js';
import { mount, unreadBadge } from '../../src/views/trip/collab/index.js';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
let seq = 0;
const makeId = () => `5${String(++seq).padStart(15, '0')}`;
const clock = createClock({ node: '0000000000000009', now: () => Date.now() });
const server = (t, id, fields, by = B) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: Date.now() - 60_000, by, cr: Date.now() - 60_000 });
const open = [];
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const tab = (container, name) => byText(container, name, '[role=tab]');

async function setup(role = 'owner') {
  const world = createFakePuter({ users: [{ uuid: A, username: 'alice' }] });
  const puter = world.client(A);
  const db = await openDatabase(A, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, makeId, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  const ids = { msg: makeId(), note: makeId(), poll: makeId(), link: makeId(), file: makeId() };
  await space.store.replace({ rev: 1, ents: [
    server('member', A, { name: 'Alice', role }), server('member', B, { name: 'Bob', role: 'editor' }),
    server('meta', 'meta', { title: 'Lisbon', currency: 'EUR' }),
    server('msg', ids.msg, { text: 'Hello **there**', author: B }),
    server('note', ids.note, { title: 'Ideas', body: '- tram 28', cat: 'Food', color: 2, author: B }),
    server('poll', ids.poll, { question: 'Dinner?', options: ['Fish', 'Pasta'], votes: { [B]: [1] }, author: B }),
    server('link', ids.link, { title: 'Guide', url: 'https://example.com/guide', author: A }, A),
    server('file', ids.file, { name: 'tram.png', mime: 'image/png', size: 2048, sha256: 'a'.repeat(64), kind: 'user', loc: { mode: 'proxied' } }),
  ] });
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = await mount(container, { route: { name: 'space', ref, tab: 'collab' }, account: { uuid: A, username: 'alice' }, space, signal: new AbortController().signal });
  open.push({ cleanup, space, db });
  return { space, container, ids, api };
}

afterEach(() => {
  for (const { cleanup, space, db } of open.splice(0)) { cleanup(); space.close(); db.close(); }
  document.body.replaceChildren();
  localStorage.clear();
});

describe('collab tab', () => {
  it('shows chat with markdown, sends a message and reacts on the caller path', async () => {
    const { space, container, ids } = await setup();
    expect(container.querySelector('.chat-text strong').textContent).toBe('there');
    expect(container.querySelector('.chat-name').textContent).toBe('Bob');
    const input = container.querySelector('.chat-input');
    input.value = 'On my way 🚆';
    container.querySelector('.chat-composer').requestSubmit();
    await vi.waitFor(() => expect(space.select.msg.all()).toHaveLength(2));
    const mine = space.select.msg.all().find((msg) => msg.text === 'On my way 🚆');
    expect(mine).toMatchObject({ author: A });
    await vi.waitFor(() => expect(container.querySelector(`[data-id="${mine.id}"] .chat-status`)).not.toBeNull());
    expect(input.value).toBe('');

    container.querySelector(`[data-id="${ids.msg}"] .chat-actions button`).click();
    const bar = container.querySelector('.chat-reactbar');
    expect(bar.getAttribute('role')).toBe('toolbar');
    bar.querySelector('button').click();
    await vi.waitFor(() => expect(space.get('msg', ids.msg).react).toEqual({ '👍': { [A]: 1 } }));
    await vi.waitFor(() => expect(container.querySelector(`[data-id="${ids.msg}"] .chat-reaction`).getAttribute('aria-pressed')).toBe('true'));
  });

  it('attaches Files-tab images to a new message through file links', async () => {
    const { space, container, ids } = await setup();
    container.querySelector('button[aria-label="Attach images"]').click();
    const dialog = await vi.waitFor(() => { const node = document.querySelector('[role=dialog]'); expect(node).not.toBeNull(); return node; });
    dialog.querySelector(`.file-pick-item[data-id="${ids.file}"]`).click();
    [...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Done').click();
    await vi.waitFor(() => expect(container.querySelector('.chat-staged').hidden).toBe(false));
    // Images need a caption.
    container.querySelector('.chat-composer').requestSubmit();
    expect(space.select.msg.all().some((msg) => !msg.text)).toBe(false);
    container.querySelector('.chat-input').value = 'Look';
    container.querySelector('.chat-composer').requestSubmit();
    await vi.waitFor(() => expect(fileLinks(space.get('file', ids.file))).toHaveLength(1));
    const sent = space.select.msg.all().find((msg) => msg.text === 'Look');
    expect(space.get('file', ids.file).linked).toEqual({ [`msg_${sent.id}`]: true });
    await vi.waitFor(() => expect(container.querySelector(`[data-id="${sent.id}"] .chat-image[title="tram.png"]`)).not.toBeNull());
    expect(container.querySelector('.chat-staged').hidden).toBe(true);
  });

  it('enlarges emoji-only messages and replies with a quote', async () => {
    const { space, container, ids } = await setup();
    container.querySelector(`[data-id="${ids.msg}"] .chat-actions button[aria-label="Reply"]`).click();
    expect(container.querySelector('.chat-context').hidden).toBe(false);
    const input = container.querySelector('.chat-input');
    input.value = '🎉🎉';
    container.querySelector('.chat-composer').requestSubmit();
    await vi.waitFor(() => expect(space.select.msg.all()).toHaveLength(2));
    const reply = space.select.msg.all().find((msg) => msg.reply === ids.msg);
    await vi.waitFor(() => expect(container.querySelector(`[data-id="${reply.id}"] .chat-jumbo`)).not.toBeNull());
    expect(container.querySelector(`[data-id="${reply.id}"] .chat-quote strong`).textContent).toBe('Bob');
  });

  it('hides poll results until the caller votes', async () => {
    const { space, container, ids } = await setup();
    tab(container, 'Polls').click();
    const card = () => container.querySelector('.poll-card');
    expect(card().querySelector('.poll-bar')).toBeNull();
    expect(card().querySelector('.poll-summary').textContent).toContain('Vote to see');
    const option = card().querySelector('button.poll-option');
    option.focus();
    option.click();
    await vi.waitFor(() => expect(space.get('poll', ids.poll).votes).toEqual({ [B]: [1], [A]: [0] }));
    await vi.waitFor(() => expect(card().querySelectorAll('.poll-bar')).toHaveLength(2));
    expect(card().querySelector('button.poll-option').getAttribute('aria-pressed')).toBe('true');
    // The card was rebuilt; focus stays on the same option.
    expect(document.activeElement).toBe(card().querySelector('button.poll-option'));
    expect(document.activeElement).not.toBe(option);
  });

  it('lists notes with a category filter and opens the expanded view', async () => {
    const { container } = await setup();
    tab(container, 'Notes').click();
    expect(container.querySelector('.note-card').dataset.color).toBe('2');
    expect(byText(container, 'Food', '.collab-filter').getAttribute('aria-pressed')).toBe('false');
    container.querySelector('.note-open').click();
    const dialog = document.querySelector('[role=dialog]');
    expect(dialog.querySelector('.modal-title').textContent).toBe('Ideas');
    expect(dialog.querySelector('li').textContent).toBe('tram 28');
  });

  it('adds a link from a bare host and titles it with the host', async () => {
    const { space, container } = await setup();
    tab(container, 'Links').click();
    const [url] = container.querySelectorAll('.link-add input');
    url.value = 'maps.example.org/route';
    container.querySelector('.link-add').requestSubmit();
    await vi.waitFor(() => expect(space.select.link.all()).toHaveLength(2));
    expect(space.select.link.all().find((link) => link.author === A && link.url.startsWith('https://maps'))).toMatchObject({ title: 'maps.example.org' });
  });

  it('keeps viewers read-only by default', async () => {
    const { container } = await setup('viewer');
    expect(container.querySelector('.chat-composer').hidden).toBe(true);
    expect(container.querySelector('.chat-readonly').hidden).toBe(false);
    tab(container, 'Polls').click();
    expect(container.querySelector('button.poll-option')).toBeNull();
  });

  it('shows the activity retention note and an empty feed', async () => {
    const { container } = await setup();
    tab(container, 'Activity').click();
    await vi.waitFor(() => expect(container.querySelector('.feed-status h3')?.textContent).toBe('No activity yet'));
    expect(container.querySelector('.feed-note').textContent).toContain('30 days');
  });
});

describe('unreadBadge', () => {
  it('shows the unread count and hides at zero', async () => {
    let count = 3;
    const listeners = new Set();
    const space = { unread: async () => count, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
    const badge = unreadBadge(space, { delay: 0 });
    await vi.waitFor(() => expect(badge.element.hidden).toBe(false));
    expect(badge.element.textContent).toBe('33 unread updates');
    count = 0;
    for (const fn of listeners) fn({ feed: false, types: new Set(['presence']), changed: new Set() });
    await vi.waitFor(() => expect(badge.element.hidden).toBe(true));
    badge.destroy();
    expect(listeners.size).toBe(0);
  });
});
