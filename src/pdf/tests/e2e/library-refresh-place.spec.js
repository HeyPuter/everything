import { test, expect } from '@playwright/test';

// Renaming, duplicating, or deleting a PDF in a long library refreshes the list. The rows
// already there stay while the new listing loads, so the reader keeps their place in it.
test('a library refresh after an action keeps the scroll position and the rows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.libraryFiles = Array.from({length: 40}, (_, i) => 'file ' + String(i + 1).padStart(2, '0') + '.pdf');
        window.puter = {
          env: 'web',
          auth: {isSignedIn: () => true, getUser: async () => ({username: 'test-user'})},
          fs: {
            readdir: () => {
              const files = window.libraryFiles.map((name, i) => ({name, path: 'PDF Editor/' + name, size: 1000, modified: 1700000000 - i}));
              window.reads = (window.reads || 0) + 1;
              return new Promise(resolve => { window.finishRead = () => resolve(files); if (!window.holdReads) resolve(files); });
            },
            rename: async (path, name) => { window.libraryFiles = window.libraryFiles.map(f => 'PDF Editor/' + f === path ? name : f); },
          }
        };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-open')).toHaveCount(40);
  const last = page.getByRole('button', { name: 'Options for file 40.pdf', exact: true });
  await last.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => document.scrollingElement.scrollTop);
  expect(scrolled).toBeGreaterThan(300);
  await page.evaluate(() => (window.holdReads = true));
  await last.click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
  await rename.getByLabel('File name', { exact: true }).fill('zz last');
  await rename.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.reads)).toBe(2);
  // While the new listing loads, the old rows stay where they were.
  await expect(page.locator('.file-open')).toHaveCount(40);
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(scrolled);
  await page.evaluate(() => window.finishRead());
  await expect(page.locator('.file-open').last()).toHaveText('zz last.pdf');
  expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(scrolled);
});
