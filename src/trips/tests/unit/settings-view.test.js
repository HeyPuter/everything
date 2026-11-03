import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { openDatabase } from '../../src/lib/idb.js';
import { createPersonalStore } from '../../src/lib/store/personal.js';
import { applyTheme } from '../../src/ui/theme.js';
import { bindPrefs, prefs, prefsStatus } from '../../src/lib/prefs.js';
import { mount } from '../../src/views/settings/index.js';
import { settingsSections } from '../../src/views/registry/settings.js';
import { readUsage } from '../../src/views/settings/sections/account.js';
import { createTemplateStore } from '../../src/views/settings/data/templates.js';
import { createCatalogStore } from '../../src/views/settings/data/catalog.js';
import { createVaultStore } from '../../src/views/settings/data/vault.js';

const alice = { username: 'alice', uuid: '11111111-1111-4111-8111-111111111111' };
const open = [];
const byText = (root, text, selector = 'button') => [...root.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const dialog = () => document.querySelector('[role=dialog]');
const typeInto = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
async function view(section, { world = createFakePuter({ users: [alice] }), puterSetup, beforeMount } = {}) {
  const puter = world.client(alice);
  puterSetup?.(puter);
  const db = await openDatabase(alice.uuid, { indexedDB: new IDBFactory() });
  const personal = createPersonalStore({ puter, db });
  const binding = bindPrefs({ personal, account: alice.uuid, debounce: 0 });
  await binding.ready;
  const controller = new AbortController();
  const container = document.createElement('div'); document.body.append(container);
  const app = { navigate: vi.fn(), setSyncState: vi.fn(), commands: {} };
  const context = { app, route: { name: 'settings', section }, account: { ...alice }, puter, personal, session: { account: { ...alice }, db, personal }, signal: controller.signal };
  beforeMount?.(world);
  const cleanup = await mount(container, context);
  open.push({ binding, controller, cleanup });
  return { world, puter, personal, container, app, controller };
}
// jsdom's File has no text(); browsers do.
File.prototype.text ??= function text() { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(this); }); };
beforeEach(() => { localStorage.clear(); applyTheme('system'); });
afterEach(() => {
  for (const { binding, controller, cleanup } of open.splice(0)) { controller.abort(); cleanup?.(); binding.close(); }
  document.body.replaceChildren(); localStorage.clear(); document.documentElement.removeAttribute('style');
});

describe('registry', () => {
  it('lists every section in order with a load for each module and the offline slot', () => {
    const ids = settingsSections.map((entry) => entry.id);
    expect(ids.slice(0, 9)).toEqual(['appearance', 'general', 'map', 'dashboard', 'templates', 'categories', 'ai', 'vault', 'offline']);
    expect(ids.slice(-2)).toEqual(['account', 'about']);
    expect(ids).toEqual(expect.arrayContaining(['flight-status', 'integrations', 'data', 'delete', 'notifications']));
    expect(new Set(ids).size).toBe(ids.length);
    expect(settingsSections.filter((entry) => !entry.load).map((entry) => entry.id)).toEqual(['about']);
  });
  it('mounts Settings → Offline from its module', async () => {
    const { container } = await view('offline');
    expect(container.textContent).not.toContain('Offline downloads, storage');
    expect(container.textContent).toContain('Work offline');
    const other = document.createElement('div');
    expect(await mount(other, { route: { section: 'unknown' }, signal: new AbortController().signal })).toBeUndefined();
    expect(other.childElementCount).toBe(0);
  });
});

describe('appearance', () => {
  it('changes theme, text size, contrast and motion and saves them', async () => {
    const { container, world } = await view('appearance');
    byText(container, 'Dark').click();
    expect(document.documentElement.dataset.theme).toBe('dark');
    const range = container.querySelector('input[type=range]');
    expect(range.labels[0].textContent).toBe('Text size');
    range.value = '1.3'; range.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('1.3');
    expect(range.getAttribute('aria-valuetext')).toBe('130%');
    const contrast = container.querySelector('[role=switch]');
    contrast.click();
    expect(contrast.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset.contrast).toBe('more');
    byText(container, 'Always reduce').click();
    expect(document.documentElement.dataset.motion).toBe('reduce');
    await vi.waitFor(() => expect(container.querySelector('.settings-status').textContent).toBe('Saved to your account.'));
    expect(world.inspectKv('alice')['me:prefs']).toMatchObject({ theme: 'dark', textSize: 1.3, contrast: 'more', motion: 'reduce' });
    const reset = byText(container, 'Reset');
    reset.focus(); reset.click();
    expect(prefs().textSize).toBe(1);
    expect(reset.disabled).toBe(true);
    expect(document.activeElement).toBe(range);
  });
  it('explains a credit failure and retries from the status line', async () => {
    const { container, world } = await view('appearance');
    world.failNext({ method: 'kv.update', status: 402 });
    byText(container, 'Light').click();
    await vi.waitFor(() => expect(container.querySelector('.settings-status').textContent).toContain('Your Puter credit has run out'));
    byText(container, 'Retry').click();
    await vi.waitFor(() => expect(prefsStatus().state).toBe('saved'));
    expect(container.querySelector('.settings-status').textContent).toBe('Saved to your account.');
  });
});

describe('general and map', () => {
  it('saves selects and switches, and follows changes from another session', async () => {
    const { container, world } = await view('general');
    const select = (label) => [...container.querySelectorAll('select')].find((node) => node.labels[0]?.textContent === label);
    expect([...select('Date format').options].map((option) => option.value)).toEqual(['auto', 'dmy', 'mdy', 'iso']);
    select('Date format').value = 'iso'; select('Date format').dispatchEvent(new Event('change'));
    select('Display currency').value = 'EUR'; select('Display currency').dispatchEvent(new Event('change'));
    select('Default trip tab').value = 'lists'; select('Default trip tab').dispatchEvent(new Event('change'));
    expect([...select('Default trip tab').options].map((option) => option.value)).not.toContain('settings');
    byText(container, '24-hour · 14:30').click();
    container.querySelectorAll('[role=switch]')[1].click();
    expect(prefs()).toMatchObject({ dateFormat: 'iso', currency: 'EUR', tripTab: 'lists', timeFormat: '24', blurCodes: true });
    select('Display currency').value = ''; select('Display currency').dispatchEvent(new Event('change'));
    expect(prefs().currency).toBeNull();
    await vi.waitFor(() => expect(world.inspectKv('alice')['me:prefs']).toMatchObject({ dateFormat: 'iso', currency: null, blurCodes: true }));
    const other = createPersonalStore({ puter: world.client(alice), db: await openDatabase(alice.uuid, { indexedDB: new IDBFactory() }) });
    await other.patchPreferences({ dateFormat: 'dmy', weightUnit: 'kg' });
    await world.flushEvents();
    await vi.waitFor(() => expect(select('Date format').value).toBe('dmy'));
    expect(byText(container, 'kg').getAttribute('aria-pressed')).toBe('true');
  });
  it('saves map style and layer switches', async () => {
    const { container } = await view('map');
    byText(container, 'SatelliteAerial imagery with place labels.', 'button').click();
    const routes = [...container.querySelectorAll('[role=switch]')].find((node) => node.closest('.pref-row').textContent.startsWith('Always show routes'));
    routes.click();
    expect(prefs()).toMatchObject({ mapStyle: 'satellite', mapAlwaysRoutes: true });
    expect(routes.getAttribute('aria-checked')).toBe('true');
  });
});

describe('dashboard widgets', () => {
  it('hides, reorders and resets widgets per device type', async () => {
    const { container } = await view('dashboard');
    const rows = () => [...container.querySelectorAll('[data-widget]')].map((row) => row.dataset.widget);
    expect(rows()).toEqual(['upcoming', 'fx', 'clocks', 'collections', 'atlas']);
    container.querySelector('[data-widget=fx] [role=switch]').click();
    expect(prefs().widgetsDesktop.hidden).toEqual(['fx']);
    const grip = container.querySelector('[data-widget=upcoming] [data-sortable-handle]');
    grip.focus();
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(prefs().widgetsDesktop.order).toEqual(['fx', 'upcoming', 'clocks', 'collections', 'atlas']);
    expect(rows()).toEqual(['fx', 'upcoming', 'clocks', 'collections', 'atlas']);
    expect(container.querySelector('[role=status]').textContent).toContain('position 2 of 5');
    byText(container, 'Phone').click();
    expect(rows()).toEqual(['upcoming', 'fx', 'clocks', 'collections', 'atlas']);
    container.querySelector('[data-widget=clocks] [role=switch]').click();
    expect(prefs().widgetsPhone.hidden).toEqual(['clocks']);
    expect(prefs().widgetsDesktop.hidden).toEqual(['fx']);
    byText(container, 'Restore default layout').click();
    expect(prefs().widgetsPhone).toEqual({ order: ['upcoming', 'fx', 'clocks', 'collections', 'atlas'], hidden: [] });
  });
});

describe('templates', () => {
  it('creates, edits, renames, exports, imports and deletes templates', async () => {
    const { container, world } = await view('templates');
    await vi.waitFor(() => expect(container.textContent).toContain('No templates yet'));
    byText(container, 'New template').click();
    const editor = dialog();
    const [name, listName] = editor.querySelectorAll('input.input');
    typeInto(name, '');
    byText(editor, 'Create template').click();
    await vi.waitFor(() => expect(editor.textContent).toContain('Give the template a name.'));
    typeInto(name, 'Ski week');
    expect(listName.value).toBe('General');
    editor.querySelector('textarea').value = '2x Gloves\nGoggles';
    byText(editor, 'Add list').click();
    const lists = editor.querySelectorAll('.template-list-editor');
    expect(lists).toHaveLength(2);
    typeInto(lists[1].querySelector('input'), 'Docs');
    lists[1].querySelector('textarea').value = 'Lift pass';
    byText(editor, 'Create template').click();
    await vi.waitFor(() => expect(container.textContent).toContain('Ski week'));
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Packing · 3 items');
    const id = Object.keys(world.inspectKv('alice')['me:tpls'])[0];
    expect(world.inspectKv('alice')[`me:tpl:${id}`]).toMatchObject({ kind: 'pack', name: 'Ski week', lists: [{ name: 'General', items: [{ name: 'Gloves', qty: 2 }, { name: 'Goggles' }] }, { name: 'Docs', items: [{ name: 'Lift pass' }] }] });

    // Export goes through a download link.
    URL.createObjectURL = vi.fn(() => 'blob:template'); URL.revokeObjectURL = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() { clicked.link = this.download; });
    container.querySelector('[aria-label="Actions for Ski week"]').click();
    byText(document.body, 'Export file').click();
    await vi.waitFor(() => expect(clicked).toHaveBeenCalled());
    expect(clicked.link).toBe('Ski week.trips-template.json');
    const blob = URL.createObjectURL.mock.calls[0][0];
    const text = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });

    // Import the same file as a second template.
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function choose() {
      Object.defineProperty(this, 'files', { value: [new File([text], 'Ski week.trips-template.json', { type: 'application/json' })] });
      this.dispatchEvent(new Event('change'));
    });
    byText(container, 'Import file').click();
    await vi.waitFor(() => expect(Object.keys(world.inspectKv('alice')['me:tpls'])).toHaveLength(2));
    await vi.waitFor(() => expect(container.querySelectorAll('.template-row')).toHaveLength(2));

    // Rename the first, then delete it.
    container.querySelector('[aria-label="Actions for Ski week"]').click();
    byText(document.body, 'Rename').click();
    typeInto(dialog().querySelector('input'), 'Ski trip');
    dialog().querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('Ski trip'));
    container.querySelector('[aria-label="Actions for Ski trip"]').click();
    byText(document.body, 'Delete').click();
    expect(dialog().textContent).toContain('Delete “Ski trip”?');
    byText(dialog(), 'Delete').click();
    await vi.waitFor(() => expect(container.querySelectorAll('.template-row')).toHaveLength(1));
    expect(Object.keys(world.inspectKv('alice')['me:tpls'])).toHaveLength(1);
  });
  it('keeps focus on the row after a rename and moves it on after a delete', async () => {
    const { container, personal, puter } = await view('templates');
    const store = createTemplateStore({ personal, puter });
    await store.create({ kind: 'pack', name: 'Alpha', lists: [{ name: 'All', items: ['Hat'] }] });
    await store.create({ kind: 'todo', name: 'Beta', lists: [{ name: 'All', items: ['Visa'] }] });
    const more = (name) => container.querySelector(`[aria-label="Actions for ${name}"]`);
    await vi.waitFor(() => expect(more('Beta')).not.toBeNull());
    more('Alpha').focus(); more('Alpha').click();
    byText(document.body, 'Rename').click();
    typeInto(dialog().querySelector('input'), 'Alpha 2');
    dialog().querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(more('Alpha 2')).not.toBeNull());
    expect(document.activeElement).toBe(more('Alpha 2'));
    more('Alpha 2').click();
    byText(document.body, 'Delete').click();
    byText(dialog(), 'Delete').click();
    await vi.waitFor(() => expect(container.querySelectorAll('.template-row')).toHaveLength(1));
    expect(document.activeElement).toBe(more('Beta'));
    more('Beta').click();
    byText(document.body, 'Delete').click();
    byText(dialog(), 'Delete').click();
    await vi.waitFor(() => expect(container.textContent).toContain('No templates yet'));
    expect(document.activeElement).toBe(byText(container, 'New template'));
  });
  it('rejects a file that is not a template and reports offline writes', async () => {
    const { container, world } = await view('templates');
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function choose() {
      Object.defineProperty(this, 'files', { value: [new File(['{"hello":1}'], 'notes.json')] });
      this.dispatchEvent(new Event('change'));
    });
    byText(container, 'Import file').click();
    await vi.waitFor(() => expect(container.querySelector('[role=alert]').textContent).toBe('This file is not a Trips template.'));
    world.setOffline('alice', true);
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    try {
      byText(container, 'New template').click();
      typeInto(dialog().querySelector('input'), 'Offline');
      byText(dialog(), 'Create template').click();
      await vi.waitFor(() => expect(dialog().querySelector('[role=alert]').textContent).toBe('You are offline. Reconnect and try again.'));
    } finally { delete navigator.onLine; }
  });
});

describe('categories and tags', () => {
  it('adds and edits categories and manages tags', async () => {
    const { container, world } = await view('categories');
    await vi.waitFor(() => expect(container.textContent).toContain('No personal categories yet.'));
    byText(container, 'Add category').click();
    const form = dialog();
    typeInto(form.querySelector('input'), 'Street food');
    byText(form, 'Green').click(); byText(form, 'Food').click();
    byText(form, 'Add category').click();
    await vi.waitFor(() => expect(container.textContent).toContain('Street food'));
    expect(world.inspectKv('alice')['me:cats']).toEqual([expect.objectContaining({ name: 'Street food', color: 2, icon: 'utensils' })]);
    const input = container.querySelector('.tag-form input');
    typeInto(input, 'museum'); container.querySelector('.tag-form').requestSubmit();
    await vi.waitFor(() => expect(container.querySelector('.tag-list').textContent).toContain('museum'));
    typeInto(input, 'Museum'); container.querySelector('.tag-form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('You already have that tag.'));
    container.querySelector('[aria-label="Delete tag museum"]').click();
    await vi.waitFor(() => expect(world.inspectKv('alice')['me:tags']).toEqual([]));
  });
  it('keeps focus in the lists after edits and deletes', async () => {
    const { container, personal } = await view('categories');
    const store = createCatalogStore({ personal });
    await store.saveCategory({ name: 'Food', color: 2, icon: 'utensils' });
    await store.saveCategory({ name: 'Views', color: 5, icon: 'mountain' });
    await store.addTag('museum'); await store.addTag('night');
    const named = (label) => container.querySelector(`[aria-label="${label}"]`);
    await vi.waitFor(() => expect(named('Delete tag night')).not.toBeNull());
    named('Edit Food').focus(); named('Edit Food').click();
    typeInto(dialog().querySelector('input'), 'Eat');
    byText(dialog(), 'Save').click();
    await vi.waitFor(() => expect(named('Edit Eat')).not.toBeNull());
    expect(document.activeElement).toBe(named('Edit Eat'));
    named('Delete Eat').focus(); named('Delete Eat').click();
    byText(dialog(), 'Delete').click();
    await vi.waitFor(() => expect(named('Delete Eat')).toBeNull());
    expect(document.activeElement).toBe(named('Delete Views'));
    named('Rename tag museum').focus(); named('Rename tag museum').click();
    typeInto(dialog().querySelector('input'), 'museums');
    dialog().querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(named('Rename tag museums')).not.toBeNull());
    expect(document.activeElement).toBe(named('Rename tag museums'));
    named('Delete tag night').focus(); named('Delete tag night').click();
    await vi.waitFor(() => expect(named('Delete tag night')).toBeNull());
    expect(document.activeElement).toBe(named('Delete tag museums'));
  });
});

describe('AI', () => {
  it('saves models, showing an unknown stored model as is, and explains assistant approval', async () => {
    const world = createFakePuter({ users: [alice] });
    await world.client(alice).kv.set('me:prefs', { aiQuickModel: 'gpt-x-mini' });
    const { container } = await view('ai', { world });
    const quick = [...container.querySelectorAll('select')].find((node) => node.labels[0].textContent === 'Quick tasks');
    expect([...quick.options].map((option) => option.textContent)).toEqual(['Claude Haiku 5.5 (recommended)', 'Claude Sonnet 5.5', 'gpt-x-mini']);
    quick.value = 'claude-haiku-5-5'; quick.dispatchEvent(new Event('change'));
    expect(prefs()).toMatchObject({ aiQuickModel: 'claude-haiku-5-5' });
    expect(container.textContent).toContain('changes your trip only after you approve it');
  });
});

describe('travel documents', () => {
  it('adds a document, encrypts with a passphrase and unlocks again', async () => {
    const { container, world } = await view('vault');
    await vi.waitFor(() => expect(container.textContent).toContain('No documents yet.'));
    byText(container, 'Add document').click();
    let form = dialog();
    typeInto(form.querySelectorAll('input')[0], 'My passport');
    typeInto(form.querySelectorAll('input')[1], 'X1234567');
    form.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('My passport'));
    expect(container.querySelector('.vault-number').textContent).toContain('•••• 4567');
    expect(container.querySelector('.vault-number').textContent).not.toContain('X1234567');
    container.querySelector('.vault-reveal').focus();
    container.querySelector('.vault-reveal').click();
    expect(container.querySelector('.vault-number').textContent).toBe('X1234567');
    expect(container.querySelector('.vault-reveal').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.vault-reveal').getAttribute('aria-label')).toBe('Show number for My passport');
    expect(document.activeElement).toBe(container.querySelector('.vault-reveal'));

    byText(container, 'Add a passphrase').click();
    form = dialog();
    const [first, second] = form.querySelectorAll('input');
    typeInto(first, 'short'); typeInto(second, 'short');
    form.querySelector('form').requestSubmit();
    expect(form.textContent).toContain('Use at least 8 characters.');
    typeInto(first, 'correct horse'); typeInto(second, 'correct house');
    form.querySelector('form').requestSubmit();
    expect(form.textContent).toContain('The passphrases do not match.');
    typeInto(second, 'correct horse');
    form.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('Encrypted with your passphrase.'), { timeout: 5000 });
    expect(JSON.stringify(world.inspectKv('alice')['me:vault'])).not.toContain('X1234567');

    byText(container, 'Lock').click();
    expect(container.textContent).toContain('Enter your passphrase');
    const pass = container.querySelector('input[type=password]');
    typeInto(pass, 'wrong passphrase'); container.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('That passphrase did not work.'), { timeout: 5000 });
    typeInto(pass, 'correct horse'); container.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.textContent).toContain('My passport'), { timeout: 5000 });
  });
  it('reloads instead of saving over a change from another session', async () => {
    const { container, world } = await view('vault');
    await vi.waitFor(() => expect(container.textContent).toContain('No documents yet.'));
    const other = createVaultStore({ puter: world.client(alice), iterations: 1000 });
    await other.load(); await other.saveDoc({ type: 'visa', label: 'Visa' }); await other.setPassphrase('correct horse');
    byText(container, 'Add document').click();
    typeInto(dialog().querySelectorAll('input')[0], 'My passport');
    dialog().querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.querySelector('[role=alert]').textContent).toBe('Your travel documents changed on another device. Check them and try again.'));
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain('Enter your passphrase');
    expect(world.inspectKv('alice')['me:vault'].enc).toBeDefined();
  });
  it('offers only deletion for a vault saved by a newer version', async () => {
    const world = createFakePuter({ users: [alice] });
    await world.client(alice).kv.set('me:vault', { v: 2, docs: [] });
    const { container } = await view('vault', { world });
    await vi.waitFor(() => expect(container.textContent).toContain('A newer version of Trips saved your travel documents.'));
    expect(byText(container, 'Add document')).toBeUndefined();
    byText(container, 'Delete all').click();
    expect(dialog().textContent).toContain('including the ones this version of Trips cannot show');
    byText(dialog(), 'Delete all').click();
    await vi.waitFor(() => expect(container.textContent).toContain('No documents yet.'));
    expect(world.inspectKv('alice')['me:vault']).toBeUndefined();
    expect(document.activeElement).toBe(byText(container, 'Add document'));
  });
  it('shows load failures with a retry', async () => {
    const { container } = await view('vault', { beforeMount: (world) => world.failNext({ method: 'kv.get', status: 402 }) });
    await vi.waitFor(() => expect(container.textContent).toContain('Your Puter credit has run out.'));
    byText(container, 'Retry').click();
    await vi.waitFor(() => expect(container.textContent).toContain('No documents yet.'));
  });
});

describe('account', () => {
  const usage = { allowanceInfo: { monthUsageAllowance: 50_000_000, remaining: 4_000_000 }, appTotals: { trips: { count: 42, total: 1_250_000 }, other: { count: 1, total: 9 } }, usage: {} };
  it('reads usage defensively', () => {
    expect(readUsage(usage, 'trips')).toEqual({ allowance: 50_000_000, remaining: 4_000_000, used: 46_000_000, app: 1_250_000, calls: 42 });
    // Other apps' spend never counts as this app's.
    expect(readUsage({ allowanceInfo: { monthUsageAllowance: 10, remaining: 5 }, appTotals: { a: { count: 1, total: 2 }, b: { count: 2, total: 3 } } }, 'x')).toMatchObject({ app: 0, calls: 0 });
    expect(readUsage(usage, undefined)).toMatchObject({ app: null, calls: 0 });
    expect(readUsage({}, 'trips')).toBeNull();
  });
  it('shows the account and usage, and signs out on the web', async () => {
    const { container, app, puter } = await view('account', { puterSetup: (client) => { client.auth.getMonthlyUsage = async () => usage; } });
    await vi.waitFor(() => expect(container.textContent).toContain('$0.46 of $0.50 used'));
    expect(container.textContent).toContain('alice');
    expect(container.textContent).toContain('Trips used $0.01 (42 requests)');
    expect(container.textContent).toContain('running low');
    expect(container.querySelector('meter').value).toBe(46_000_000);
    byText(container, 'Sign out').click();
    await vi.waitFor(() => expect(app.navigate).toHaveBeenCalledWith('#/', { replace: true }));
    expect(puter.authToken).toBeNull();
  });
  it('hides sign-out inside the Puter desktop and handles missing or failing usage', async () => {
    const desktop = await view('account', { puterSetup: (client) => { client.env = 'app'; } });
    expect(byText(desktop.container, 'Sign out')).toBeUndefined();
    expect(desktop.container.textContent).toContain('managed by the Puter desktop');
    expect(desktop.container.textContent).toContain('Usage details are not available here.');
    let calls = 0;
    const failing = await view('account', { puterSetup: (client) => { client.auth.getMonthlyUsage = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('x'), { status: 500 }); return usage; }; } });
    await vi.waitFor(() => expect(failing.container.textContent).toContain('Something went wrong.'));
    byText(failing.container, 'Retry').click();
    await vi.waitFor(() => expect(failing.container.textContent).toContain('$0.46 of $0.50 used'));
  });
});
