import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('keyboard users can step through frames without losing the timeline control', async ({ page }) => {
  await boot(page);
  await openImage(page, 48, 32);
  await run(page, 'animation.create');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.first');
  const next = page.locator('.timeline-controls [data-command="animation.next"]');
  await next.focus();
  await page.keyboard.press('Enter');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.animation?.current)).toBe(1);
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.animation?.current)).toBe(2);
  await expect(next).toBeFocused();
});
