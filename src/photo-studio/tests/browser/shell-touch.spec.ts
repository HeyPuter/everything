// The workspace chrome on touch screens, tablets and phones, plus menus and
// states that are easy to leave behind (listeners, errors, empty states).
import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'touch.png');
});

test('the status bar info menu takes Home and End, and a closed menu leaves nothing behind', async ({ page }) => {
  const button = page.locator('#doc-info');
  const menu = page.locator('.status-info-menu');
  // Opened and closed with the keyboard, then opened again.
  await button.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await button.click();
  await expect(menu).toBeVisible();
  const items = menu.locator('.menu-item');
  await page.keyboard.press('End');
  await expect(items.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.first()).toBeFocused();
  // Pressing an item of the new menu: the earlier menu's listener used to
  // mark the button collapsed while this menu was still open.
  const box = (await items.nth(1).boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.mouse.up();
  await expect(menu).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
});
