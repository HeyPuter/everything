import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createApp } from '../../src/main.js';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { applyTheme } from '../../src/ui/theme.js';
import { parseRoute, routeHash, createRouter } from '../../src/lib/router.js';
import { createCommandRegistry, matchesShortcut } from '../../src/views/registry/commands.js';
import { tripTabs } from '../../src/views/registry/tabs.js';
import { t } from '../../src/lib/i18n/index.js';
const alice = { username: 'alice', uuid: '11111111-1111-4111-8111-111111111111' };
const bob = { username: 'bob', uuid: '22222222-2222-4222-8222-222222222222' };
const apps = [];
const key = (target, value, options = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
// The shell's built-in settings sections, used when no module is registered for them.
const builtinSettings = [{ id: 'appearance', labelKey: 'app.appearance', icon: 'sun' }, { id: 'account', labelKey: 'app.account', icon: 'users' }, { id: 'about', labelKey: 'app.about', icon: 'file' }];
function setup({ signedOut = false, ...options } = {}) {
  const world = createFakePuter({ users: [alice, bob] }); const puter = world.client(signedOut ? null : alice);
  const root = document.createElement('div'); root.id = 'app'; document.body.append(root);
  const indexedDB = new IDBFactory();
  const opener = vi.fn((account) => openDatabase(account, { indexedDB }));
  const app = createApp({ root, puter, openDatabase: opener, mac: false, registries: { settingsSections: builtinSettings }, ...options }); apps.push(app);
  return { app, root, world, puter, opener, indexedDB };
}
beforeEach(() => { window.history.replaceState(null, '', '/'); document.body.replaceChildren(); applyTheme('system'); });
afterEach(() => { apps.splice(0).forEach((app) => app.destroy()); document.body.replaceChildren(); localStorage.clear(); });
describe('router and registries', () => {
  it('uses own translation keys and own interpolation values', () => {
    expect(t('constructor')).toBe('constructor'); expect(t('toString')).toBe('toString'); expect(t('__proto__')).toBe('__proto__');
    expect(t('app.accountName', Object.create({ name: 'Injected' }))).toBe('Signed in as {name}');
  });
  it.each(['#/t/evil.com/0000000000000001', '#/t/trips-abcdefghij/nope', '#/t/trips-abcdefghij/0000000000000001/../../x', '#/t/trips-abcdefghij/0000000000000001/%2f', '#/settings/%', '#/settings/constructor/extra', 'https://evil.test', '#/preview?x=1', '#/preview', '#/preview/plan'])('rejects malformed route %s', (hash) => expect(parseRoute(hash).name).toBe('notFound'));
  it('validates refs and removes its hash listener on destroy', () => {
    const ref = { w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' };
    expect(parseRoute(routeHash({ name: 'space', ref, tab: 'files' }))).toEqual({ name: 'space', ref, tab: 'files' });
    const onRoute = vi.fn(); const router = createRouter({ onRoute }); router.start(); router.navigate('#/settings', { replace: true });
    expect(onRoute).toHaveBeenLastCalledWith({ name: 'settings', section: 'appearance' }); router.destroy(); const count = onRoute.mock.calls.length;
    window.dispatchEvent(new HashChangeEvent('hashchange')); expect(onRoute).toHaveBeenCalledTimes(count);
  });
  it('allows isolated command extensions and guards keyboard input', () => {
    const registry = createCommandRegistry(); const unregister = registry.register({ id: 'custom', labelKey: 'app.name' });
    expect(registry.get('custom')).toBeDefined(); expect(() => registry.register({ id: 'custom', labelKey: 'app.name' })).toThrow(); unregister(); expect(registry.get('custom')).toBeUndefined();
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'Mod+k')).toBe(true);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, altKey: true }), 'Mod+k')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, isComposing: true }), 'Mod+k')).toBe(false);
    expect(matchesShortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, keyCode: 229 }), 'Mod+k')).toBe(false);
  });
});
describe('account lifecycle', () => {
  it('waits for a click before requesting sign-in', async () => {
    const { app, root, puter, opener } = setup({ signedOut: true }); const signIn = vi.spyOn(puter.auth, 'signIn');
    await app.start(); expect(app.state.phase).toBe('signedOut'); expect(signIn).not.toHaveBeenCalled(); expect(opener).not.toHaveBeenCalled();
    // Booting after sign-in (database, personal store, dashboard tiles) takes real time; a loaded machine stretches it.
    byText(root, 'Sign in with Puter').click(); await vi.waitFor(() => expect(app.state.phase).toBe('ready'), { timeout: 10_000 });
    expect(signIn).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(root.textContent).toContain('Plan your first trip'), { timeout: 10_000 });
  }, 30_000);
  it('reloads the hosted SDK when its startup failed', async () => {
    const reload = vi.fn(); const { app, root } = setup({ reload });
    const brokenRoot = document.createElement('div'); document.body.append(brokenRoot);
    const broken = createApp({ root: brokenRoot, puter: {}, reload }); apps.push(broken); await broken.start();
    byText(brokenRoot, 'Retry').click(); expect(reload).toHaveBeenCalledOnce();
  });
  it('uses account-scoped storage and makes no worker requests', async () => {
    const { app, opener, world } = setup(); await app.start(); expect(opener).toHaveBeenCalledWith(alice.uuid);
    expect(app.state.account.uuid).toBe(alice.uuid); expect(world.counters().calls['workers.exec']).toBeUndefined(); expect(app.state.sync.status).toBe('idle');
  });
  it('renders SDK and storage failures with retry and settles boot', async () => {
    const root = document.createElement('div'); document.body.append(root); const broken = createApp({ root, puter: {} }); apps.push(broken);
    await broken.start(); expect(root.textContent).toContain('Puter could not be loaded'); expect(document.documentElement.dataset.boot).toBe('ready');
    const { app, root: second } = setup({ openDatabase: async () => { throw new Error('blocked'); } }); await app.start(); expect(second.textContent).toContain('Local storage could not be opened');
  });
  it('closes a database that finishes opening after app destruction', async () => {
    const opened = deferred(); const close = vi.fn(); const open = vi.fn(() => opened.promise);
    const { app, root } = setup({ openDatabase: open }); const boot = app.start(); await vi.waitFor(() => expect(open).toHaveBeenCalled());
    app.destroy(); opened.resolve({ close }); await boot; expect(close).toHaveBeenCalledOnce(); expect(root.childElementCount).toBe(0);
  });
  it('reboots into a new account before exposing preferences on session change', async () => {
    const { app, root, puter, world, opener } = setup(); await puter.kv.set('me:prefs', { theme: 'light' }); await app.start();
    const next = world.client(bob); await next.kv.set('me:prefs', { theme: 'dark' }); Object.assign(puter, next);
    window.dispatchEvent(new Event('focus')); await vi.waitFor(() => expect(app.state.account?.uuid).toBe(bob.uuid)); await app.ready;
    expect(opener).toHaveBeenLastCalledWith(bob.uuid); expect(root.textContent).toContain('bob'); expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('boots offline from the remembered identity only with the token it was stored for', async () => {
    const first = setup(); await first.app.start();
    await vi.waitFor(() => expect(localStorage.getItem('trips:identity')).not.toBeNull());
    first.app.destroy(); first.world.setOffline('*');
    const same = setup({ puter: first.puter }); window.dispatchEvent(new Event('offline')); await same.app.start();
    expect(same.app.state.phase).toBe('ready'); expect(same.opener).toHaveBeenCalledWith(alice.uuid);
    same.app.destroy();
    // Another account's token, and a new token for the same account, both fail instead of opening Alice's data.
    for (const client of [first.world.client(bob), first.world.client(alice)]) {
      const other = setup({ puter: client }); window.dispatchEvent(new Event('offline')); await other.app.start();
      expect(other.app.state.phase).toBe('error'); expect(other.opener).not.toHaveBeenCalled(); expect(other.app.state.account).toBeNull();
      other.app.destroy();
    }
    // A refused token never falls back, even offline.
    const refused = setup({ puter: first.puter }); first.puter.auth.getUser = async () => { throw Object.assign(new Error('expired'), { status: 401 }); };
    window.dispatchEvent(new Event('offline')); await refused.app.start();
    expect(refused.app.state.phase).toBe('signedOut'); expect(refused.opener).not.toHaveBeenCalled();
  });
  it('never remembers an identity fetched while the token changed', async () => {
    const { app, puter, world, opener } = setup(); const bobClient = world.client(bob);
    // The SDK switches to Bob's session while Alice's identity check is in flight.
    puter.auth.getUser = async () => { puter.authToken = bobClient.authToken; return bobClient.auth.getUser(); };
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    try {
      await app.start();
      expect(digest).not.toHaveBeenCalled(); expect(opener).not.toHaveBeenCalled();
      expect(localStorage.getItem('trips:identity')).toBeNull();
    } finally { digest.mockRestore(); }
  });
  it('hides sign-out in the desktop host and signs out on the web', async () => {
    const { app, root, puter } = setup(); puter.env = 'app'; window.history.replaceState(null, '', '#/settings/account'); await app.start();
    expect(byText(root, 'Sign out')).toBeUndefined(); expect(root.textContent).toContain('Puter desktop');
    puter.env = 'web'; await app.start(); byText(root, 'Sign out').click(); await vi.waitFor(() => expect(app.state.phase).toBe('signedOut'));
  });
});
describe('appearance and status', () => {
  it('loads and writes account appearance through the personal store', async () => {
    const { app, root, puter } = setup(); await puter.kv.set('me:prefs', { theme: 'dark' }); window.history.replaceState(null, '', '#/settings');
    await app.start(); expect(document.documentElement.dataset.theme).toBe('dark'); byText(root, 'Light').click();
    await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved')); expect((await puter.kv.get('me:prefs')).theme).toBe('light'); expect(localStorage.getItem('trips:theme')).toBe('light');
  });
  it('never stringifies absent optional controls into settings text', async () => {
    const { app, root, puter } = setup(); window.history.replaceState(null, '', '#/settings'); await app.start();
    expect(root.querySelector('.preference-status').textContent).toBe(''); byText(root, 'Dark').click();
    await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved'));
    expect(root.querySelector('.preference-status').textContent).toBe('Appearance saved to your account.');
    puter.auth.signOut = undefined; app.navigate('#/settings/account', { replace: true });
    expect(root.querySelector('.settings-body').textContent).toBe('AccountSigned in as alice');
    expect(root.textContent).not.toMatch(/undefined|false/);
  });
  it('keeps the local choice and explains a failed account write before retry', async () => {
    const { app, root, world, puter } = setup(); window.history.replaceState(null, '', '#/settings'); await app.start();
    world.failNext({ method: 'kv.update', status: 402 }); byText(root, 'Dark').click(); await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsCredit'));
    expect(document.documentElement.dataset.theme).toBe('dark'); expect(root.textContent).toContain('Check your Puter credit');
    byText(root, 'Retry').click(); await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved')); expect((await puter.kv.get('me:prefs')).theme).toBe('dark');
  });
  it('does not claim an offline choice was uploaded and retries after reconnect', async () => {
    const { app, root, world } = setup(); window.history.replaceState(null, '', '#/settings'); await app.start(); const writes = world.counters().calls['kv.update'] ?? 0;
    window.dispatchEvent(new Event('offline')); byText(root, 'Dark').click(); expect(app.state.preference.key).toBe('app.prefsOffline'); expect(world.counters().calls['kv.update'] ?? 0).toBe(writes);
    window.dispatchEvent(new Event('online')); byText(root, 'Retry').click(); await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved'));
  });
  it('preserves a new local choice when an older account read finishes late', async () => {
    const prefs = deferred(); const store = { get: () => prefs.promise, patchPreferences: vi.fn(async () => {}) };
    const { app, root } = setup({ createPersonalStore: () => store }); window.history.replaceState(null, '', '#/settings'); const boot = app.start();
    await vi.waitFor(() => expect(app.state.phase).toBe('ready')); byText(root, 'Dark').click(); prefs.resolve({ theme: 'light' }); await boot;
    await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved')); expect(document.documentElement.dataset.theme).toBe('dark');
  });
  it('serializes rapid theme writes and only displays the newest result', async () => {
    const first = deferred(); const second = deferred(); const store = { get: async () => null, patchPreferences: vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise) };
    const { app, root } = setup({ createPersonalStore: () => store }); window.history.replaceState(null, '', '#/settings'); await app.start();
    byText(root, 'Light').click(); byText(root, 'Dark').click(); await vi.waitFor(() => expect(store.patchPreferences).toHaveBeenCalledTimes(1));
    first.resolve(); await vi.waitFor(() => expect(store.patchPreferences).toHaveBeenCalledTimes(2)); expect(app.state.preference.key).toBe('app.prefsSaving');
    second.resolve(); await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved')); expect(store.patchPreferences.mock.calls).toEqual([[{ theme: 'light' }], [{ theme: 'dark' }]]);
  });
  it.each(['resolve', 'reject'])('starts a new account write queue without waiting for a stalled old write to %s', async (completion) => {
    const oldWrite = deferred();
    const oldStore = { get: async () => null, patchPreferences: vi.fn(() => oldWrite.promise) };
    const newStore = { get: async () => ({ theme: 'system' }), patchPreferences: vi.fn(async () => {}) };
    const { app, root, puter, world } = setup({ createPersonalStore: ({ db }) => db.account === alice.uuid ? oldStore : newStore });
    window.history.replaceState(null, '', '#/settings'); await app.start();
    byText(root, 'Dark').click(); byText(root, 'Light').click();
    await vi.waitFor(() => expect(oldStore.patchPreferences).toHaveBeenCalledTimes(1));
    Object.assign(puter, world.client(bob)); await app.start();
    byText(root, 'Light').click();
    await vi.waitFor(() => expect(newStore.patchPreferences).toHaveBeenCalledWith({ theme: 'light' }));
    await vi.waitFor(() => expect(app.state.preference.key).toBe('app.prefsSaved'));
    expect(app.state.account.uuid).toBe(bob.uuid);
    if (completion === 'resolve') oldWrite.resolve(); else oldWrite.reject(new Error('old account write failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldStore.patchPreferences).toHaveBeenCalledTimes(1);
    expect(app.state.preference.key).toBe('app.prefsSaved');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('uses explicit sync hooks and reports no syncing trip outside trip routes', async () => {
    const { app, root } = setup(); await app.start(); expect(root.textContent).toContain('No trip is syncing');
    app.setSyncState('forbidden'); expect(root.textContent).toContain('Sync access was refused'); app.setSyncState('queued', { pending: 3 }); expect(root.textContent).toContain('3 changes waiting');
    expect(() => app.setSyncState('constructor')).toThrow();
  });
  it('does not report up to date while local changes wait to be sent', async () => {
    const { app, root } = setup(); await app.start();
    const status = root.querySelector('.save-state');
    app.setSyncState('synced', { pending: 2 }); expect(status.dataset.state).toBe('syncing'); expect(status.textContent).toBe('Syncing…');
    app.setSyncState('synced'); expect(status.dataset.state).toBe('synced'); expect(status.textContent).toBe('Up to date');
  });
});
describe('workspace and commands', () => {
  it('keeps valid trip links and sends an unknown tab to the default one', async () => {
    const trip = '#/t/trips-abcdefghij/0000000000000001';
    window.history.replaceState(null, '', `${trip}/files`);
    const load = async () => ({ mount: () => {} });
    const tripTabs = [{ id: 'plan', labelKey: 'app.plan', icon: 'map', load }, { id: 'files', labelKey: 'app.files', icon: 'file', load }];
    const { app, root } = setup({ registries: { settingsSections: builtinSettings, tripTabs } }); await app.start();
    expect(window.location.hash).toBe(`${trip}/files`); expect(root.querySelector('.trip-tab[aria-current=page]').dataset.tab).toBe('files');
    app.navigate(`${trip}/budget`);
    await vi.waitFor(() => expect(window.location.hash).toBe(`${trip}/plan`));
    expect(root.querySelector('.trip-tab[aria-current=page]').dataset.tab).toBe('plan'); expect(root.textContent).not.toContain('coming soon');
  });
  it('opens a keyboard-searchable palette and does not intercept help inside fields', async () => {
    const { app, root } = setup(); await app.start(); key(document.body, 'k', { ctrlKey: true }); const search = document.querySelector('[role=combobox]'); expect(search).not.toBeNull();
    search.value = 'appearance'; search.dispatchEvent(new Event('input')); key(search, '?'); expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
    key(search, 'Enter'); await vi.waitFor(() => expect(root.textContent).toContain('Choose an appearance'));
    key(document.body, '?'); expect(document.querySelector('[role=dialog]').textContent).toContain('Keyboard shortcuts');
  });
  it.each([{ isComposing: true }, { keyCode: 229 }])('leaves IME composition keys to the input: %o', async (composition) => {
    const { app, root } = setup(); await app.start(); key(document.body, 'k', { ctrlKey: true });
    const search = document.querySelector('[role=combobox]');
    const selected = search.getAttribute('aria-activedescendant');
    key(search, 'ArrowDown', composition); key(search, 'ArrowUp', composition); key(search, 'Enter', composition);
    expect(search.getAttribute('aria-activedescendant')).toBe(selected);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    expect(app.state.route.name).toBe('dashboard');
    key(search, 'ArrowDown'); expect(search.getAttribute('aria-activedescendant')).not.toBe(selected);
    key(search, 'Enter'); await vi.waitFor(() => expect(app.state.route.name).toBe('settings'));
  });
  it('recognizes the macOS user-agent-data platform for modifier shortcuts', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'userAgentData');
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: { platform: 'macOS' } });
    try {
      const { app } = setup({ mac: undefined }); await app.start(); key(document.body, 'k', { metaKey: true });
      expect(document.querySelector('[role=dialog]')).not.toBeNull();
    } finally { if (original) Object.defineProperty(navigator, 'userAgentData', original); else delete navigator.userAgentData; }
  });
  it('removes keyboard and connectivity handlers on destroy', async () => {
    const { app } = setup(); await app.start(); app.destroy(); key(document.body, 'k', { ctrlKey: true }); window.dispatchEvent(new Event('offline'));
    expect(document.querySelector('[role=dialog]')).toBeNull(); expect(app.state.phase).toBe('destroyed'); expect(app.state.online).toBe(true);
  });
});
describe('registry views', () => {
  const ref = '#/t/trips-abcdefghij/0000000000000001';
  const tabs = (load) => [{ id: 'plan', labelKey: 'app.plan', icon: 'map', load }, { id: 'files', labelKey: 'app.files', icon: 'file' }];
  it('mounts a trip tab module with its context and cleans up on navigation', async () => {
    const cleanup = vi.fn(); const mount = vi.fn((container, context) => { container.append(t('app.plan')); return cleanup; });
    const { app, root } = setup({ registries: { tripTabs: tabs(async () => ({ mount })) } });
    window.history.replaceState(null, '', `${ref}/plan`); await app.start();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
    const [container, context] = mount.mock.calls[0];
    expect(root.contains(container)).toBe(true); expect(context.route.ref).toEqual({ w: 'trips-abcdefghij', s: '0000000000000001', k: 'trip' });
    expect(context.account.uuid).toBe(alice.uuid); expect(Object.keys(context.app).sort()).toEqual(['commands', 'navigate', 'setSyncState']); expect(context.signal.aborted).toBe(false);
    expect(context.ref).toEqual(context.route.ref); expect(context.space.ref).toEqual(context.ref); expect(context.session.account.uuid).toBe(alice.uuid);
    expect(root.textContent).not.toContain('cannot be opened in this preview');
    app.navigate(`${ref}/files`); await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(context.signal.aborted).toBe(true); expect(root.querySelector('.trip-tab[aria-current=page]').dataset.tab).toBe('files');
  });
  it('treats the retired workspace preview link as invalid and mounts nothing', async () => {
    const load = vi.fn(); const { app, root } = setup({ registries: { tripTabs: tabs(load) } });
    window.history.replaceState(null, '', '#/preview/plan'); await app.start();
    expect(load).not.toHaveBeenCalled(); expect(root.textContent).toContain('This link is invalid or unsupported');
    expect(root.querySelector('.app-nav-link[href="#/preview"]')).toBeNull();
  });
  it('shows an alert when a module fails and drops a load that resolves after navigation', async () => {
    const { app, root } = setup({ registries: { tripTabs: tabs(async () => { throw new Error('chunk'); }) } });
    window.history.replaceState(null, '', `${ref}/plan`); await app.start();
    await vi.waitFor(() => expect(root.querySelector('[role=alert]')?.textContent).toBe(t('app.viewError')));
    app.destroy();
    const late = deferred(); const mount = vi.fn();
    const second = setup({ registries: { tripTabs: tabs(() => late.promise) } }); await second.app.start();
    await vi.waitFor(() => expect(second.root.querySelector('.trip-tab-view')).not.toBeNull());
    second.app.navigate('#/'); await vi.waitFor(() => expect(second.root.querySelector('.trip-tab-view')).toBeNull());
    late.resolve({ mount }); await late.promise; await Promise.resolve();
    expect(mount).not.toHaveBeenCalled();
  });
  it('runs the cleanup of a mount that finishes after navigation', async () => {
    const mounted = deferred(); const cleanup = vi.fn(); const mount = vi.fn(() => mounted.promise);
    const { app, root } = setup({ registries: { tripTabs: tabs(async () => ({ mount })) } });
    window.history.replaceState(null, '', `${ref}/plan`); await app.start();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
    app.navigate(`${ref}/files`); await vi.waitFor(() => expect(root.querySelector('.trip-tab[aria-current=page]').dataset.tab).toBe('files'));
    mounted.resolve(cleanup); await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
  it('mounts dashboard and settings modules from their registries', async () => {
    const dashboard = vi.fn(); const section = vi.fn();
    const routes = [{ id: 'dashboard', labelKey: 'app.trips', icon: 'map', hash: '#/', load: async () => ({ mount: dashboard }) }];
    const settingsSections = [{ id: 'appearance', labelKey: 'app.appearance', icon: 'sun' }, { id: 'offline', labelKey: 'app.about', icon: 'file', load: async () => ({ mount: section }) }];
    const { app, root } = setup({ registries: { routes, settingsSections } }); await app.start();
    await vi.waitFor(() => expect(dashboard).toHaveBeenCalledOnce());
    app.navigate('#/settings/offline'); await vi.waitFor(() => expect(section).toHaveBeenCalledOnce());
    expect(root.querySelector('.settings-body').contains(section.mock.calls[0][0])).toBe(true);
  });
});
