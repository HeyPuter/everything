import { test, expect } from '@playwright/test';

// Leaving an unsaved PDF offers "Sign in and save". A sign-in that could not even start
// (Puter unreachable, its window blocked) used to leave the reader where they were with no
// word of why; a sign-in the reader closed stays quiet.
async function editAndLeave(page) {
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => document.querySelector('.workspace').focus());
  await page.keyboard.press('ControlOrMeta+Shift+r');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save before leaving?' })
    .getByRole('button', { name: 'Sign in and save', exact: true })
    .click();
}

test('a sign-in that cannot start says why, and the PDF stays open', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await editAndLeave(page);
  await expect(page.locator('#toast')).toHaveText(
    'Puter is unavailable. You can still open and download PDFs on this device.',
  );
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('a sign-in the reader closes leaves the PDF open without a message', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => false, getUser: async () => null,
        signIn: () => { window.signInAsked = true; return Promise.reject({ error: 'auth_window_closed' }); } },
        fs: {}, ui: {} };`,
    }),
  );
  await editAndLeave(page);
  await expect.poll(() => page.evaluate(() => window.signInAsked)).toBe(true);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('.editor')).toBeVisible();
  await expect(page.locator('#toast')).toBeHidden();
});
