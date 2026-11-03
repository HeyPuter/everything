import { test, expect } from '@playwright/test';

/** Whether the control is wholly inside its ribbon strip, clear of the faded edge that says more is beyond. */
const clear = control => control.evaluate(node => {
  const panel = node.closest('.ribbon-panel'), box = node.getBoundingClientRect(), strip = panel.getBoundingClientRect();
  const atStart = panel.scrollLeft < 1, atEnd = panel.scrollLeft + panel.clientWidth >= panel.scrollWidth - 1;
  return box.left >= strip.left + (atStart ? 0 : 16) && box.right <= strip.right - (atEnd ? 0 : 16) && box.right <= innerWidth;
});

test('in a narrow window the arrow keys bring each ribbon command wholly into view', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/mock.html#/new');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Harbour report');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  await page.locator('#ribbon-tab-insert').click();
  await page.locator('#ribbon-tab-insert').focus();
  await page.keyboard.press('ArrowDown');
  const panel = page.locator('#ribbon-panel-insert');
  const names = [];
  for (let i = 0; i < 26; i++) {
    const focused = panel.locator(':focus');
    await expect(focused).toHaveCount(1);
    names.push(await focused.evaluate(node => node.getAttribute('aria-label') || node.textContent.trim()));
    await expect.poll(() => clear(focused), { message: `${names.at(-1)} is in view` }).toBe(true);
    await page.keyboard.press('ArrowRight');
  }
  // The strip was walked through, not just its first screenful.
  expect(names).toContain('Object');
});
