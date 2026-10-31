import { test, expect } from '@playwright/test';
import { audit, noOverflow } from './helpers/bridge-world.js';
import { choose, chooseFiles, patientWorld, tripFor } from './helpers/trip-flows.js';

const DATES = { start: '2026-11-02', end: '2026-11-05' };
const PNG = { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64') };
const PDF = { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% invoice\n%%EOF\n') };
const entry = (page, name) => page.locator('.costs-entry').filter({ has: page.locator('.costs-entry-name', { hasText: new RegExp(`^${name}$`) }) });
const toast = (page, text) => page.locator('.toast').filter({ hasText: text });

async function scan(page) {
  await chooseFiles(page, () => page.locator('.costs-toolbar').getByRole('button', { name: 'Scan receipt' }).click(), [PNG]);
  return page.getByRole('dialog', { name: 'Read a receipt' });
}
async function openDetail(page, name) {
  await page.locator('.costs-entry-main').filter({ hasText: name }).click();
  return page.getByRole('dialog', { name });
}

test.describe('receipts and weight presets', () => {
  test('a scanned receipt prefills a shared expense and attaches its photo, but never to a private one', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('costs'));
      let reader = await scan(alice);
      await expect(reader).toContainText('Here is what the receipt says');
      await expect(reader).toContainText('Café Central');
      await expect(reader).toContainText('€18.50');
      await expect(reader.getByRole('checkbox', { name: 'Attach the photo to the expense' })).toBeChecked();
      await audit(alice);
      await reader.getByRole('button', { name: 'Review expense' }).click();
      const form = alice.getByRole('dialog', { name: 'New expense' });
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Café Central');
      await expect(form.getByLabel('Amount', { exact: true })).toHaveValue('18.50');
      await expect(form.getByLabel('Category', { exact: true })).toHaveValue('food');
      await form.getByRole('button', { name: 'Add expense', exact: true }).click();
      await expect(toast(alice, 'Receipt attached.')).toBeVisible({ timeout: 15_000 });

      const bob = await w.open('bob', trip.hash('costs'));
      const detail = await openDetail(bob, 'Café Central');
      await expect(detail.locator('.file-attachment')).toHaveCount(1);
      await audit(bob);
      await bob.keyboard.press('Escape');

      reader = await scan(alice);
      await reader.getByRole('button', { name: 'Review expense' }).click();
      const privateForm = alice.getByRole('dialog', { name: 'New expense' });
      await privateForm.getByLabel('Name', { exact: true }).fill('Café for me');
      await privateForm.getByRole('checkbox', { name: /^Private expense/ }).check();
      await privateForm.getByRole('button', { name: 'Add expense', exact: true }).click();
      await expect(toast(alice, 'Private expenses cannot have attachments, so the receipt was not added.')).toBeVisible();
      await expect(entry(alice, 'Café for me')).toContainText('Private');
      await expect(entry(bob, 'Café for me')).toHaveCount(0);

      await alice.evaluate(() => globalThis.__TRIPS_AI__.fail('credit', { times: 1 }));
      reader = await scan(alice);
      await expect(reader).toContainText('You are out of Puter credit for AI.');
      await expect(reader.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      await reader.getByRole('button', { name: 'Fill in manually' }).click();
      await expect(alice.getByRole('dialog', { name: 'New expense' }).getByLabel('Name', { exact: true })).toHaveValue('');
      await alice.keyboard.press('Escape');

      await alice.evaluate(() => globalThis.__TRIPS_AI__.fail('offline', { times: 1 }));
      reader = await scan(alice);
      await expect(reader).toContainText('Reading receipts needs a connection.');
      await reader.getByRole('button', { name: 'Try again' }).click();
      await expect(reader).toContainText('Here is what the receipt says');
      await noOverflow(alice);
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('receipts added in the form and the detail are trip files; a private expense has none', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('costs'));
      await alice.locator('.costs-toolbar').getByRole('button', { name: 'Add expense' }).click();
      const form = alice.getByRole('dialog', { name: 'New expense' });
      await form.getByLabel('Name', { exact: true }).fill('Museum tickets');
      await form.getByLabel('Amount', { exact: true }).fill('30');
      await chooseFiles(alice, () => form.getByRole('button', { name: 'Add receipt' }).click(), [PDF]);
      await expect(form.locator('.costs-receipt-list')).toContainText('invoice.pdf');
      await form.getByRole('checkbox', { name: /^Private expense/ }).check();
      await expect(form.getByRole('button', { name: 'Add receipt' })).toBeHidden();
      await form.getByRole('checkbox', { name: /^Private expense/ }).uncheck();
      await form.getByRole('button', { name: 'Add expense', exact: true }).click();
      await expect(toast(alice, 'Receipt attached.')).toBeVisible({ timeout: 15_000 });

      const bob = await w.open('bob', trip.hash('costs'));
      const detail = await openDetail(bob, 'Museum tickets');
      await expect(detail.locator('.file-attachment')).toContainText('invoice.pdf');
      await detail.getByRole('button', { name: 'Attach files' }).click();
      const picker = bob.getByRole('dialog', { name: 'Attach files' });
      await chooseFiles(bob, () => picker.getByRole('button', { name: 'Upload from device' }).click(), [{ name: 'second.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% second\n%%EOF\n') }]);
      await expect(picker.getByRole('checkbox', { name: /second\.pdf/ })).toHaveAttribute('aria-checked', 'true');
      await picker.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(detail.locator('.file-attachment')).toHaveCount(2);
      const files = await w.open('alice', trip.hash('files'));
      await expect(files.getByText('second.pdf').first()).toBeVisible();
      await expect(files.getByText('invoice.pdf').first()).toBeVisible();
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });

  test('weight presets are managed, picked and saved from an expense', async ({ browser, baseURL }, testInfo) => {
    test.setTimeout(150_000);
    const w = await patientWorld(browser, testInfo, baseURL);
    try {
      const trip = await tripFor(w, DATES);
      const alice = await w.open('alice', trip.hash('costs'));
      await choose(alice, alice.getByRole('button', { name: 'More cost actions' }), 'Weight presets');
      const manager = alice.getByRole('dialog', { name: 'Weight presets' });
      await expect(manager).toContainText('No presets yet');
      await audit(alice);
      await manager.getByRole('button', { name: 'New preset' }).click();
      const create = alice.getByRole('dialog', { name: 'New weight preset' });
      await create.getByLabel('Name', { exact: true }).fill('Family of three');
      await create.getByLabel('Share for You').fill('3');
      await create.getByLabel('Share for bob').fill('1');
      await create.getByRole('button', { name: 'Create preset' }).click();
      await expect(manager).toContainText('You ×3 · bob ×1');
      await alice.keyboard.press('Escape');

      const bob = await w.open('bob', trip.hash('costs'));
      await bob.locator('.costs-toolbar').getByRole('button', { name: 'Add expense' }).click();
      const form = bob.getByRole('dialog', { name: 'New expense' });
      await form.getByLabel('Name', { exact: true }).fill('Groceries');
      await form.getByLabel('Amount', { exact: true }).fill('100');
      await form.getByLabel('Weight preset').selectOption({ label: 'Family of three' });
      await expect(form.getByRole('button', { name: 'Shares', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(form.locator('.costs-share')).toHaveText(['€75.00', '€25.00']);
      await form.getByLabel('Shares for You').fill('2');
      await form.getByRole('button', { name: 'Save as preset' }).click();
      const prompt = bob.getByRole('dialog', { name: 'Save shares as a preset' });
      await prompt.getByRole('textbox').fill('Even-ish');
      await prompt.getByRole('button', { name: 'Save preset' }).click();
      await expect(form.getByLabel('Weight preset')).toHaveValue(/.+/);
      await audit(bob);
      await noOverflow(bob);
      await form.getByRole('button', { name: 'Add expense', exact: true }).click();
      await expect(entry(alice, 'Groceries')).toContainText('Split 2 ways');
      await choose(alice, alice.getByRole('button', { name: 'More cost actions' }), 'Weight presets');
      await expect(alice.getByRole('dialog', { name: 'Weight presets' })).toContainText('Even-ish');
      expect(w.errors).toEqual([]);
    } finally { await w.close(); }
  });
});
