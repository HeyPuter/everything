import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { applyTheme } from '../../src/ui/theme.js';
import {
  bindPrefs, cleanPrefs, defaultPrefs, prefs, onPrefs, setPrefs, prefsStatus, onPrefsStatus, prefsBound, retryPrefs, dashboardWidgets, mapPrefs, aiPrefs,
  prefersReducedMotion, displayLocale,
} from '../../src/lib/prefs.js';

const alice = { username: 'alice', uuid: '11111111-1111-4111-8111-111111111111' };
const bindings = [];
class FakeWindow extends EventTarget {
  constructor() { super(); this.navigator = { onLine: true }; }
  go(online) { this.navigator.onLine = online; this.dispatchEvent(new Event(online ? 'online' : 'offline')); }
}
async function setup({ world = createFakePuter({ users: [alice] }), indexedDB = new IDBFactory(), win = new FakeWindow(), debounce = 0 } = {}) {
  const puter = world.client(alice);
  const db = await openDatabase(alice.uuid, { indexedDB });
  const personal = createPersonalStore({ puter, db, window: win });
  const binding = bindPrefs({ personal, account: alice.uuid, window: win, debounce });
  bindings.push(binding);
  await binding.ready;
  return { world, puter, db, personal, binding, win, indexedDB };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const pendingKey = `trips:prefs:pending:${alice.uuid}`;
// A personal store double whose account value and notifications the test controls.
function stubPersonal(initial = {}) {
  let cloud = { ...initial };
  const listeners = new Set();
  return {
    get cloud() { return cloud; },
    set cloud(value) { cloud = value; },
    get: vi.fn(async () => ({ ...cloud })),
    refresh: vi.fn(async () => ({ ...cloud })),
    patchPreferences: vi.fn(async (patch) => { cloud = { ...cloud, ...patch }; return { ...cloud }; }),
    subscribe: vi.fn((key, listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
    emit(value) { for (const listener of listeners) listener(value); },
  };
}
function bind(personal, win = new FakeWindow()) {
  const binding = bindPrefs({ personal, account: alice.uuid, window: win, debounce: 0 });
  bindings.push(binding);
  return binding;
}

beforeEach(() => { localStorage.clear(); applyTheme('system'); });
afterEach(() => { bindings.splice(0).forEach((binding) => binding.close()); localStorage.clear(); document.documentElement.removeAttribute('style'); });

describe('preference values', () => {
  it('keeps only known keys with valid values', () => {
    expect(cleanPrefs({ theme: 'dark', textSize: 1.25, contrast: 'loud', distanceUnit: 'mi', currency: 'eur', tripTab: 'Lists', unknown: 1, tips: { welcome: true, bad: 1, 'x y': true } }))
      .toEqual({ theme: 'dark', textSize: 1.3, distanceUnit: 'mi', tips: { welcome: true } });
    expect(cleanPrefs({ textSize: 2, currency: null, widgetsPhone: { order: ['fx', 'stats', 'fx', 'Bad'], hidden: ['clocks'] } }))
      .toEqual({ currency: null, widgetsPhone: { order: ['fx', 'stats', 'upcoming', 'clocks', 'collections', 'atlas'], hidden: ['clocks'] } });
    expect(cleanPrefs(null)).toEqual({}); expect(cleanPrefs([])).toEqual({});
  });
  it.each([
    ['en-US', 'mi', 'f', 'lb'], ['en-GB', 'mi', 'c', 'kg'], ['de-DE', 'km', 'c', 'kg'], ['en-LR', 'mi', 'f', 'lb'], ['fr', 'km', 'c', 'kg'],
  ])('defaults units from the %s region', (locale, distanceUnit, tempUnit, weightUnit) => {
    expect(defaultPrefs(locale)).toMatchObject({ distanceUnit, tempUnit, weightUnit, dateFormat: 'auto', assistantApproval: 'destructive', aiModel: 'claude-sonnet-5-5' });
  });
  it('formats in the UI language with the browser region', () => {
    expect(displayLocale({ languages: ['zz-invalid-!', 'de-AT'] })).toBe('en-AT');
    expect(displayLocale({ languages: ['de-AT', 'en-GB'], language: 'de-AT' })).toBe('en-GB');
    expect(displayLocale({})).toBe('en');
  });
  it('derives consumer views', () => {
    const value = { ...defaultPrefs('en-GB'), mapStyle: 'satellite', widgetsPhone: { order: ['clocks', 'fx', 'upcoming'], hidden: ['fx'] }, motion: 'reduce' };
    expect(mapPrefs(value)).toMatchObject({ basemap: 'satellite', theme: null, optimizeFromHotel: true });
    expect(mapPrefs({ ...value, mapStyle: 'dark' })).toMatchObject({ basemap: 'map', theme: 'dark' });
    expect(dashboardWidgets('phone', value)).toEqual([{ id: 'clocks', visible: true }, { id: 'fx', visible: false }, { id: 'upcoming', visible: true }]);
    expect(aiPrefs(value)).toEqual({ model: 'claude-sonnet-5-5', quickModel: 'claude-haiku-5-5', approval: 'destructive' });
    expect(prefersReducedMotion(value, {})).toBe(true);
  });
});

describe('bindPrefs', () => {
  it('refuses writes until a session is bound', () => {
    expect(prefsBound()).toBe(false);
    expect(() => setPrefs({ theme: 'dark' })).toThrow(expect.objectContaining({ code: 'prefs_unbound' }));
  });
  it('loads the account value and applies appearance', async () => {
    const world = createFakePuter({ users: [alice] });
    await world.client(alice).kv.set('me:prefs', { textSize: 1.4, contrast: 'more', motion: 'reduce', distanceUnit: 'mi', extra: 'kept' });
    await setup({ world });
    expect(prefs()).toMatchObject({ textSize: 1.4, contrast: 'more', distanceUnit: 'mi' });
    expect(Object.isFrozen(prefs())).toBe(true);
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--text-scale')).toBe('1.4');
    expect(root.dataset).toMatchObject({ contrast: 'more', motion: 'reduce' });
    expect(JSON.parse(localStorage.getItem('trips:appearance'))).toEqual({ textSize: 1.4, contrast: 'more', motion: 'reduce', density: 'comfortable', accent: 'blue' });
  });
  it('applies a change at once and writes only the changed keys', async () => {
    const { world, binding } = await setup();
    const seen = vi.fn(); const off = onPrefs(seen);
    const before = world.counters().calls['kv.update'] ?? 0;
    setPrefs({ theme: 'dark', weightUnit: 'kg' }); // jsdom is en-US, so the default is lb
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('trips:theme')).toBe('dark');
    expect(prefs().weightUnit).toBe('kg');
    expect(seen).toHaveBeenCalledWith(prefs(), new Set(['theme', 'weightUnit']));
    expect(binding.localTheme()).toBe('dark');
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(world.counters().calls['kv.update'] - before).toBe(1);
    expect(world.inspectKv('alice')['me:prefs']).toEqual({ theme: 'dark', weightUnit: 'kg' });
    expect(binding.localTheme()).toBeUndefined();
    expect(localStorage.getItem(`trips:prefs:pending:${alice.uuid}`)).toBeNull();
    off();
  });
  it('rejects unknown keys and invalid values without changing anything', async () => {
    await setup();
    expect(() => setPrefs({ theme: 'neon' })).toThrow(TypeError);
    expect(() => setPrefs({ admin: true })).toThrow(TypeError);
    expect(prefs().theme).toBe('system');
  });
  it('keeps offline changes on the device and sends them on reconnect', async () => {
    const { world, win } = await setup();
    win.go(false);
    setPrefs({ dateFormat: 'iso' });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('offline'));
    expect(world.counters().calls['kv.update'] ?? 0).toBe(0);
    expect(JSON.parse(localStorage.getItem(`trips:prefs:pending:${alice.uuid}`))).toEqual({ dateFormat: 'iso' });
    win.go(true);
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(world.inspectKv('alice')['me:prefs'].dateFormat).toBe('iso');
  });
  it('resends a change left unsaved by an earlier session', async () => {
    const world = createFakePuter({ users: [alice] }); const indexedDB = new IDBFactory();
    world.setOffline('alice', true);
    const first = await setup({ world, indexedDB });
    setPrefs({ timeFormat: '24' });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('offline'));
    first.binding.close();
    world.setOffline('alice', false);
    await setup({ world, indexedDB });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(world.inspectKv('alice')['me:prefs'].timeFormat).toBe('24');
    expect(prefs().timeFormat).toBe('24');
  });
  it.each([[402, 'credit'], [403, 'forbidden'], [409, 'conflict'], [500, 'failed']])('explains a %s and retries', async (status, code) => {
    const { world } = await setup();
    world.failNext({ method: 'kv.update', status, code: 'x' });
    setPrefs({ blurCodes: true });
    await vi.waitFor(() => expect(prefsStatus()).toEqual({ state: 'error', code }));
    expect(prefs().blurCodes).toBe(true);
    await retryPrefs();
    expect(prefsStatus().state).toBe('saved');
    expect(world.inspectKv('alice')['me:prefs'].blurCodes).toBe(true);
  });
  it('shows saving at once and retries a transient failure by itself', async () => {
    const { world } = await setup({ debounce: 20 });
    world.failNext({ method: 'kv.update', status: 503, code: 'x' });
    setPrefs({ mapExplorePills: false });
    expect(prefsStatus().state).toBe('saving');
    await vi.waitFor(() => expect(prefsStatus()).toEqual({ state: 'error', code: 'failed' }));
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'), { timeout: 3000 });
    expect(world.inspectKv('alice')['me:prefs'].mapExplorePills).toBe(false);
  });
  it('reports a failed load and falls back to this device', async () => {
    const world = createFakePuter({ users: [alice] });
    world.failNext({ method: 'kv.get', status: 500, code: 'x' });
    localStorage.setItem('trips:appearance', JSON.stringify({ textSize: 1.2 }));
    const { binding } = await setup({ world });
    expect(prefsStatus()).toEqual({ state: 'error', code: 'load' });
    expect(prefs().textSize).toBe(1.2);
    await binding.retry();
    expect(prefsStatus().state).toBe('idle');
  });
  it('follows changes from another session through events, including the theme', async () => {
    const world = createFakePuter({ users: [alice] });
    const { personal } = await setup({ world });
    const other = createPersonalStore({ puter: world.client(alice), db: await openDatabase(alice.uuid, { indexedDB: new IDBFactory() }) });
    await other.patchPreferences({ theme: 'dark', tempUnit: 'f' });
    await world.flushEvents(); await settle();
    await vi.waitFor(() => {
      expect(prefs().tempUnit).toBe('f');
      expect(document.documentElement.dataset.theme).toBe('dark');
    }, { timeout: 5000 });
    expect(personal).toBeDefined();
  });
  it('keeps an unsaved local change over an account value from another session', async () => {
    const world = createFakePuter({ users: [alice] });
    const { win } = await setup({ world });
    win.go(false);
    setPrefs({ distanceUnit: 'mi' });
    const other = createPersonalStore({ puter: world.client(alice), db: await openDatabase(alice.uuid, { indexedDB: new IDBFactory() }) });
    await other.patchPreferences({ distanceUnit: 'km', tempUnit: 'f' });
    await world.flushEvents();
    await vi.waitFor(() => expect(prefs().tempUnit).toBe('f'));
    expect(prefs().distanceUnit).toBe('mi');
  });
  it('shares unsaved changes with the account\'s other tabs and sends the newest value', async () => {
    const { world, win } = await setup();
    win.go(false);
    setPrefs({ dateFormat: 'iso' });
    // Another tab adds its own unsaved change next to this one's.
    localStorage.setItem(pendingKey, JSON.stringify({ ...JSON.parse(localStorage.getItem(pendingKey)), timeFormat: '24' }));
    setPrefs({ weightUnit: 'kg' });
    expect(JSON.parse(localStorage.getItem(pendingKey))).toEqual({ dateFormat: 'iso', timeFormat: '24', weightUnit: 'kg' });
    // Then it changes this tab's key again.
    localStorage.setItem(pendingKey, JSON.stringify({ dateFormat: 'dmy', timeFormat: '24', weightUnit: 'kg' }));
    win.dispatchEvent(new StorageEvent('storage', { key: pendingKey }));
    expect(prefs().dateFormat).toBe('dmy');
    win.go(true);
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(world.inspectKv('alice')['me:prefs']).toEqual({ dateFormat: 'dmy', timeFormat: '24', weightUnit: 'kg' });
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });
  it('keeps a key another tab changed while it was being sent', async () => {
    const personal = stubPersonal();
    personal.patchPreferences.mockImplementationOnce(async (patch) => {
      personal.cloud = { ...personal.cloud, ...patch };
      localStorage.setItem(pendingKey, JSON.stringify({ distanceUnit: 'km' }));
    });
    await bind(personal).ready;
    setPrefs({ distanceUnit: 'mi' });
    await vi.waitFor(() => expect(personal.patchPreferences).toHaveBeenCalledTimes(2));
    expect(personal.patchPreferences).toHaveBeenLastCalledWith({ distanceUnit: 'km' });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(localStorage.getItem(pendingKey)).toBeNull();
  });
  it('keeps a saved value over an account read that began before the save', async () => {
    const personal = stubPersonal({ distanceUnit: 'km' });
    await bind(personal).ready;
    setPrefs({ distanceUnit: 'mi' });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    let release;
    personal.refresh.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ...personal.cloud }); }));
    personal.emit({ distanceUnit: 'km' });
    expect(prefs().distanceUnit).toBe('mi');
    expect(personal.refresh).toHaveBeenCalledWith('me:prefs');
    release(); await settle();
    expect(prefs().distanceUnit).toBe('mi');
    // Once a fresh read confirmed the save, a later change from another device shows at once.
    personal.cloud = { distanceUnit: 'km' };
    personal.emit({ distanceUnit: 'km' });
    expect(prefs().distanceUnit).toBe('km');
  });
  it('shows a change made on another device after the save once a fresh read confirms it', async () => {
    const personal = stubPersonal();
    await bind(personal).ready;
    setPrefs({ tempUnit: 'c' });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    personal.cloud = { tempUnit: 'f' };
    personal.emit({ tempUnit: 'f' });
    await vi.waitFor(() => expect(prefs().tempUnit).toBe('f'));
  });
  it('keeps the load error after sending changes until the account value is read', async () => {
    const personal = stubPersonal({ tempUnit: 'f' });
    const failure = Object.assign(new Error('x'), { status: 500 });
    personal.get.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    localStorage.setItem(pendingKey, JSON.stringify({ dateFormat: 'iso' }));
    const states = []; const off = onPrefsStatus((value) => states.push(value.state));
    const binding = bind(personal); await binding.ready;
    await vi.waitFor(() => expect(personal.get).toHaveBeenCalledTimes(2));
    await settle();
    expect(personal.patchPreferences).toHaveBeenCalledWith({ dateFormat: 'iso' });
    expect(prefsStatus()).toEqual({ state: 'error', code: 'load' });
    expect(states).not.toContain('saved');
    await binding.retry();
    expect(prefsStatus().state).toBe('idle');
    expect(prefs()).toMatchObject({ tempUnit: 'f', dateFormat: 'iso' });
    off();
  });
  it('starts live updates again after a failed start', async () => {
    const personal = stubPersonal();
    const stop = vi.fn();
    personal.watch = vi.fn().mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 0 })).mockResolvedValue(stop);
    const win = new FakeWindow();
    const binding = bind(personal, win); await binding.ready; await settle();
    expect(personal.watch).toHaveBeenCalledTimes(1);
    win.go(true);
    await vi.waitFor(() => expect(personal.watch).toHaveBeenCalledTimes(2));
    win.go(true); await settle();
    expect(personal.watch).toHaveBeenCalledTimes(2);
    binding.close();
    expect(stop).toHaveBeenCalled();
  });
  it('keeps tips dismissed on another device', async () => {
    const personal = stubPersonal({ tips: { welcome: true } });
    await bind(personal).ready;
    personal.cloud = { tips: { welcome: true, map: true } };
    setPrefs({ tips: { lists: true } });
    expect(prefs().tips).toEqual({ welcome: true, lists: true });
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(personal.patchPreferences).toHaveBeenCalledWith({ tips: { welcome: true, map: true, lists: true } });
    expect(prefs().tips).toEqual({ welcome: true, map: true, lists: true });
  });
  it('freezes nested values', async () => {
    await setup();
    expect(() => prefs().widgetsDesktop.order.push('stats')).toThrow(TypeError);
    expect(() => { prefs().tips.welcome = true; }).toThrow(TypeError);
  });
  it('closes cleanly and stops writing', async () => {
    const { binding, world } = await setup({ debounce: 50 });
    setPrefs({ mapAlwaysRoutes: true });
    binding.close();
    expect(prefsBound()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(world.counters().calls['kv.update'] ?? 0).toBe(0);
    expect(JSON.parse(localStorage.getItem(`trips:prefs:pending:${alice.uuid}`))).toEqual({ mapAlwaysRoutes: true });
  });
});
