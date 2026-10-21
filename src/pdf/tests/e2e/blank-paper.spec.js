import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;

// A new PDF is a sheet of the paper the region prints on, as pictures turned into pages are.
for (const [locale, size] of [
  ['en-US', { width: 612, height: 792 }],
  ['de-DE', { width: 595.28, height: 841.89 }],
])
  test.describe(locale, () => {
    test.use({ locale });
    test(`a new blank PDF is ${size.width} by ${size.height} points`, async ({ page }) => {
      await page.route('https://js.puter.com/**', (route) =>
        route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
      );
      await page.goto('/');
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
      await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const doc = await PDFDocument.load(await readFile(await (await pending).path()));
      const { width, height } = doc.getPage(0).getSize();
      expect({
        width: Math.round(width * 100) / 100,
        height: Math.round(height * 100) / 100,
      }).toEqual(size);
    });
  });
