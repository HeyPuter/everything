// puter.js's <puter-user-menu> in the top bar (src/app/user-menu.ts). The SDK is
// stubbed, with a stand-in element that has the real one's Sign in button.
import { expect, test } from '@playwright/test';
import { boot } from './helpers';

const ELEMENT = `
  customElements.define('puter-user-menu', class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: 'open' }).innerHTML = '<button class="sign-in" part="sign-in">Sign in</button>';
      this.shadowRoot.querySelector('button').addEventListener('click', () => (window.__signInClicks = (window.__signInClicks || 0) + 1));
    }
  });`;
const sdk = (env: string) => `window.puter={env:"${env}",auth:{isSignedIn:()=>false,getUser:async()=>({username:"test-user"})}};`;

test('the element stands in for the account button and follows the theme', async ({ page }) => {
  await boot(page, 'default', ELEMENT + sdk('web'));
  const menu = page.locator('.top-actions > puter-user-menu');
  await expect(menu).toHaveCount(1);
  await expect(menu).toBeVisible();
  await expect(page.locator('#account')).toBeHidden();
  expect(await page.evaluate(() => document.querySelector('.top-actions')!.lastElementChild!.localName)).toBe('puter-user-menu');

  await page.evaluate(() => window.photoStudio.setTheme('dark'));
  await expect(menu).toHaveAttribute('theme', 'dark');
  await page.evaluate(() => window.photoStudio.setTheme('light'));
  await expect(menu).toHaveAttribute('theme', 'light');
  await page.evaluate(() => window.photoStudio.setTheme('medium'));
  await expect(menu).toHaveAttribute('theme', 'dark');
  await page.evaluate(() => window.photoStudio.setTheme('system'));
  await expect(menu).not.toHaveAttribute('theme');
});

test('the editor follows a sign-in and a sign-out the element did', async ({ page }) => {
  await boot(page, 'default', ELEMENT + sdk('web'));
  const menu = page.locator('puter-user-menu');
  await menu.evaluate((el) => el.dispatchEvent(new CustomEvent('signin', { detail: { user: { username: 'test-user' } } })));
  await expect(page.locator('#toast')).toHaveText('Connected to Puter');

  await page.evaluate(() => (window.photoStudio.storage.path = '/test-user/Documents/a.photo'));
  await menu.evaluate((el) => el.dispatchEvent(new CustomEvent('signout')));
  await expect(page.locator('#toast')).toHaveText('Signed out');
  expect(await page.evaluate(() => window.photoStudio.storage.path)).toBeUndefined();
});

test('keys inside the element are not editor shortcuts', async ({ page }) => {
  await boot(page, 'default', ELEMENT + sdk('web'));
  await page.locator('puter-user-menu .sign-in').focus();
  const before = await page.evaluate(() => window.photoStudio.tool);
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe(before);
  await page.keyboard.down('Space');
  await expect(page.locator('#viewport')).not.toHaveClass(/space-pan/);
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => (window as unknown as { __signInClicks?: number }).__signInClicks)).toBe(1);
  // The same key from the page is still the Brush shortcut.
  await page.locator('#viewport').focus();
  await page.keyboard.press('b');
  expect(await page.evaluate(() => window.photoStudio.tool)).not.toBe(before);
});

test('inside a Puter app window the account button stays', async ({ page }) => {
  await boot(page, 'default', ELEMENT + sdk('app'));
  await expect(page.locator('puter-user-menu')).toHaveCount(0);
  await expect(page.locator('#account')).toBeVisible();
});

test('with a puter.js that predates the element the account button stays', async ({ page }) => {
  await boot(page, 'default', sdk('web'));
  await expect(page.locator('puter-user-menu')).toHaveCount(0);
  await expect(page.locator('#account')).toBeVisible();
});
