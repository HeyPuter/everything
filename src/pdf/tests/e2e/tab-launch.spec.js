import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// The Puter dashboard opens a file in its own browser tab. The SDK calls that tab 'web', keeps
// puter.app_instance_id in its address, and hands over the token and the file from the
// dashboard tab moments after loading (puter.openerLaunch_).
async function setup(page, url) {
  const doc = await PDFDocument.create();
  doc.setTitle('Launched file');
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  const bytes = Buffer.from(await doc.save()).toString('base64');
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      window.reads = []; window.subscribed = false; window.sessionReads = 0;
      let token = null;
      const launch = new Promise(resolve => {
        window.hand = () => { token = 'app-token'; resolve(); };
      });
      const item = { path: '/alice/Documents/launch.pdf', name: 'launch.pdf' };
      window.puter = {
        env: 'web',
        get authToken() { return token; },
        openerLaunch_: location.search.includes('puter.app_instance_id') ? launch : null,
        auth: {
          isSignedIn: () => { window.sessionReads++; return !!token; },
          getUser: async () => { if (!token) throw new Error('Not signed in'); return { username: 'Alice' }; },
          signIn: async () => { throw new Error('No sign-in expected'); },
          signOut: async () => { token = null; },
        },
        fs: {
          readdir: async () => [],
          read: async (path) => {
            if (!token) throw new Error('Read before the token arrived');
            window.reads.push(path);
            return new Blob([Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0))]);
          },
        },
        ui: {
          onItemsOpened: (callback) => { window.subscribed = true; launch.then(() => callback([item])); },
          onLaunchedWithItems: () => { throw new Error('Subscribed twice'); },
        },
      };`,
    }),
  );
  await page.goto(url);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

test('a tab Puter opened shows its file and the signed-in account', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page, '/?puter.app_instance_id=abc&puter.item.uid=u1');
  expect(await page.evaluate(() => window.subscribed)).toBe(true);
  // Nothing reads the session before the token is in, so nobody is reported signed out.
  expect(await page.evaluate(() => window.sessionReads)).toBe(0);
  await page.evaluate(() => window.hand());
  await expect(page).toHaveTitle('launch.pdf · PDF Editor');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  expect(await page.evaluate(() => window.reads)).toEqual(['/alice/Documents/launch.pdf']);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toContainText(
    'Signed in as Alice',
  );
  expect(errors).toEqual([]);
});

test('a plain visit does not wait for a Puter launch', async ({ page }) => {
  await setup(page, '/');
  expect(await page.evaluate(() => window.subscribed)).toBe(false);
});
