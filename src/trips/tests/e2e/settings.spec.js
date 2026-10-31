import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { createTestBridgeHost } from '../../dev/fake-puter/bridge-host.js';
import { attachFakePuterContext } from '../../dev/fake-puter/bridge-playwright.js';

const require = createRequire(import.meta.url);
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const bob = { uuid: '00000000-0000-4000-8000-000000000002', username: 'bob' };
const saved = 'Saved to your account.';

async function audit(page) {
  await page.evaluate(async () => Promise.all(document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axe });
  expect(await page.evaluate(async () => (await window.axe.run()).violations)).toEqual([]);
}
async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, fullPage: true }); await testInfo.attach(name, { path, contentType: 'image/png' });
}
const noOverflow = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
async function section(page, id, heading, base = '') {
  await page.goto(`${base}/mock.html#/settings/${id}`);
  await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expect(page.locator('.settings-section [aria-busy="true"]')).toHaveCount(0);
}
const kv = (page, key) => page.evaluate((name) => window.__TRIPS_MOCK__.inspectKv('alice')[name], key);

async function bridge(browser, testInfo, baseURL) {
  const world = createFakePuter({ users: [alice, bob] });
  const host = createTestBridgeHost(world);
  const contexts = [];
  async function open(as, id = 'general', heading = 'General') {
    const { colorScheme, viewport, isMobile, hasTouch } = testInfo.project.use;
    const context = await browser.newContext({ colorScheme, viewport, isMobile, hasTouch });
    contexts.push(context);
    await attachFakePuterContext(host, context, { as });
    const page = await context.newPage();
    page.on('pageerror', (error) => { throw error; });
    await section(page, id, heading, baseURL);
    await expect(page.locator('html')).toHaveAttribute('data-runtime', 'mock-bridge');
    return { page, context };
  }
  return { world, host, open, async close() { for (const context of contexts) await context.close(); await host.close(); } };
}

test.beforeEach(async ({ page }) => { page.on('pageerror', (error) => { throw error; }); });

test('general preferences save, survive a reload and pass axe', async ({ page }, testInfo) => {
  await section(page, 'general', 'General');
  await expect(page.locator('.settings-status')).toBeHidden();
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'settings-general');
  await page.getByRole('button', { name: 'km', exact: true }).click();
  await page.getByRole('button', { name: 'kg', exact: true }).click();
  await page.getByLabel('Date format').selectOption('iso');
  await page.getByRole('button', { name: '24-hour · 14:30', exact: true }).click();
  await page.getByLabel('Week starts on').selectOption('mon');
  await page.getByLabel('Display currency').selectOption('EUR');
  await page.getByLabel('Start page').selectOption('current');
  await page.getByLabel('Default trip tab').selectOption('lists');
  await page.getByRole('switch', { name: 'Hide booking codes' }).click();
  await page.getByRole('switch', { name: 'Show place descriptions' }).click();
  await expect(page.getByText(saved, { exact: true })).toBeVisible();
  await expect.poll(() => kv(page, 'me:prefs')).toEqual({ distanceUnit: 'km', weightUnit: 'kg', dateFormat: 'iso', timeFormat: '24', weekStart: 'mon', currency: 'EUR', startPage: 'current', tripTab: 'lists', blurCodes: true, placeDescriptions: false });
  await expect(page.locator('main')).not.toContainText(/undefined|NaN|\[object/);
});

test('text size, contrast and motion apply before paint and keep the layout usable', async ({ page }, testInfo) => {
  await section(page, 'appearance', 'Appearance');
  const size = page.getByLabel('Text size');
  await size.focus(); await page.keyboard.press('End');
  await expect(size).toHaveAttribute('aria-valuetext', '160%');
  await expect(page.locator('html')).toHaveAttribute('style', /--text-scale: 1.6/);
  expect(await page.locator('.pref-label').first().evaluate((node) => getComputedStyle(node).fontSize)).toBe('22.4px');
  await page.getByRole('switch', { name: 'High contrast' }).click();
  await page.getByRole('button', { name: 'Always reduce', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-contrast', 'more');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduce');
  await expect(page.getByText(saved, { exact: true })).toBeVisible();
  expect(await kv(page, 'me:prefs')).toEqual({ textSize: 1.6, contrast: 'more', motion: 'reduce' });
  await noOverflow(page); await audit(page); await capture(page, testInfo, 'settings-appearance-large');
  for (const id of ['general', 'templates', 'vault']) { await page.goto(`/mock.html#/settings/${id}`); await expect(page.locator('.settings-section')).toBeVisible(); await noOverflow(page); }
  await page.goto('/mock.html#/'); await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible(); await noOverflow(page);
  // The head script restores appearance before the app module runs.
  await page.addInitScript(() => document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive') globalThis.prepaint = { contrast: document.documentElement.dataset.contrast, scale: document.documentElement.style.getPropertyValue('--text-scale') };
  }));
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
  expect(await page.evaluate(() => globalThis.prepaint)).toEqual({ contrast: 'more', scale: '1.6' });
  await page.goto('/mock.html#/settings/appearance');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('switch', { name: 'High contrast' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-contrast', 'more');
  await expect(page.locator('html')).not.toHaveAttribute('style', /--text-scale/);
});

test('map, AI, dashboard and offline sections save by keyboard and pass axe', async ({ page }, testInfo) => {
  await section(page, 'map', 'Map');
  await page.getByRole('radio', { name: /^Satellite/ }).click();
  await page.getByRole('switch', { name: 'Always show routes' }).focus(); await page.keyboard.press('Space');
  await audit(page); await capture(page, testInfo, 'settings-map');
  await section(page, 'ai', 'AI');
  await page.getByLabel('Booking import and assistant').selectOption('claude-opus-5-5');
  // The assistant always asks before it changes a trip, so the section explains that instead of offering modes.
  await expect(page.getByText(/^The assistant shows each change it proposes/)).toBeVisible();
  await expect(page.getByRole('radio', { name: /^Before every change/ })).toHaveCount(0);
  await audit(page); await capture(page, testInfo, 'settings-ai');
  await section(page, 'dashboard', 'Dashboard');
  const device = testInfo.project.name.startsWith('phone') ? 'widgetsPhone' : 'widgetsDesktop';
  await page.getByRole('switch', { name: 'Currency converter' }).click();
  const grip = page.locator('[data-widget=upcoming] [data-sortable-handle]');
  await grip.focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('[data-widget]').first()).toHaveAttribute('data-widget', 'fx');
  await expect(grip).toBeFocused();
  await audit(page); await capture(page, testInfo, 'settings-dashboard');
  await expect(page.getByText(saved, { exact: true })).toBeVisible();
  const prefs = await kv(page, 'me:prefs');
  expect(prefs).toMatchObject({ mapStyle: 'satellite', mapAlwaysRoutes: true, aiModel: 'claude-opus-5-5', [device]: { order: ['fx', 'upcoming', 'clocks', 'collections', 'atlas'], hidden: ['fx'] } });
  await section(page, 'offline', 'Offline');
  await expect(page.getByRole('switch', { name: 'Work offline', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Keep map areas', exact: true })).toBeVisible();
  await audit(page);
});

test('templates are created, edited and exported, and another user imports the file', async ({ page }, testInfo) => {
  await section(page, 'templates', 'Templates');
  await expect(page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
  await audit(page);
  const create = page.getByRole('button', { name: 'New template', exact: true });
  await create.click();
  const editor = page.getByRole('dialog', { name: 'New template' });
  await editor.getByLabel('Template name').fill('Ski week');
  await editor.getByLabel('Items').fill('2x Gloves\nGoggles');
  await editor.getByRole('button', { name: 'Add list', exact: true }).click();
  await editor.getByLabel('List name').nth(1).fill('Documents');
  await editor.getByLabel('Items').nth(1).fill('Lift pass');
  await audit(page); await capture(page, testInfo, 'settings-template-editor');
  await editor.getByRole('button', { name: 'Create template', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(create).toBeFocused();
  await expect(page.getByText('Packing · 3 items')).toBeVisible();
  const actions = page.getByRole('button', { name: 'Actions for Ski week' });
  await actions.click(); await page.getByRole('menuitem', { name: 'Edit items' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit template' });
  await expect(edit.getByLabel('Items').first()).toHaveValue('2x Gloves\nGoggles');
  await edit.getByLabel('Items').first().fill('2x Gloves\nGoggles\nHelmet');
  await edit.getByRole('button', { name: 'Save template', exact: true }).click();
  await expect(page.getByText('Packing · 4 items')).toBeVisible();
  await audit(page); await capture(page, testInfo, 'settings-templates');
  await actions.click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export file' }).click()]);
  expect(download.suggestedFilename()).toBe('Ski week.trips-template.json');
  const file = testInfo.outputPath('ski.trips-template.json'); await download.saveAs(file);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 'trips-template', version: 1, template: { kind: 'pack', name: 'Ski week' } });

  await page.goto('/mock.html?as=bob#/settings/templates');
  await expect(page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import file', exact: true }).click()]);
  await chooser.setFiles(file);
  await expect(page.getByText('Imported “Ski week”.')).toBeVisible();
  await expect(page.getByText('Packing · 4 items')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Ski week' }).click(); await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete “Ski week”?' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
});

test('personal categories and tags are managed and pass axe', async ({ page }, testInfo) => {
  await section(page, 'categories', 'Categories and tags');
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New category' });
  await form.getByLabel('Name').fill('Street food');
  await form.getByRole('radio', { name: 'Amber' }).click();
  await form.getByRole('radio', { name: 'Food' }).click();
  await audit(page);
  await form.getByRole('button', { name: 'Add category', exact: true }).click();
  await expect(page.getByText('Added “Street food”.')).toBeVisible();
  await page.getByLabel('New tag').fill('museum'); await page.keyboard.press('Enter');
  await page.getByLabel('New tag').fill('night market'); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Rename tag night market' })).toBeVisible();
  await page.getByLabel('New tag').fill('Museum'); await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('You already have that tag.');
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'settings-categories');
  expect(await kv(page, 'me:cats')).toEqual([expect.objectContaining({ name: 'Street food', color: 3, icon: 'utensils' })]);
  expect(await kv(page, 'me:tags')).toEqual(['museum', 'night market']);
});

test('account shows usage, hides sign-out in the desktop and signs out on the web', async ({ page }, testInfo) => {
  await section(page, 'appearance', 'Appearance');
  await page.evaluate(() => {
    window.puter.auth.getMonthlyUsage = async () => ({ allowanceInfo: { monthUsageAllowance: 50_000_000, remaining: 32_000_000 }, appTotals: { trips: { count: 12, total: 2_000_000 } }, usage: {} });
  });
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByText('$0.18 of $0.50 used').first()).toBeVisible();
  await expect(page.getByText('Trips used $0.02 (12 requests)')).toBeVisible();
  await audit(page); await capture(page, testInfo, 'settings-account');
  await page.evaluate(() => { window.puter.env = 'app'; });
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await expect(page.getByText('Your account is managed by the Puter desktop.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  await page.evaluate(() => { window.puter.env = 'web'; });
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with Puter' })).toBeVisible();
});

test('travel documents are encrypted with a passphrase another device must enter', async ({ browser, baseURL }, testInfo) => {
  const f = await bridge(browser, testInfo, baseURL);
  try {
    const { page } = await f.open('alice', 'vault', 'Travel documents');
    await page.getByRole('button', { name: 'Add document', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New document' });
    await form.getByLabel('Name').fill('Alice passport');
    await form.getByLabel('Number').fill('X1234567');
    await form.getByLabel('Expires').fill('2027-01-15');
    await form.getByRole('button', { name: 'Add document', exact: true }).click();
    await expect(page.getByText('Alice passport', { exact: true })).toBeVisible();
    await expect(page.getByText('X1234567')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show number for Alice passport' }).click();
    await expect(page.getByText('X1234567')).toBeVisible();
    await page.getByRole('button', { name: 'Add a passphrase', exact: true }).click();
    const pass = page.getByRole('dialog', { name: 'Add a passphrase' });
    await pass.getByLabel('New passphrase').fill('correct horse');
    await pass.getByLabel('Repeat passphrase').fill('correct horse');
    await pass.getByRole('button', { name: 'Encrypt documents', exact: true }).click();
    await expect(page.getByText('Encrypted with your passphrase.')).toBeVisible();
    const stored = f.world.inspectKv(alice.uuid)['me:vault'];
    expect(stored.enc).toMatchObject({ alg: 'AES-GCM', kdf: 'PBKDF2-SHA256' });
    expect(JSON.stringify(stored)).not.toContain('X1234567');
    expect(JSON.stringify(stored)).not.toContain('correct horse');
    await audit(page); await capture(page, testInfo, 'settings-vault');

    const other = await f.open('alice', 'vault', 'Travel documents');
    await expect(other.page.getByText('Enter your passphrase to see them.')).toBeVisible();
    await other.page.getByLabel('Passphrase').fill('wrong passphrase'); await other.page.keyboard.press('Enter');
    await expect(other.page.getByText('That passphrase did not work.')).toBeVisible();
    await audit(other.page); await capture(other.page, testInfo, 'settings-vault-locked');
    await other.page.getByLabel('Passphrase').fill('correct horse'); await other.page.keyboard.press('Enter');
    await expect(other.page.getByText('Alice passport', { exact: true })).toBeVisible();
    const bobPage = await f.open('bob', 'vault', 'Travel documents');
    await expect(bobPage.page.getByText('No documents yet.')).toBeVisible();
  } finally { await f.close(); }
});

test('two sessions of one account see each other\'s changes live; other accounts stay separate', async ({ browser, baseURL }, testInfo) => {
  const f = await bridge(browser, testInfo, baseURL);
  try {
    const a = await f.open('alice'); const b = await f.open('alice'); const c = await f.open('bob');
    await a.page.getByLabel('Date format').selectOption('dmy');
    await expect(a.page.getByText(saved, { exact: true })).toBeVisible();
    await expect(b.page.getByLabel('Date format')).toHaveValue('dmy');
    await expect(c.page.getByLabel('Date format')).toHaveValue('auto');
    const fresh = await f.open('alice');
    await expect(fresh.page.getByLabel('Date format')).toHaveValue('dmy');
    // The bridge fixture follows full page loads only, so each section opens in a new page.
    const ta = await f.open('alice', 'templates', 'Templates'); const tb = await f.open('alice', 'templates', 'Templates');
    await expect(tb.page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
    await ta.page.getByRole('button', { name: 'New template', exact: true }).click();
    await ta.page.getByRole('dialog').getByLabel('Template name').fill('City break');
    await ta.page.getByRole('dialog').getByRole('button', { name: 'Create template', exact: true }).click();
    await expect(tb.page.getByText('City break', { exact: true })).toBeVisible();
    expect(f.world.inspectKv(bob.uuid)['me:prefs']).toBeUndefined();
    expect(f.world.counters().calls['kv.list']).toBeUndefined();
    expect(f.world.counters().calls['workers.exec']).toBeUndefined();
  } finally { await f.close(); }
});

test('an offline settings change stays on the device and saves after reconnect', async ({ browser, baseURL }, testInfo) => {
  const f = await bridge(browser, testInfo, baseURL);
  try {
    const { page, context } = await f.open('alice');
    await context.setOffline(true);
    await expect.poll(() => f.host.stats().offlinePages).toBe(1);
    await page.getByRole('button', { name: 'km', exact: true }).click();
    await expect(page.getByText('Saved on this device. It will be saved to your account when you are back online.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'km', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(f.world.inspectKv(alice.uuid)['me:prefs']).toBeUndefined();
    await capture(page, testInfo, 'settings-offline-pending');
    await context.setOffline(false);
    await expect(page.getByText(saved, { exact: true })).toBeVisible();
    expect(f.world.inspectKv(alice.uuid)['me:prefs']).toEqual({ distanceUnit: 'km' });
  } finally { await f.close(); }
});

test('density, accent and high contrast combine and pass axe; the phone tab order moves by keyboard', async ({ page }, testInfo) => {
  await section(page, 'appearance', 'Appearance');
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await page.getByRole('radio', { name: 'Teal' }).click();
  await page.getByRole('switch', { name: 'High contrast' }).click();
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expect(root).toHaveAttribute('data-accent', 'teal');
  await expect(root).toHaveAttribute('data-contrast', 'more');
  await expect(page.getByText(saved, { exact: true })).toBeVisible();
  expect(await kv(page, 'me:prefs')).toMatchObject({ density: 'compact', accent: 'teal', contrast: 'more' });
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'settings-appearance-combined');

  const up = page.getByRole('button', { name: 'Move Week up' });
  await up.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.tab-order-row[data-tab]').nth(2)).toHaveAttribute('data-tab', 'week');
  await expect.poll(async () => (await kv(page, 'me:prefs'))?.tabOrder?.indexOf('week')).toBe(2);
  await page.goto('/mock.html#/');
  await expect(page.getByRole('heading', { name: 'Your trips', exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('data-accent', 'teal');
  if (testInfo.project.use.isMobile) await expect(page.locator('.app-tabbar .app-nav-link').nth(2)).toHaveAttribute('href', '#/week');
  await audit(page); await noOverflow(page); await capture(page, testInfo, 'dashboard-appearance-combined');
});

for (const [id, heading] of [['flight-status', 'Flight status'], ['integrations', 'Integrations'], ['data', 'Your data'], ['delete', 'Delete my data'], ['notifications', 'Notifications'], ['calendar', 'Calendar feed']]) {
  test(`Settings → ${heading} renders and passes axe`, async ({ page }, testInfo) => {
    await page.goto(`/mock.html#/settings/${id}`);
    await expect(page.locator('html')).toHaveAttribute('data-boot', 'ready');
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await expect(page.locator('.settings-section [aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('.view-error')).toHaveCount(0);
    await audit(page); await noOverflow(page); await capture(page, testInfo, `settings-${id}`);
  });
}
