import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

// puter.js's <puter-user-menu>: where the SDK defines it, it ends the title bar and holds the
// Apps launcher and the account; the app's own Sign in button and account button stand down, and
// the app follows a sign-in or sign-out the element did. The SDK and the element are stubbed: an
// open shadow root with the picture and the Sign out item, as the real element has, defined
// before `window.puter` as the SDK does.
async function setup(page, { env = 'web', element = true, signedIn = true, query = '' } = {}) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      if (${element}) customElements.define('puter-user-menu', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<button class="avatar" part="avatar">A</button>' +
            '<div class="menu"><button class="menu-item sign-out">Sign out</button></div>';
        }
      });
      window.sdk = { signedIn: ${signedIn}, signIns: 0, signOuts: 0, settings: null };
      window.puter = { env: '${env}', auth: {
        isSignedIn: () => window.sdk.signedIn,
        getUser: async () => ({ username: 'Alice', uuid: 'alice' }),
        getProfilePicture: async () => null,
        signIn: async () => { window.sdk.signIns++; window.sdk.signedIn = true; },
        signOut: async () => { window.sdk.signOuts++; window.sdk.signedIn = false; },
      }, kv: { get: async () => window.sdk.settings, set: async () => true }, fs: { readdir: async () => [] }, ui: {} };`,
    }),
  );
  return openApp(page, query);
}
const userMenu = (page) => page.locator('.titlebar puter-user-menu');
const ownSignIn = (page) => page.locator('.account').getByRole('button', { name: 'Sign in' });
const ownAccount = (page) => page.getByRole('button', { name: 'Account: Alice' });

test('the user menu ends the title bar and stands in for the account button', async ({ page }) => {
  const errors = await setup(page);
  await expect(userMenu(page)).toHaveCount(1);
  expect(await userMenu(page).evaluate((menu) => [menu.previousElementSibling.className, menu.nextElementSibling, menu.parentElement.className])).toEqual(['account', null, 'tb-right']);
  await expect(page.locator('.user-menu-slot')).toHaveCount(0);
  await expect(page.locator('.account')).toBeHidden();
  await expect(ownAccount(page)).toHaveCount(0);

  // The element follows an explicit theme, and the OS otherwise.
  await expect(userMenu(page)).not.toHaveAttribute('theme', /./);
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(userMenu(page)).toHaveAttribute('theme', 'dark');
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(userMenu(page)).not.toHaveAttribute('theme', /./);
  expect(errors).toEqual([]);
});

test('the app follows a sign-in and a sign-out the element did', async ({ page }) => {
  await setup(page, { signedIn: false });
  await expect(userMenu(page)).toHaveCount(1);
  await expect(ownSignIn(page)).toHaveCount(0);

  // The element has signed in by the time it says so: the account's settings arrive.
  await userMenu(page).evaluate((menu) => {
    window.sdk.signedIn = true;
    window.sdk.settings = { theme: 'dark' };
    menu.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'Alice' } } }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(userMenu(page)).toHaveAttribute('theme', 'dark');
  await expect(page.locator('.account')).toBeHidden();

  // Signing out drops what this browser kept of the account.
  await userMenu(page).evaluate((menu) => {
    localStorage.setItem('bd.profilePicture', JSON.stringify({ user: 'Alice', url: 'data:image/png;base64,AAAA' }));
    window.bd.user = { username: 'Alice' };
    window.sdk.signedIn = false;
    menu.dispatchEvent(new CustomEvent('signout'));
  });
  expect(await page.evaluate(() => [localStorage.getItem('bd.profilePicture'), window.bd.user, window.sdk.signIns, window.sdk.signOuts])).toEqual([null, null, 0, 0]);
  await expect(page.locator('.account')).toBeHidden();
});

test('shortcuts leave keys from inside the element alone', async ({ page }) => {
  await setup(page, { query: '?sample' });
  await expect(userMenu(page)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!window.bd.doc)).toBe(true);
  const tool = () => page.evaluate(() => window.bd.tool?.constructor.name ?? null);
  const before = await tool();
  await userMenu(page).locator('.avatar').focus();
  await page.keyboard.press('w');
  await page.keyboard.press('a');
  expect(await page.evaluate(() => window.bd.keyBuffer || '')).toBe('');
  expect(await tool()).toBe(before);
  // Enter on its button is the button's, not "repeat the last command".
  const prevented = await userMenu(page).evaluate((menu) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true });
    menu.shadowRoot.querySelector('.avatar').dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);

  // From the drawing the same two letters start the Wall tool.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('w');
  await page.keyboard.press('a');
  await expect.poll(tool).toBe('WallTool');
});

test("a puter.js without the element keeps the app's own account controls", async ({ page }) => {
  await setup(page, { element: false });
  await expect(userMenu(page)).toHaveCount(0);
  await ownAccount(page).click();
  await expect(page.getByRole('menu', { name: 'Account' }).getByRole('menuitem')).toHaveText(['Open from Puter', 'Shared With Me', 'Sign out']);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(ownSignIn(page)).toBeVisible();
  expect(await page.evaluate(() => window.sdk.signOuts)).toBe(1);
});

test("a Puter app window keeps the app's own account controls", async ({ page }) => {
  await setup(page, { env: 'app' });
  await expect(ownAccount(page)).toBeVisible();
  await expect(userMenu(page)).toHaveCount(0);
  await ownAccount(page).click();
  await expect(page.getByRole('menu', { name: 'Account' }).getByRole('menuitem')).toHaveText(['Open from Puter', 'Shared With Me']);
});
