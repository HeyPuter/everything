import { test, expect } from '@playwright/test';

// puter.js's <puter-user-menu> shows an Upgrade button before its Apps button, signed in or out. Stubbed here as
// the real element is: an open shadow root whose buttons are exposed as parts, defined before the app starts, with
// the Apps button it shows on the web.
async function withUserMenu(page) {
  await page.addInitScript(() => {
    customElements.define('puter-user-menu', class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: 'open' }).innerHTML =
          '<button type="button" class="upgrade-button" part="upgrade-button">Upgrade</button>' +
          '<button type="button" class="apps-button" part="apps-button" aria-label="Apps">A</button>' +
          '<button type="button" class="avatar" part="avatar" aria-label="Account: Alice">A</button>';
      }
    });
  });
}
const upgrade = page => page.locator('puter-user-menu').locator('.upgrade-button');
const nameShowsWhole = page => page.getByRole('textbox', { name: 'Document name' }).evaluate(el => el.scrollWidth <= el.clientWidth);

test("the editor's title bar shows Upgrade as an icon until there is room for its pill", async ({ page }) => {
  await withUserMenu(page);
  for (const width of [1280, 1366, 1440, 1600, 1700, 1024, 902]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await expect(page.locator('.ed-header puter-user-menu')).toHaveCount(1);
    // An icon button, still named and titled by its words.
    await expect(upgrade(page), `${width}px`).toBeVisible();
    await expect(upgrade(page)).toHaveAccessibleName('Upgrade');
    await expect(upgrade(page)).toHaveAttribute('title', 'Upgrade');
    expect(await upgrade(page).evaluate(b => [Math.round(b.getBoundingClientRect().width), getComputedStyle(b).fontSize, getComputedStyle(b, '::before').maskImage.startsWith('url(')]), `${width}px`)
      .toEqual([32, '0px', true]);
  }
  await page.setViewportSize({ width: 1920, height: 700 });
  await expect(upgrade(page)).toBeVisible();
  // A pill like the ones beside it, not the SDK's own taller button.
  expect(await upgrade(page).evaluate(b => [Math.round(b.getBoundingClientRect().height), getComputedStyle(b).borderRadius, getComputedStyle(b).fontSize])).toEqual([28, '7px', '13px']);
  expect(await nameShowsWhole(page)).toBe(true);
  // Phones leave it out, for the name.
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(upgrade(page)).toBeHidden();
});

test("beside Upgrade's icon the document's name and the menus stay whole from 902px up, and nothing overflows", async ({ page }) => {
  await withUserMenu(page);
  for (const width of [1280, 1300, 1366, 1440, 1461, 1600, 1700, 1024, 920, 902]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await expect(upgrade(page), `${width}px`).toBeVisible();
    expect(await nameShowsWhole(page), `${width}px`).toBe(true);
    expect(await page.locator('.ed-header .ed-menubar').evaluate(bar => {
      const right = bar.getBoundingClientRect().right;
      return [...bar.querySelectorAll('.menu-btn')].every(b => b.getBoundingClientRect().right <= right + 0.5);
    }), `${width}px`).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px`).toBe(true);
  }
});

test('the icon\'s tooltip follows the words the element gives it', async ({ page }) => {
  await withUserMenu(page);
  await page.goto('/mock.html#/new');
  await expect(upgrade(page)).toHaveAttribute('title', 'Upgrade');
  await upgrade(page).evaluate(b => { b.textContent = 'Manage plan'; });
  await expect(upgrade(page)).toHaveAttribute('title', 'Manage plan');
});

test('the home screen shows Upgrade in the accent, and leaves it out where it would push the account off a phone', async ({ page }) => {
  await withUserMenu(page);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('/mock.html#/home');
  await expect(page.locator('.home-head puter-user-menu')).toHaveCount(1);
  await expect(upgrade(page)).toBeVisible();
  const [height, color, accent] = await upgrade(page).evaluate(b => [
    Math.round(b.getBoundingClientRect().height), getComputedStyle(b).color,
    getComputedStyle(document.querySelector('.home-head .btn-primary, .btn-primary') || document.body).backgroundColor,
  ]);
  expect(height).toBe(32);
  expect(color).toBe(accent);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    if (width === 390) await expect(upgrade(page)).toBeVisible();
    else await expect(upgrade(page)).toBeHidden();
    expect(await page.locator('.home-head puter-user-menu').evaluate(m => m.getBoundingClientRect().right <= innerWidth), `${width}px`).toBe(true);
  }
});
