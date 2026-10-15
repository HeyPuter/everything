import { test, expect } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors, objectNames } from './helpers';

test('a right-click released in place leaves the context menu open; a drag-release picks an item', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  const before = await objectNames(page);

  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  const menu = page.locator('.menu').first();
  await expect(menu).toBeVisible();
  expect(await objectNames(page)).toEqual(before);

  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);

  // press, drag onto "Duplicate Objects", release
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button: 'right' });
  const item = page.locator('.menu .menu-item', { hasText: 'Duplicate Objects' }).first();
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('.menu')).toHaveCount(0);
  await page.keyboard.press('Escape'); // cancel the grab that follows duplication
  expect((await objectNames(page)).length).toBe(before.length + 1);
  await expectNoErrors(errors);
});
