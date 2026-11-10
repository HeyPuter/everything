import { test, expect } from '@playwright/test';

// The Apps launcher: a 3×3 button just left of Settings opens puter.com/embed/apps in a panel.
// The embed is stubbed here; puter.com refuses to be framed by localhost anyway.
async function setup(page, { env = 'web', signedIn = true, url = '/' } = {}) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      let signedIn = ${signedIn};
      window.puter = { env: '${env}', auth: {
        isSignedIn: () => signedIn,
        getUser: async () => ({ username: 'Alice', uuid: 'alice' }),
        signIn: async () => { signedIn = true; return { username: 'Alice', uuid: 'alice' }; },
        signOut: async () => { signedIn = false; },
      }, fs: { readdir: async () => [] }, ui: {} };`,
    }),
  );
  await page.route('https://puter.com/embed/apps', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Your apps</p>' }),
  );
  await page.goto(url);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
const appsButton = (page) => page.getByRole('button', { name: 'Apps', exact: true });
const panel = (page) => page.getByRole('dialog', { name: 'Apps', exact: true });

test('the Apps button sits left of Settings and opens the embed', async ({ page }) => {
  await setup(page);
  await settled(page);
  const button = appsButton(page);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  // Immediately left of Settings, the title bar's last control.
  expect(await button.evaluate((b) => b.nextElementSibling?.getAttribute('aria-label'))).toBe(
    'Settings',
  );
  await button.click();
  const dialog = panel(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const frame = dialog.locator('iframe');
  await expect(frame).toHaveAttribute('src', 'https://puter.com/embed/apps');
  await expect(frame).toHaveAttribute('title', 'Your Puter apps');
  await expect(frame).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  await expect(frame).toHaveAttribute('allow', 'clipboard-read; clipboard-write');
  await expect(page.frameLocator('.apps-frame').getByText('Your apps')).toBeVisible();
  await expect(dialog.getByRole('status')).toBeHidden();
  const newTab = dialog.getByRole('link', { name: 'Open your apps in a new tab' });
  await expect(newTab).toHaveAttribute('href', 'https://puter.com/#apps');
  await expect(newTab).toHaveAttribute('target', '_blank');
  await expect(newTab).toHaveAttribute('rel', 'noopener noreferrer');
  // The caret points at the button's centre.
  const caret = await page.evaluate(() => {
    const p = document.querySelector('.apps-panel').getBoundingClientRect();
    const b = document.querySelector('.apps-btn').getBoundingClientRect();
    const x = parseFloat(
      getComputedStyle(document.querySelector('.apps-panel')).getPropertyValue('--apps-caret-x'),
    );
    // The top as placed, not as the opening slide has it at the moment.
    const top = parseFloat(
      document.querySelector('.apps-panel').style.getPropertyValue('--apps-panel-top'),
    );
    return { tip: p.left + x, centre: b.left + b.width / 2, below: top - b.bottom };
  });
  expect(Math.abs(caret.tip - caret.centre)).toBeLessThan(1);
  expect(caret.below).toBeCloseTo(10, 0);

  // Escape closes it and hands the focus back; reopening keeps the loaded embed.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => (document.querySelector('.apps-frame').dataset.kept = 'yes'));
  await button.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('iframe')).toHaveAttribute('data-kept', 'yes');
  // The button toggles it.
  await button.click();
  await expect(dialog).toBeHidden();
  // ✕ closes it too.
  await button.click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  // So does a press anywhere else.
  await button.click();
  await page.locator('.document-view').dispatchEvent('pointerdown');
  await expect(dialog).toBeHidden();
});

test('Settings and the Apps panel never show together', async ({ page }) => {
  await setup(page);
  await settled(page);
  await appsButton(page).click();
  await expect(panel(page)).toBeVisible();
  // From the keyboard, so no press outside closes the panel first.
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(panel(page)).toBeHidden();
});

test('the embed follows the chosen appearance', async ({ page }) => {
  await setup(page);
  await settled(page);
  await appsButton(page).click();
  const frame = page.locator('.apps-frame');
  await expect(frame).toHaveCSS('color-scheme', 'light');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByLabel('Appearance').selectOption('dark');
  await expect(frame).toHaveCSS('color-scheme', 'dark');
  await settings.getByLabel('Appearance').selectOption('light');
  await expect(frame).toHaveCSS('color-scheme', 'light');
});

test('signing out reloads the embed for the next account', async ({ page }) => {
  await setup(page);
  await settled(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toContainText('Signed in as Alice');
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await appsButton(page).click();
  await page.evaluate(() => (document.querySelector('.apps-frame').dataset.kept = 'yes'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('button', { name: 'Sign out', exact: true }).click();
  // Signing out returns to the library, which has its own Apps button.
  await expect(page.locator('.home')).toBeVisible();
  await appsButton(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('.apps-frame')).not.toHaveAttribute('data-kept', 'yes');
  await expect(page.locator('.apps-panel')).toHaveCount(1);
});

test('moving to the library closes the panel', async ({ page }) => {
  await setup(page);
  await settled(page);
  await appsButton(page).click();
  await expect(panel(page)).toBeVisible();
  await page.evaluate(() => (location.hash = '#library'));
  await expect(page.locator('.home')).toBeVisible();
  await expect(panel(page)).toBeHidden();
  await expect(appsButton(page)).toHaveAttribute('aria-expanded', 'false');
});

test('a tab Puter opened keeps the button; a desktop window leaves it out', async ({ page }) => {
  await setup(page, { url: '/?puter.app_instance_id=abc' });
  await settled(page);
  await expect(appsButton(page)).toBeVisible();
  await setup(page, { env: 'app' });
  await settled(page);
  await expect(page.locator('.apps-btn')).toBeHidden();
});

test('on a phone the panel is an edge-to-edge sheet', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone layout');
  await setup(page);
  await settled(page);
  await appsButton(page).click();
  const box = await panel(page).boundingBox();
  const width = page.viewportSize().width;
  expect(Math.round(box.x)).toBe(8);
  expect(Math.round(width - box.x - box.width)).toBe(8);
  const close = await panel(page).getByRole('button', { name: 'Close', exact: true }).boundingBox();
  expect(close.width).toBeGreaterThanOrEqual(40);
});
