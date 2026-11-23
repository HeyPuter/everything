import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// A refused password was only said in a message: the field it was about was not marked, so a
// screen reader back in it did not hear that it was refused.
test('a refused password marks its field until it is changed', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'aes-256.pdf',
    mimeType: 'application/pdf',
    buffer: await readFile(new URL('../fixtures/security/aes-256.pdf', import.meta.url)),
  });
  const ask = page.getByRole('dialog', { name: 'Password required' });
  const password = ask.getByLabel('Password', { exact: true });
  await password.fill('User');
  await password.press('Enter');
  await expect(ask.getByRole('alert')).toHaveText('That password is not right. Try again.');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toBeFocused();
  await password.fill('user');
  await expect(password).not.toHaveAttribute('aria-invalid');
  await password.press('Enter');
  await expect(ask).toBeHidden();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
});

test('Protect with password marks the field it refuses', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await chooser
  ).setFiles({
    name: 'plain.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Protect a PDF' }).first().click();
  await page.getByRole('button', { name: 'Protect with password…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Protect with password' });
  await dialog.getByLabel('Password to open').fill('secret-1');
  const confirm = dialog.getByLabel('Confirm password');
  await confirm.fill('secret-2');
  await confirm.press('Enter');
  await expect(dialog.getByRole('alert')).toHaveText('The passwords do not match.');
  await expect(confirm).toHaveAttribute('aria-invalid', 'true');
  await expect(confirm).toBeFocused();
  await expect(dialog.getByLabel('Password to open')).not.toHaveAttribute('aria-invalid');
  await confirm.fill('secret-1');
  await expect(confirm).not.toHaveAttribute('aria-invalid');
  await dialog.getByRole('button', { name: 'Protect', exact: true }).click();
  await expect(dialog).toBeHidden();
});
