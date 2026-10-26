import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createApp } from '../../src/main.js';
import { resolveStartPage, startPageHash } from '../../src/lib/start-page.js';
import { parseRoute, routeHash, defaultTripTab } from '../../src/lib/router.js';
import { bindPrefs, setPrefs } from '../../src/lib/prefs.js';

const alice = '11111111-1111-4111-8111-111111111111';
const ref = (s, k = 'trip') => ({ w: 'trips-abcdefghij', s, k });
const spaces = [
  { ref: ref('0000000000000001'), role: 'owner', title: 'Past', start: '2026-05-01', end: '2026-05-09', opened: 300 },
  { ref: ref('0000000000000002'), role: 'editor', title: 'Now', start: '2026-10-20', end: '2026-10-30', opened: 100 },
  { ref: ref('0000000000000003'), role: 'viewer', title: 'Also now', start: '2026-10-24', opened: 200 },
  { ref: ref('0000000000000004', 'collection'), role: 'owner', title: 'Collection', start: '2026-10-01', end: '2026-12-31', opened: 900 },
  { ref: ref('0000000000000005'), role: 'owner', title: 'Never opened', start: '2027-01-01', end: '2027-01-05' },
];
let binding;
function bind(value = {}) {
  binding = bindPrefs({ personal: { get: async () => value, patchPreferences: async () => {} }, account: alice, debounce: 10_000 });
  return binding.ready;
}
beforeEach(() => localStorage.clear());
afterEach(() => { binding?.close(); binding = null; localStorage.clear(); });

describe('start page', () => {
  it('opens the trip opened most recently', () => {
    expect(resolveStartPage({ startPage: 'last', spaces, today: '2026-10-24' })).toBe('#/t/trips-abcdefghij/0000000000000001');
    expect(resolveStartPage({ startPage: 'last', spaces: spaces.slice(3), today: '2026-10-24' })).toBeNull();
  });
  it('opens a trip under way today, the most recently opened when several are', () => {
    expect(resolveStartPage({ startPage: 'current', spaces, today: '2026-10-24' })).toBe('#/t/trips-abcdefghij/0000000000000003');
    expect(resolveStartPage({ startPage: 'current', spaces, today: '2026-10-25' })).toBe('#/t/trips-abcdefghij/0000000000000002');
    expect(resolveStartPage({ startPage: 'current', spaces, today: '2026-10-30' })).toBe('#/t/trips-abcdefghij/0000000000000002');
    expect(resolveStartPage({ startPage: 'current', spaces, today: '2026-11-15' })).toBeNull();
    expect(resolveStartPage({ startPage: 'current', spaces, today: 'soon' })).toBeNull();
  });
  it('stays on the dashboard for `trips` and for unusable entries', () => {
    expect(resolveStartPage({ startPage: 'trips', spaces, today: '2026-10-24' })).toBeNull();
    expect(resolveStartPage({ startPage: 'last', spaces: [{ ref: { w: 'evil.com', s: 'x', k: 'trip' }, opened: 5 }, null], today: '2026-10-24' })).toBeNull();
    expect(resolveStartPage({ startPage: 'last', spaces: undefined, today: '2026-10-24' })).toBeNull();
  });
  it('reads the preference and the trips list once preferences are ready', async () => {
    await bind({ startPage: 'last' });
    const personal = { spaces: { list: vi.fn(async () => spaces) } };
    expect(await startPageHash({ personal, ready: binding.ready })).toBe('#/t/trips-abcdefghij/0000000000000001');
    personal.spaces.list.mockRejectedValueOnce(new Error('offline'));
    expect(await startPageHash({ personal, ready: binding.ready })).toBeNull();
    personal.spaces.list.mockImplementationOnce(() => new Promise(() => {}));
    expect(await startPageHash({ personal, ready: binding.ready, timeout: 10 })).toBeNull();
  });
  it('applies at boot only when the address has no hash', async () => {
    const world = createFakePuter({ users: [{ username: 'alice', uuid: alice }] });
    const puter = world.client({ username: 'alice', uuid: alice });
    await puter.kv.set('me:prefs', { startPage: 'last', tripTab: 'costs' });
    await puter.kv.set('me:spaces', spaces);
    const boot = async (hash) => {
      window.history.replaceState(null, '', `/${hash}`);
      const root = document.createElement('div'); document.body.append(root);
      const indexedDB = new IDBFactory();
      const app = createApp({ root, puter, openDatabase: (account) => openDatabase(account, { indexedDB }), mac: false });
      await app.start();
      const { route } = app.state; app.destroy(); root.remove();
      return { hash: window.location.hash, route };
    };
    expect(await boot('')).toMatchObject({ hash: '#/t/trips-abcdefghij/0000000000000001', route: { name: 'space', tab: 'costs' } });
    expect(await boot('#/settings/general')).toMatchObject({ hash: '#/settings/general' });
    window.history.replaceState(null, '', '/');
  });
  it('does not read the trips list for the dashboard', async () => {
    await bind({});
    const personal = { spaces: { list: vi.fn(async () => spaces) } };
    expect(await startPageHash({ personal, ready: binding.ready })).toBeNull();
    expect(personal.spaces.list).not.toHaveBeenCalled();
  });
});

describe('default trip tab', () => {
  it('opens a trip link without a tab on the preferred tab', async () => {
    const trip = ref('0000000000000001');
    expect(parseRoute('#/t/trips-abcdefghij/0000000000000001')).toEqual({ name: 'space', ref: trip, tab: 'plan' });
    await bind({ tripTab: 'lists' });
    expect(defaultTripTab()).toBe('lists');
    expect(parseRoute('#/t/trips-abcdefghij/0000000000000001')).toEqual({ name: 'space', ref: trip, tab: 'lists' });
    expect(parseRoute('#/t/trips-abcdefghij/0000000000000001/files').tab).toBe('files');
    expect(routeHash({ name: 'space', ref: trip })).toBe('#/t/trips-abcdefghij/0000000000000001/lists');
    setPrefs({ tripTab: 'costs' });
    expect(parseRoute('#/t/trips-abcdefghij/0000000000000001').tab).toBe('costs');
  });
  it('falls back to the plan tab for a tab this build does not have', async () => {
    await bind({ tripTab: 'journal' });
    expect(defaultTripTab()).toBe('plan');
    expect(parseRoute('#/t/trips-abcdefghij/0000000000000001').tab).toBe('plan');
  });
});
