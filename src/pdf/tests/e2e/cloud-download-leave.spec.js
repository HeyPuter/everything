import { test, expect } from '@playwright/test';

async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      window.writes = 0;
      window.puter = {
        env: 'web',
        auth: {
          isSignedIn: () => true,
          getUser: async () => ({ username: 'test-user' }),
          signIn: async () => {},
          signOut: async () => {},
        },
        fs: {
          readdir: async () => [],
          write: async (path) => {
            window.writes++;
            return { path, name: path.split('/').pop() };
          },
        },
        ui: {},
      };`,
    }),
  );
}
async function rotate(page) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page', exact: true }).click();
  }
  await page.getByRole('menuitem', { name: 'Rotate clockwise', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
}
async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await pending;
}

test('downloading a PDF saved in Puter keeps its newer changes unsaved there', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Save to Puter', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  await rotate(page);
  await download(page);
  // A download is a copy: the file in Puter still lacks the rotation.
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await expect(page).toHaveTitle(/^\* /);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Leave this PDF?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save and leave', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.writes)).toBe(2);
});

test('downloading a PDF that is not in Puter leaves nothing unsaved', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await rotate(page);
  await download(page);
  await expect(page.locator('.save-status')).toHaveText('Downloaded');
  await expect(page).not.toHaveTitle(/^\* /);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New blank PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.writes)).toBe(0);
});
