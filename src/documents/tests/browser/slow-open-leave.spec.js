import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });

async function savedDocumentAndList(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Hello world.');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.locator('.file-row')).toHaveCount(1);
}
// The next read of the document takes this long (a large file on a slow connection, or a request that hangs).
const slowRead = (page, delay) => page.evaluate(ms => window.__puterFaults.push({ op: 'read', path: 'Untitled', delay: ms, times: 1 }), delay);

test('going back while a document is still opening does not wait for it', async ({ page }) => {
  await savedDocumentAndList(page);
  await slowRead(page, 20000);
  await page.locator('.file-row .file-main').click();
  await expect(page.locator('.auth-view')).toContainText('Opening');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 3000 });
});

test('a document that is slow to open offers Cancel', async ({ page }) => {
  await savedDocumentAndList(page);
  await slowRead(page, 20000);
  await page.locator('.file-row .file-main').click();
  // Inside the Puter desktop there is no Back button: the wait itself offers the way out.
  await page.locator('.auth-view').getByRole('button', { name: 'Cancel' }).click({ timeout: 5000 });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible({ timeout: 3000 });
});

test('coming back to a document whose opening was left opens it', async ({ page }) => {
  await savedDocumentAndList(page);
  await slowRead(page, 3000);
  await page.locator('.file-row .file-main').click();
  await expect(page.locator('.auth-view')).toContainText('Opening');
  await page.goBack();
  await page.goForward();
  await expect(text(page)).toHaveValue('Hello world.', { timeout: 15000 });
});
