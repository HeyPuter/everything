import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { openSpaceStore } from '../../src/lib/store/space.js';
import { newId } from '../../src/shared/ids.js';
import { mount } from '../../src/views/settings/offline.js';
import { replicaKey } from '../../src/lib/offline/warm.js';
import { setForcedOffline, isForcedOffline } from '../../src/lib/offline/pwa.js';

const alice = { username: 'alice', uuid: '11111111-1111-4111-8111-111111111111' };
const ref = { w: 'trips-abcdefghij', s: newId(), k: 'trip' };
const open = [];
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);

async function setup() {
  const world = createFakePuter({ users: [alice] });
  const puter = world.client(alice);
  const db = await openDatabase(alice.uuid, { indexedDB: new IDBFactory() });
  const personal = createPersonalStore({ puter, db });
  await personal.spaces.upsert({ ref, role: 'owner', title: 'Lyon', start: '2099-05-01', end: '2099-05-04' });
  const store = await openSpaceStore({ ref, db });
  const placeId = newId();
  await store.apply([{ opId: newId(), t: 'place', id: placeId, put: { name: 'Museum', lat: 45.76, lng: 4.83 } }]);
  store.close();
  const conflict = { op: { opId: newId(), t: 'place', id: newId(), set: { name: 'Mine' }, base: 'x' }, at: Date.now(), code: 'stale',
    local: { name: 'Mine' }, server: { t: 'place', id: placeId, name: 'Theirs', v: 'y' } };
  await db.update(replicaKey(ref), (state) => ({ ...state, conflicts: [conflict] }));
  const controller = new AbortController();
  const container = document.createElement('div'); document.body.append(container);
  const session = { account: { ...alice }, db, personal };
  const cleanup = await mount(container, { route: { section: 'offline' }, account: { ...alice }, personal, puter, session, signal: controller.signal });
  open.push({ controller, cleanup });
  return { container, db, conflict };
}
afterEach(() => {
  for (const { controller, cleanup } of open.splice(0)) { controller.abort(); cleanup?.(); }
  if (isForcedOffline()) setForcedOffline(false);
  document.body.replaceChildren(); localStorage.clear();
});

describe('Settings → Offline', () => {
  it('lists trips with unsent changes and resolves parked conflicts', async () => {
    const { container, db } = await setup();
    await vi.waitFor(() => expect(container.querySelector('[data-trip]')).toBeTruthy());
    const row = container.querySelector('[data-trip]');
    expect(row.textContent).toContain('Lyon');
    expect(row.textContent).toContain('Kept automatically');
    expect(row.textContent).toContain('Unsent changes');
    expect(container.textContent).toContain('1 change is waiting to sync.');
    expect(container.textContent).toContain('Conflicts in Lyon');
    byText(container, 'Review').click();
    const dialog = document.querySelector('[role=dialog]');
    expect(dialog.textContent).toContain('Someone else changed this place');
    byText(dialog, 'Keep theirs').click();
    await vi.waitFor(() => expect(container.textContent).toContain('Nothing needs your attention.'));
    expect((await db.get(replicaKey(ref))).conflicts).toEqual([]);
  });

  it('remembers a trip the user stops keeping and switches the device offline', async () => {
    const { container, db } = await setup();
    await vi.waitFor(() => expect(container.querySelector('[data-trip] [role=switch]')).toBeTruthy());
    const keep = container.querySelector('[data-trip] [role=switch]');
    expect(keep.getAttribute('aria-label')).toBe('Keep Lyon offline');
    keep.click();
    await vi.waitFor(async () => expect((await db.get('offline:index'))?.modes).toEqual({ [`${ref.w}:${ref.s}`]: 'off' }));
    await vi.waitFor(() => expect(container.querySelector('[data-trip]').textContent).toContain('Not kept'));
    const force = byText(container, 'Work offline', '.pref-label').closest('.pref-row').querySelector('[role=switch]');
    const offline = vi.fn();
    window.addEventListener('offline', offline, { once: true });
    force.click();
    expect(navigator.onLine).toBe(false);
    expect(offline).toHaveBeenCalled();
    expect(container.textContent).toContain('Working offline.');
    force.click();
    expect(navigator.onLine).toBe(true);
  });
});
