import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { unzipSync } from 'fflate';
import { audit, bridgeWorld, capture, noOverflow } from './helpers/bridge-world.js';

// R6 Settings → Notifications: channels, the activity grid, per-trip choices, URL checks and failures on save.
const day = (offset) => { const date = new Date(Date.now() + offset * 86_400_000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
async function notifications(w, as) {
  const page = await w.open(as, '#/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true }).first()).toBeVisible();
  await expect(page.locator('.settings-section [aria-busy="true"]')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Send notifications while Trips is closed' })).toBeVisible();
  return page;
}

test('channels, the activity grid and trips render; webhook URLs are checked inline; the master switch explains the limits', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL);
  try {
    await w.sharedTrip({ title: 'Lisbon', start: day(10), end: day(14) });
    const page = await notifications(w, 'alice');
    for (const name of ['Webhook', 'ntfy', 'Email digests', 'What to send', 'Trip reminders', 'Trips']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: / by (Webhook|ntfy|Email digests)$/ })).toHaveCount(29);
    await expect(page.getByRole('combobox', { name: 'Notifications for Lisbon' })).toHaveValue('all');
    await page.getByRole('button', { name: 'Send a test' }).click();
    await expect(page.getByText('Turn on and save a channel first.')).toBeVisible();
    await audit(page); await noOverflow(page); await capture(page, testInfo, 'notifications-settings');

    const master = page.getByRole('switch', { name: 'Send notifications while Trips is closed' });
    await master.focus(); await page.keyboard.press('Space');
    await expect(master).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/^Background notifications aren’t available here\./)).toBeVisible();
    await expect.poll(() => w.world.inspectKv('alice')['me:notify']?.on).toBe(true);

    await page.getByRole('switch', { name: 'Send to a webhook' }).click();
    await expect(page.getByRole('button', { name: 'Show signing secret' })).toBeEnabled();
    const url = page.getByLabel('Webhook URL');
    const save = page.locator('form').filter({ has: url }).getByRole('button', { name: 'Save', exact: true });
    for (const [value, message] of [
      ['http://hooks.example.org/trips', 'Use an https address.'],
      ['https://me:secret@hooks.example.org/trips', 'Remove the user name and password from the address.'],
      ['https://192.168.1.20/trips', 'Use a public address. Local and private networks can’t be reached.'],
    ]) {
      await url.fill(value); await save.click();
      await expect(page.getByText(message)).toBeVisible();
      await expect(url).toBeFocused();
    }
    expect(w.world.inspectKv('alice')['me:notify:secret']?.webhookUrl).toBeUndefined();
    await audit(page);
    await url.fill('https://hooks.example.org/trips'); await save.click();
    await expect(page.getByText('Notification settings saved')).toBeVisible();
    await expect.poll(() => w.world.inspectKv('alice')['me:notify:secret']?.webhookUrl).toBe('https://hooks.example.org/trips');
    await page.getByRole('combobox', { name: 'Notifications for Lisbon' }).selectOption('reminders');
    await expect.poll(() => Object.values(w.world.inspectKv('alice')['me:notify']?.trips ?? {})).toEqual(['reminders']);
    await page.getByRole('checkbox', { name: 'Chat by Webhook' }).check();
    await expect.poll(() => w.world.inspectKv('alice')['me:notify']?.events?.chat).toContain('webhook');

    await page.reload();
    await expect(page.getByRole('switch', { name: 'Send to a webhook' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Webhook URL')).toHaveValue('https://hooks.example.org/trips');
    await expect(page.getByRole('combobox', { name: 'Notifications for Lisbon' })).toHaveValue('reminders');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('a save that fails for credit or connection shows the alert and keeps the form', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await notifications(w, 'alice');
    const url = page.getByLabel('Webhook URL');
    const save = page.locator('form').filter({ has: url }).getByRole('button', { name: 'Save', exact: true });
    await url.fill('https://hooks.example.org/trips');
    w.world.failNext({ method: 'kv.set', as: 'alice', status: 402 });
    await save.click();
    await expect(page.locator('.settings-alert')).toHaveText('Your Puter credit has run out. Add credit, then try again.');
    await expect(url).toHaveValue('https://hooks.example.org/trips');
    await audit(page); await capture(page, testInfo, 'notifications-credit');
    const context = await w.context('alice');
    await context.setOffline(true);
    await save.click();
    await expect(page.locator('.settings-alert')).toHaveText('You are offline. Reconnect and try again.');
    await context.setOffline(false);
    await save.click();
    await expect(page.locator('.settings-alert')).toBeHidden();
    await expect.poll(() => w.world.inspectKv('alice')['me:notify:secret']?.webhookUrl).toBe('https://hooks.example.org/trips');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});

test('the notification secret stays out of the data download', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const w = await bridgeWorld(browser, testInfo, baseURL, { users: ['alice'] });
  try {
    const page = await notifications(w, 'alice');
    await page.getByLabel('Webhook URL').fill('https://hooks.example.org/trips');
    await page.locator('form').filter({ has: page.getByLabel('Webhook URL') }).getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => w.world.inspectKv('alice')['me:notify:secret']?.webhookSecret).toBeTruthy();
    const { webhookSecret } = w.world.inspectKv('alice')['me:notify:secret'];
    await page.getByRole('link', { name: 'Your data', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my data', exact: true }).click()]);
    const file = testInfo.outputPath('data.zip'); await download.saveAs(file);
    const entries = unzipSync(new Uint8Array(readFileSync(file)));
    const text = Object.values(entries).map((bytes) => Buffer.from(bytes).toString('utf8')).join('\n');
    expect(Object.keys(entries).length).toBeGreaterThan(0);
    expect(text).not.toContain(webhookSecret);
    expect(text).not.toContain('hooks.example.org');
    expect(w.errors).toEqual([]);
  } finally { await w.close(); }
});
