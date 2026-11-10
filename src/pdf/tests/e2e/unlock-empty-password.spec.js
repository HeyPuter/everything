import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('opening a protected PDF without typing its password says what is missing', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'locked.pdf',
    mimeType: 'application/pdf',
    buffer: await readFile(new URL('../fixtures/security/aes-256-r5.pdf', import.meta.url)),
  });
  const dialog = page.getByRole('dialog', { name: 'Password required', exact: true });
  const input = dialog.getByLabel('Password', { exact: true });
  await expect(input).toBeFocused();
  // Open did nothing at all with the field empty: no message, the dialog just stayed.
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter the password to open the PDF.');
  await expect(input).toBeFocused();
  await input.fill('user');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');

  await page.getByRole('button', { name: 'Protected', exact: true }).click();
  const owner = page.getByRole('dialog', { name: 'Permissions password required', exact: true });
  await owner.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(owner.getByRole('alert')).toHaveText('Enter the permissions password.');
  await expect(owner.getByLabel('Permissions password', { exact: true })).toBeFocused();
});
