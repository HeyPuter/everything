import { test, expect } from '@playwright/test';

// puter.js's <puter-user-menu>: where the SDK defines it, it sits after Settings and holds the
// Apps launcher and the account; the app's own Apps button, account label and the account rows
// of Settings stand down, and its Sign out is the app's. The SDK and the element are stubbed:
// an open shadow root with the Sign out item, as the real element has, defined before
// `window.puter` as the SDK does.
async function setup(page, { env = 'web', url = '/' } = {}) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      customElements.define('puter-user-menu', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<button class="avatar" part="avatar">A</button>' +
            '<div class="menu"><button class="menu-item sign-out">Sign out</button></div>';
          this.shadowRoot.querySelector('.sign-out').addEventListener('click', () => {
            window.elementSignOuts = (window.elementSignOuts || 0) + 1;
          });
        }
      });
      let signedIn = true;
      window.sdkSignOuts = 0;
      window.puter = { env: '${env}', auth: {
        isSignedIn: () => signedIn,
        getUser: async () => ({ username: 'Alice', uuid: 'alice' }),
        signIn: async () => { signedIn = true; return { username: 'Alice', uuid: 'alice' }; },
        signOut: async () => { signedIn = false; window.sdkSignOuts++; },
      }, fs: { readdir: async () => [] }, ui: {} };`,
    }),
  );
  await page.goto(url);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const userMenu = (page) => page.locator('.header-right puter-user-menu');
const settingsButton = (page) => page.getByRole('button', { name: 'Settings', exact: true });

test('the user menu follows Settings and stands in for the Apps button and the account', async ({
  page,
}) => {
  await setup(page);
  await settled(page);
  await expect(userMenu(page)).toHaveCount(1);
  expect(
    await userMenu(page).evaluate((menu) =>
      menu.previousElementSibling?.getAttribute('aria-label'),
    ),
  ).toBe('Settings');
  await expect(page.locator('.apps-btn')).toBeHidden();
  await expect(page.locator('.user-menu-slot')).toHaveCount(0);

  // Settings keeps the appearance, the shortcuts and About, without the account.
  await settingsButton(page).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByLabel('Appearance')).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(settings.getByText('Signed in as Alice')).toBeHidden();

  // The element follows an explicit theme, and the OS otherwise.
  await expect(userMenu(page)).not.toHaveAttribute('theme', /./);
  await settings.getByLabel('Appearance').selectOption('dark');
  await expect(userMenu(page)).toHaveAttribute('theme', 'dark');
  await settings.getByLabel('Appearance').selectOption('system');
  await expect(userMenu(page)).not.toHaveAttribute('theme', /./);
});

test('the library has it too, in place of the account label', async ({ page }) => {
  await setup(page, { url: '/#library' });
  await expect(page.locator('.home .header-right puter-user-menu')).toHaveCount(1);
  await expect(page.locator('.account-label')).toBeHidden();
  await expect(page.locator('.apps-btn')).toBeHidden();
});

test("its Sign out is the app's: the account goes and the library follows", async ({ page }) => {
  await setup(page);
  await settled(page);
  await expect(page.getByRole('button', { name: 'Save to Puter', exact: true })).toBeVisible();
  await userMenu(page).evaluate((menu) => menu.shadowRoot.querySelector('.sign-out').click());
  await expect(page.locator('.home')).toBeVisible();
  expect(await page.evaluate(() => [window.sdkSignOuts, window.elementSignOuts || 0])).toEqual([
    1, 0,
  ]);
});

test("a Puter desktop window keeps the app's own account controls", async ({ page }) => {
  await setup(page, { env: 'app' });
  await settled(page);
  await expect(userMenu(page)).toHaveCount(0);
  await settingsButton(page).click();
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }).getByText('Signed in as Alice'),
  ).toBeVisible();
});
