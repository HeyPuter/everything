import { test, expect } from '@playwright/test';

// A PDF deleted elsewhere (another tab, another device) kept its row in the library, and
// opening it said only what Puter's drive said, "Not found", leaving the row to be tried again.
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.names = ['gone.pdf', 'kept.pdf'];
        const missing = () => Object.assign(new Error('Not found'), { code: 'subject_does_not_exist' });
        window.puter = {
          env: 'web',
          auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test-user' }) },
          fs: {
            readdir: async () => window.names.map((name) => ({ name, path: 'PDF Editor/' + name, size: 1000, modified: 1700000000 })),
            read: async () => { throw missing(); },
            stat: async () => { throw missing(); },
            rename: async () => { throw missing(); },
          },
          ui: {},
        };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-open')).toHaveText(['gone.pdf', 'kept.pdf']);
  // Deleted from another device after the listing.
  await page.evaluate(() => (window.names = ['kept.pdf']));
});

test('opening a PDF deleted elsewhere says so and takes it off the list', async ({ page }) => {
  await page.getByRole('button', { name: 'gone.pdf', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('gone.pdf is no longer in your Puter cloud.');
  await expect(page.locator('.file-open')).toHaveText(['kept.pdf']);
  await expect(page.locator('.home')).toBeVisible();
});

test('renaming a PDF deleted elsewhere says so and takes it off the list', async ({ page }) => {
  await page.getByRole('button', { name: 'Options for gone.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
  await dialog.getByLabel('File name').fill('renamed');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('gone.pdf is no longer in your Puter cloud.');
  await expect(page.locator('.file-open')).toHaveText(['kept.pdf']);
});
