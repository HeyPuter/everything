import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, objectNames, expectNoErrors } from './helpers';

// puter.js's <puter-user-menu> at the end of the top bar (src/ui/usermenu.ts). The SDK is stubbed,
// with a stand-in element that has the real one's Sign in button.

const ELEMENT = `
  customElements.define('puter-user-menu', class extends HTMLElement {
    connectedCallback() {
      window.__connects = (window.__connects || 0) + 1;
      if (this.shadowRoot) return;
      this.attachShadow({ mode: 'open' }).innerHTML = '<button class="sign-in" part="sign-in">Sign in</button>';
      this.shadowRoot.querySelector('button').addEventListener('click', () => (window.__signInClicks = (window.__signInClicks || 0) + 1));
    }
  });`;
const sdk = (env: string) => `window.puter = { env: '${env}', auth: { isSignedIn: () => false }, exit: () => (window.__exits = (window.__exits || 0) + 1) };`;
const stubSdk = (page: Page, body: string) => page.route('https://js.puter.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body }));
const counter = (page: Page, name: string) => page.evaluate((n) => (window as unknown as Record<string, number | undefined>)[n] ?? 0, name);

test('the element ends the top bar, follows the theme and survives redraws', async ({ page }) => {
  await stubSdk(page, ELEMENT + sdk('web'));
  const errors = await openApp(page);
  const menu = page.locator('.topbar > puter-user-menu');
  await expect(menu).toHaveCount(1);
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('.topbar')!.lastElementChild!.localName)).toBe('puter-user-menu');
  await expect(menu).toHaveAttribute('theme', 'dark');

  // the top bar is redrawn from state; the element is created once and stays connected
  await page.locator('.tb-assistant').click();
  await page.locator('.tb-assistant').click();
  await expect(menu).toHaveCount(1);
  expect(await counter(page, '__connects')).toBe(1);

  await page.evaluate(async () => (await import('/src/prefs/theme_ui.ts' as string)).setThemePreset('LIGHT'));
  await expect(menu).toHaveAttribute('theme', 'light');
  await page.evaluate(async () => (await import('/src/prefs/theme_ui.ts' as string)).setThemePreset('DEFAULT'));
  await expect(menu).toHaveAttribute('theme', 'dark');
  await expectNoErrors(errors);
});

test('keys inside the element are not shortcuts', async ({ page }) => {
  await stubSdk(page, ELEMENT + sdk('web'));
  await openApp(page);
  const before = await objectNames(page);
  await hoverViewport(page);
  await page.locator('puter-user-menu .sign-in').focus();
  // X deletes the selection over the viewport, Space starts playback: neither from inside the element
  await page.keyboard.press('x');
  await expect(page.locator('.menu')).toHaveCount(0);
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  expect(await counter(page, '__signInClicks')).toBe(2);
  expect(await objectNames(page)).toEqual(before);
  // the same key from the page still is one
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('x');
  await expect(page.locator('.menu')).toHaveCount(1);
});

test('Quit leaves the SDK alone on a web page', async ({ page }) => {
  await stubSdk(page, ELEMENT + sdk('web'));
  await openApp(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): string } }).app.run('wm.quit_blender'));
  await expect(page.locator('.quit-note')).toBeVisible();
  expect(await counter(page, '__exits')).toBe(0);
});

test('inside a Puter app window the top bar has no element', async ({ page }) => {
  await stubSdk(page, ELEMENT + sdk('app'));
  const errors = await openApp(page);
  await expect(page.locator('puter-user-menu')).toHaveCount(0);
  await expect(page.locator('.tb-assistant')).toBeVisible();
  await expectNoErrors(errors);
});

test('with a puter.js that predates the element, or none, the top bar is as it was', async ({ page }) => {
  await stubSdk(page, sdk('web'));
  await openApp(page);
  await expect(page.locator('puter-user-menu')).toHaveCount(0);

  // the SDK cannot be reached: the app starts all the same
  await page.unroute('https://js.puter.com/**');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const errors = await openApp(page);
  await expect(page.locator('puter-user-menu')).toHaveCount(0);
  await expect(page.locator('.tb-assistant')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __puterFailed?: boolean; puter?: unknown }).__puterFailed === true && !('puter' in window))).toBe(true);
  await expectNoErrors(errors);
});
