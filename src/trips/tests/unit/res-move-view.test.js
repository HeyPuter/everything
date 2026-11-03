import { afterEach, describe, expect, it } from 'vitest';
import { createSelectors } from '../../src/lib/store/query.js';
import { can } from '../../src/shared/perms.js';
import { moveNotices, openMoveDialog } from '../../src/views/trip/bookings/move/index.js';
import { moveJournal } from '../../src/views/trip/bookings/move/run.js';

const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const dialog = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
const ref = { w: 'trips-aaaaaaaaaa', s: 's000000000000001', k: 'trip' };

function memoryDb() {
  const map = new Map();
  return { account: ALICE, get: async (key) => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, value); },
    update: async (key, change) => { const value = change(structuredClone(map.get(key))); if (value === undefined) map.delete(key); else map.set(key, value); return value; } };
}

function stubSpace(ents) {
  const data = new Map();
  for (const { t, ...entity } of ents) { if (!data.has(t)) data.set(t, new Map()); data.get(t).set(entity.id, Object.freeze({ v: 'v1', ...entity })); }
  const get = (type, id) => data.get(type)?.get(id);
  return {
    ref,
    select: createSelectors({ kind: 'trip', source: (type) => [...(data.get(type)?.values() ?? [])], get, subscribe: () => () => {} }),
    get, can: (action) => can('editor', action, {}),
    members: () => [{ uid: ALICE, name: 'Alice' }, { uid: BOB, name: 'Bob' }],
    store: { serverVersion: (type, id) => get(type, id)?.v },
    subscribe: () => () => {}, flush: async () => {}, sync: async () => {}, overlay: () => ({ pending: false }),
  };
}

const track = (value) => value;
afterEach(() => { for (const node of document.querySelectorAll('.modal-root')) node.remove(); });

describe('move booking dialog', () => {
  const res = { t: 'res', id: 'r000000000000001', type: 'lodging', title: 'Hotel Sol', status: 'confirmed', start: { date: '2027-05-01' }, end: { date: '2027-05-03' }, placeId: 'p000000000000001', people: [ALICE, BOB] };
  const space = stubSpace([
    { t: 'meta', id: 'meta', title: 'Lisbon', currency: 'EUR' }, res,
    { t: 'place', id: 'p000000000000001', name: 'Hotel Sol' },
    { t: 'exp', id: 'e000000000000001', name: 'Hotel', amount: 100, currency: 'EUR', payers: [{ who: ALICE, amount: 100 }], split: { mode: 'equal', parts: [{ who: ALICE }, { who: BOB }] }, links: [{ t: 'res', id: res.id }] },
  ]);

  it('lists trips the user can edit plus a new trip, and previews a move to a new trip', async () => {
    const personal = { spaces: { list: async () => [
      { ref: { w: 'trips-bbbbbbbbbb', s: 's000000000000002', k: 'trip' }, title: 'Porto', role: 'editor' },
      { ref: { w: 'trips-bbbbbbbbbb', s: 's000000000000003', k: 'trip' }, title: 'Viewing only', role: 'viewer' },
      { ref, title: 'Lisbon', role: 'owner' },
    ] } };
    const session = { db: memoryDb(), api: {}, deployer: { ensure: async () => ({ worker: { name: 'trips-cccccccccc' } }) }, account: { uuid: ALICE } };
    openMoveDialog({ space, session, puter: {}, personal, res: space.get('res', res.id), track });
    await tick();
    const select = dialog().querySelector('select');
    expect([...select.options].map((option) => option.textContent)).toEqual(['Choose a trip', 'Porto', 'A new trip…']);
    select.value = 'new';
    select.dispatchEvent(new Event('change'));
    await tick();
    const text = dialog().querySelector('.move-preview').textContent;
    // A new trip has only its creator, so Bob leaves the booking and the shared expense cannot move.
    expect(text).toContain('Not in Hotel Sol, so removed from this booking: Bob.');
    expect(text).toContain('Adds the place “Hotel Sol” to Hotel Sol.');
    expect(text).toContain('One linked expense stays here, unlinked');
    expect(dialog().querySelector('.move-preview input[type=checkbox]')).toBeNull();
    expect([...dialog().querySelectorAll('button')].find((node) => node.textContent === 'Move booking').disabled).toBe(false);
  });
});

describe('unfinished move notices', () => {
  it('shows an unfinished move with finish, undo and keep-both actions', async () => {
    const db = memoryDb();
    const journal = moveJournal(db, ref.s);
    await journal.put({ id: 'm000000000000001', stage: 'source', at: Date.now(), title: 'Hotel Sol', toTitle: 'Porto', from: ref, to: ref, created: [], files: [], copied: {} });
    const notices = moveNotices({ space: stubSpace([]), session: { db, api: {} }, puter: {}, personal: null });
    document.body.append(notices.element);
    await tick();
    expect(notices.element.hidden).toBe(false);
    expect(notices.element.textContent).toContain('“Hotel Sol” was copied to Porto but is still here too.');
    const keep = [...notices.element.querySelectorAll('button')].find((node) => node.textContent === 'Keep both');
    keep.click();
    await tick(); await tick();
    expect(await journal.list()).toEqual([]);
    expect(notices.element.hidden).toBe(true);
    notices.destroy();
    notices.element.remove();
  });
});
