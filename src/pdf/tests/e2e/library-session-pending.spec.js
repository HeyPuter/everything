import { test, expect } from '@playwright/test';

// The library at its own address showed someone already signed in "Your PDFs, in your own
// cloud" and a Sign in with Puter button while Puter was still reading who they were. It now
// waits for the answer, and asks a person who is signed out, or has no Puter, to sign in.
const sdk = (signedIn) => `
  window.puter = {
    env: 'web',
    auth: {
      // The first question waits for the test; later ones have their answer.
      isSignedIn: () =>
        window.answered
          ? Promise.resolve(${signedIn})
          : new Promise((resolve) => {
              window.answer = () => {
                window.answered = true;
                resolve(${signedIn});
              };
            }),
      getUser: async () => ({ username: 'test-user' }),
    },
    fs: { readdir: async () => [{ name: 'kept.pdf', path: 'PDF Editor/kept.pdf', size: 1000, modified: 1700000000 }] },
    ui: {},
  };`;

test('the library waits for Puter to say who is signed in', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: sdk(true) }),
  );
  await page.goto('/#library');
  await expect.poll(() => page.evaluate(() => typeof window.answer)).toBe('function');
  await expect(page.locator('.file-list')).toHaveText('Loading your PDFs…');
  await expect(page.getByRole('button', { name: 'Sign in with Puter' })).toHaveCount(0);
  await page.evaluate(() => window.answer());
  await expect(page.locator('.file-open')).toHaveText(['kept.pdf']);
});

test('the library asks someone signed out to sign in once Puter says so', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: sdk(false) }),
  );
  await page.goto('/#library');
  await expect.poll(() => page.evaluate(() => typeof window.answer)).toBe('function');
  await expect(page.locator('.file-list')).toHaveText('Loading your PDFs…');
  await page.evaluate(() => window.answer());
  await expect(page.getByRole('button', { name: 'Sign in with Puter' })).toBeVisible();
});

test('the library without Puter invites a sign-in rather than loading forever', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  await expect(page.getByRole('button', { name: 'Sign in with Puter' })).toBeVisible();
});
