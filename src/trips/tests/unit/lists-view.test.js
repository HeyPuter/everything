import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { ApiError } from '../../src/lib/api.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createClock } from '../../src/shared/hlc.js';
import { strings } from '../../src/lib/i18n/index.js';
import { mount } from '../../src/views/trip/lists/index.js';
import { starterKeys, starters } from '../../src/views/trip/lists/starters.js';
import { validateTemplate } from '../../src/views/settings/data/templates.js';

const uid = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: bob, cr: 1000 });
const open = [];
const frame = () => new Promise((resolve) => setTimeout(resolve, 40));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);

async function view({ role = 'editor', ents = [] } = {}) {
  const world = createFakePuter({ users: [{ uuid: uid, username: 'me' }] });
  const puter = world.client(uid);
  const db = await openDatabase(uid, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Lisbon', currency: 'EUR' }), server('member', uid, { name: 'Me', role }), server('member', bob, { name: 'Bob', role: 'editor' }), ...ents] });
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const cleanup = mount(container, { space, account: { uuid: uid }, personal, puter, signal: controller.signal });
  open.push({ controller, cleanup, space });
  await frame();
  return { space, container, personal };
}
afterEach(() => {
  for (const { controller, cleanup, space } of open.splice(0)) { controller.abort(); cleanup?.(); space.close(); }
  document.body.replaceChildren();
  localStorage.clear();
});

describe('lists tab', () => {
  it('shows a placeholder without a trip space', () => {
    const container = document.createElement('div');
    mount(container, { account: { uuid: uid } });
    expect(container.textContent).toContain(strings['lists.unavailableTitle']);
  });

  it('adds lists and items, checks them and keeps private items in my list', async () => {
    const list = '1000000000000001';
    const { space, container } = await view({ ents: [server('listMeta', list, { kind: 'pack', name: 'Clothes', order: 'a', color: 2 })] });
    const pane = container.querySelectorAll('.lists-pane')[0];
    expect(pane.querySelector('.list-group-title').textContent).toBe('Clothes');
    const input = pane.querySelector('.lists-composer-input');
    input.value = '3x Socks';
    input.closest('form').requestSubmit();
    await vi.waitFor(() => expect(space.select.pack.all()).toHaveLength(1));
    const item = space.select.pack.all()[0];
    expect(item).toMatchObject({ name: 'Socks', qty: 3, list: 'Clothes', owner: uid });
    const check = pane.querySelector('.lists-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(pane.querySelector('.lists-progress-text').textContent).toContain('1 of 1 packed'));
    expect(space.get('pack', item.id).done).toBe(true);

    byText(pane, strings['lists.viewMine']).click();
    await frame();
    const privateInput = pane.querySelector('.lists-composer-input');
    privateInput.value = 'Diary';
    privateInput.closest('form').requestSubmit();
    await vi.waitFor(() => expect(space.privateItems('pack').list()).toEqual([expect.objectContaining({ name: 'Diary', list: 'Clothes', private: true })]));
    await vi.waitFor(() => expect(pane.textContent).toContain(strings['lists.private']));
    expect(space.select.pack.all()).toHaveLength(1);
  });

  it('switches per-person checks and bag tracking for the trip', async () => {
    const { space, container } = await view({ role: 'owner' });
    container.querySelector(`[aria-label="${strings['lists.packMore']}"]`).click();
    byText(document, strings['lists.perPerson'], '[role=menuitemcheckbox]').click();
    await vi.waitFor(() => expect(space.get('meta', 'meta').settings).toEqual({ perPersonPacking: true }));
    container.querySelector(`[aria-label="${strings['lists.packMore']}"]`).click();
    byText(document, strings['lists.bagTracking'], '[role=menuitemcheckbox]').click();
    await vi.waitFor(() => expect(space.get('meta', 'meta').settings).toEqual({ perPersonPacking: true, bagTracking: false }));
    await vi.waitFor(() => expect(container.querySelector('.lists-bags')).toBeNull());
  });

  it('keeps viewers to pledges, per-person checks and private items', async () => {
    const item = '2000000000000001';
    const { space, container } = await view({ role: 'viewer', ents: [server('pack', item, { name: 'Tent', order: 'a' })] });
    const pane = container.querySelectorAll('.lists-pane')[0];
    expect(pane.querySelector('.lists-composer-input')).toBeNull();
    expect(pane.querySelector('.lists-check').disabled).toBe(true);
    await space.store.receive([{ rev: 2, at: 2, by: bob, ents: [server('meta', 'meta', { title: 'Lisbon', currency: 'EUR', settings: { perPersonPacking: true } })], del: [] }]);
    await vi.waitFor(() => expect(pane.querySelector('.lists-check').disabled).toBe(false));
    const check = pane.querySelector('.lists-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(space.get('pack', item).doneBy).toEqual({ [uid]: true }));
  });

  it('adds to-dos, flags overdue ones and counts them on the tab', async () => {
    const list = '3000000000000001';
    const { space, container } = await view({ ents: [
      server('listMeta', list, { kind: 'todo', name: 'Before', order: 'a' }),
      server('todo', '3000000000000002', { name: 'Visa', order: 'a', list: 'Before', due: '2000-01-01', prio: 1 }),
    ] });
    const pane = container.querySelectorAll('.lists-pane')[1];
    expect(pane.textContent).toContain('P1');
    expect(pane.querySelector('.lists-overdue')).not.toBeNull();
    expect(container.querySelector('.lists-badge').textContent).toBe('1');
    const input = pane.querySelector('.lists-composer-input');
    input.value = 'Insurance';
    input.closest('form').requestSubmit();
    await vi.waitFor(() => expect(space.select.todo.all().map((todo) => todo.name)).toEqual(['Visa', 'Insurance']));
    expect(space.select.todo.all()[1]).toMatchObject({ list: 'Before' });
  });
});

describe('starter templates', () => {
  it('uses defined strings and valid template shapes', () => {
    expect(starterKeys().filter((key) => !Object.hasOwn(strings, key))).toEqual([]);
    for (const kind of ['pack', 'todo']) for (const starter of starters(kind)) expect(() => validateTemplate(starter)).not.toThrow();
  });
});
