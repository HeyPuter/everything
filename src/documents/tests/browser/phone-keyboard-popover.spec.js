import { test, expect } from '@playwright/test';

// A phone's keyboard rising shortens the window (the page asks for interactive-widget=resizes-content). A popover
// with a field in it stays open for the typing, but it stayed where it was: the Insert link popover ran on under the
// keyboard, its address field at the very edge and its Insert button out of reach. It is placed again for the room left.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('a popover being typed in fits above a phone\'s keyboard when it rises', async ({ page }) => {
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeEditable({ timeout: 20000 });
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.replace('Hello world there'); e.relayout(); e.model.select(0, 5); e.syncInput(); });
  await input.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const popover = page.getByRole('dialog', { name: 'Insert link' });
  const address = popover.getByRole('textbox', { name: 'Link address' });
  await expect(address).toBeVisible();
  await address.tap();
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(popover).toBeVisible();
  await expect.poll(async () => (await popover.boundingBox()).y + (await popover.boundingBox()).height).toBeLessThanOrEqual(480);
  const field = await address.boundingBox();
  expect(field.y).toBeGreaterThanOrEqual(0);
  expect(field.y + field.height).toBeLessThanOrEqual(480);
  await expect(address).toBeFocused();
  // Its buttons are reached by scrolling the popover, not hidden under the keyboard.
  const insert = popover.locator('button[type="submit"]');
  await insert.scrollIntoViewIfNeeded();
  const button = await insert.boundingBox();
  expect(button.y + button.height).toBeLessThanOrEqual(480);
});
