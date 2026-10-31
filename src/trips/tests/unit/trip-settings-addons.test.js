import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { openSpace } from '../../src/lib/store/index.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { ApiError } from '../../src/lib/api.js';
import { createClock } from '../../src/shared/hlc.js';
import { mount } from '../../src/views/trip/settings/index.js';

const me = '00000000-0000-4000-8000-000000000001';
const ref = { w: 'trips-012345abcd', s: '0000000000000001', k: 'trip' };
const clock = createClock({ node: '0000000000000007', now: () => 1_000_000 });
const server = (t, id, fields) => ({ t, id, ...fields, v: clock.tick(), rev: 1, upd: 1000, by: me, cr: 1000 });
const day = '1000000000000001';
const open = [];
const roadSwitch = (container) => container.querySelector('[role=switch][aria-label="Road trip mode"]');

async function setup({ role = 'owner' } = {}) {
  const world = createFakePuter({ users: [{ uuid: me, username: 'me' }] });
  const puter = world.client(me);
  const db = await openDatabase(me, { indexedDB: new IDBFactory() });
  const api = { commit: vi.fn(async () => { throw new ApiError(0, 'network'); }), call: vi.fn(async () => ({ rev: 1, changes: [] })), snapshot: vi.fn() };
  const personal = createPersonalStore({ puter, db });
  const space = await openSpace({ ref, db, api, puter, personal, role, setTimer: () => 0, clearTimer: () => {}, document: null, window: null, open: false });
  await space.store.replace({ rev: 1, ents: [server('meta', 'meta', { title: 'Alps', currency: 'EUR' }), server('member', me, { name: 'Me', role }), server('day', day, { order: 'a', date: '2027-06-01' })] });
  const container = document.createElement('div');
  document.body.append(container);
  const controller = new AbortController();
  const cleanup = mount(container, { space, session: { personal }, puter, app: { navigate: vi.fn() }, signal: controller.signal });
  open.push({ space, cleanup, controller, db });
  await vi.waitFor(() => expect(roadSwitch(container)).not.toBeNull());
  return { space, container };
}
afterEach(() => {
  for (const { space, cleanup, controller, db } of open.splice(0)) { controller.abort(); cleanup(); space.close(); db.close(); }
  document.body.replaceChildren();
});

describe('trip settings add-ons', () => {
  it('turns road trip mode on, with walking days becoming driving days, and off after confirming', async () => {
    const { space, container } = await setup();
    expect(roadSwitch(container).getAttribute('aria-checked')).toBe('false');
    roadSwitch(container).click();
    await vi.waitFor(() => expect(space.get('meta', 'meta').settings?.addons?.roadtrip).toBe(true));
    expect(space.get('day', day).mode).toBe('drive');
    await vi.waitFor(() => expect(roadSwitch(container).getAttribute('aria-checked')).toBe('true'));

    roadSwitch(container).click();
    const dialog = await vi.waitFor(() => { const node = document.querySelector('[role=dialog]'); expect(node).not.toBeNull(); return node; });
    [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Turn off road trip mode').click();
    await vi.waitFor(() => expect(space.get('meta', 'meta').settings.addons.roadtrip).toBe(false));
  });

  it('keeps the switch on when turning off is cancelled, and disables it for viewers', async () => {
    const { space, container } = await setup();
    await space.apply([space.ops.patch('meta', 'meta', { set: { 'settings.addons.roadtrip': true } })]);
    await vi.waitFor(() => expect(roadSwitch(container).getAttribute('aria-checked')).toBe('true'));
    roadSwitch(container).click();
    const dialog = await vi.waitFor(() => { const node = document.querySelector('[role=dialog]'); expect(node).not.toBeNull(); return node; });
    [...dialog.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Cancel').click();
    await vi.waitFor(() => expect(roadSwitch(container).getAttribute('aria-checked')).toBe('true'));
    expect(space.get('meta', 'meta').settings.addons.roadtrip).toBe(true);

    const viewer = await setup({ role: 'viewer' });
    expect(roadSwitch(viewer.container).disabled).toBe(true);
  });
});
