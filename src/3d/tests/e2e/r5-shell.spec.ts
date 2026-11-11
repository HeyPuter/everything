// Shared UI shell: menus, popups and fields in narrow windows and with the keyboard.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const menuBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.popup-layer > .menu')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollW: e.scrollWidth, clientW: e.clientWidth };
    }),
  );

test('a phone-width window keeps the editor type menu and the search popup on screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = await openApp(page);
  await page.locator('.area .editor-type').first().click();
  // the columns don't fit: every editor is reachable in one list inside the window
  await expect(page.locator('.menu .menu-item', { hasText: 'Spreadsheet' })).toBeVisible();
  let boxes = await menuBoxes(page);
  expect(boxes).toHaveLength(1);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  expect(boxes[0].scrollW).toBeLessThanOrEqual(boxes[0].clientW);
  await page.locator('.menu .menu-item', { hasText: 'Spreadsheet' }).scrollIntoViewIfNeeded();
  await page.keyboard.press('Escape');
  await page.mouse.move(160, 300);
  await page.keyboard.press('F3');
  await expect(page.locator('.search-popup')).toBeVisible();
  boxes = await menuBoxes(page);
  expect(boxes[0].left).toBeGreaterThanOrEqual(0);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
