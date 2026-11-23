import { test, expect } from '@playwright/test';

// Renaming, duplicating, deleting or downloading a PDF in the library said nothing: the list
// changed, or did not, and a screen reader heard only the focus land in Search PDFs. The editor
// says what it did ("Renamed to …", "PDF downloaded."); the library now does too.
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.names = ['first.pdf', 'second.pdf'];
        window.puter = {
          env: 'web',
          auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test-user' }) },
          fs: {
            readdir: async () => window.names.map((name) => ({ name, path: 'PDF Editor/' + name, size: 1000, modified: 1700000000 })),
            read: async () => new Blob(['%PDF-1.4']),
            rename: async (path, name) => {
              window.names = window.names.map((n) => ('PDF Editor/' + n === path ? name : n));
              return { name, path: 'PDF Editor/' + name };
            },
            write: async (path) => {
              const name = path.split('/').pop().replace('.pdf', ' (1).pdf');
              window.names.push(name);
              return { name, path: 'PDF Editor/' + name };
            },
            delete: async (path) => {
              window.names = window.names.filter((n) => 'PDF Editor/' + n !== path);
            },
          },
          ui: {},
        };`,
    }),
  );
  await page.goto('/#library');
  await expect(page.locator('.file-open')).toHaveCount(2);
});

const choose = async (page, file, action) => {
  await page.getByRole('button', { name: `Options for ${file}`, exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
};

test('renaming a PDF in the library says so', async ({ page }) => {
  await choose(page, 'first.pdf', 'Rename');
  const dialog = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
  await dialog.getByLabel('File name').fill('budget');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Renamed to budget.pdf.');
  await expect(page.getByRole('button', { name: 'budget.pdf', exact: true })).toBeVisible();
});

test('duplicating a PDF in the library names the copy', async ({ page }) => {
  await choose(page, 'first.pdf', 'Duplicate');
  await expect(page.locator('#toast')).toHaveText('Saved a copy as first copy (1).pdf.');
  await expect(page.locator('.file-open')).toHaveCount(3);
});

test('deleting a PDF in the library says so', async ({ page }) => {
  await choose(page, 'second.pdf', 'Delete');
  await page
    .getByRole('dialog', { name: 'Delete PDF?', exact: true })
    .getByRole('button', { name: 'Delete PDF', exact: true })
    .click();
  await expect(page.locator('#toast')).toHaveText('second.pdf deleted.');
  await expect(page.locator('.file-open')).toHaveText(['first.pdf']);
});

test('downloading a PDF from the library says so', async ({ page }) => {
  const download = page.waitForEvent('download');
  await choose(page, 'first.pdf', 'Download');
  expect((await download).suggestedFilename()).toBe('first.pdf');
  await expect(page.locator('#toast')).toHaveText('PDF downloaded.');
});
