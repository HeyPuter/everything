import { test, expect } from '@playwright/test';

// The Puter SDK loads asynchronously after the app renders. A cloud action taken while it was
// still on its way (a slow connection) said Puter was unavailable, as if it never would be.
test('a cloud action before Puter has loaded says it is still loading', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('https://plausible.io/**', (route) => route.abort());
  await page.route('https://js.puter.com/**', async (route) => {
    await held;
    await route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => false, getUser: async () => null,
        signIn: () => { window.signInAsked = true; return Promise.reject({ error: 'auth_window_closed' }); } },
        fs: { readdir: async () => [] }, ui: {} };`,
    });
  });
  await page.goto('/#library', { waitUntil: 'commit' });
  // The library itself waits for Puter to say who is signed in before it offers a sign-in.
  await expect(page.locator('.file-list')).toHaveText('Loading your PDFs…');
  await page.getByRole('button', { name: 'Open from Puter', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Puter is still loading. Try again in a moment.');
  release();
  await page.waitForLoadState('load');
  await page.locator('.file-list').getByRole('button', { name: 'Sign in with Puter' }).click();
  await expect.poll(() => page.evaluate(() => window.signInAsked)).toBe(true);
});
