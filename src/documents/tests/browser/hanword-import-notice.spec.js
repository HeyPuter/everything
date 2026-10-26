import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('a converted Hanword file says it is an editable copy and lists its conversion notes', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/home');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await (await chooser).setFiles({ name: 'SimpleCompose.hwpx', mimeType: 'application/hwp+zip', buffer: readFileSync('tests/fixtures/hwpx/SimpleCompose.hwpx') });
  const notice = page.locator('.canvas-message .import-notice');
  await expect(notice.locator('summary')).toHaveText(/^Hanword HWPX import · Editing a DOCX copy · \d+ conversion notes?$/, { timeout: 20000 });
  await notice.locator('summary').click();
  await expect(notice).toContainText('SimpleCompose.hwpx was converted to an editable document. Changes save as a new .docx file. The original Hanword file is unchanged.');
  await expect(notice.getByRole('listitem').filter({ hasText: 'Overlapping characters are imported as text.' })).toHaveCount(1);
  // The bar is dismissed like the editor's other notices.
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice).toBeHidden();
  expect(errors).toEqual([]);
});
