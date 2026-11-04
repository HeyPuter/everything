import { test, expect } from '@playwright/test';

/**
 * A web page with a long stretch of spaces (a few hundred kilobytes, easily made or sent) held the window
 * for minutes while it opened: its whitespace was trimmed with regular expressions whose time grew with
 * the square of the stretch. It opens in moments, as any page that size.
 */
test('a web page with a long stretch of spaces opens without holding the window', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('input[type=file][aria-label="Open DOCX file"]').setInputFiles({ name: 'spaced.html', mimeType: 'text/html', buffer: Buffer.from(`<p>Start${' '.repeat(300000)}end</p>`) });
  await expect(page.getByRole('textbox', { name: 'Document name' })).toHaveValue('spaced', { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('Start end', { timeout: 15000 });
});
