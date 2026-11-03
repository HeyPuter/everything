import { test, expect } from '@playwright/test';

// A paragraph indented further than a narrower window allows cannot be laid out in Web Layout at that
// width, and the view keeps its last width. The window then asked again on every editor update, and
// each refused attempt itself reported an update: the tab froze for good, with no way to undo.
const responsive = page => Promise.race([page.evaluate(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);

test('Web Layout stays responsive when the window becomes narrower than an indent', async ({ page }) => {
  test.setTimeout(90000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('First paragraph with some words.\nSecond paragraph, indented a long way.');
  await page.locator('#ribbon-tab-view').click();
  await page.locator('.ribbon-card').getByRole('button', { name: 'Web Layout', exact: true }).click();
  await expect(page.locator('.canvas-host')).toHaveClass(/view-web/);
  await input.focus(); await input.press('ControlOrMeta+End');
  await page.locator('#ribbon-tab-home').click();
  const indent = page.getByRole('button', { name: 'Increase Indent', exact: true });
  for (let i = 0; i < 18; i++) await indent.click();
  await page.setViewportSize({ width: 600, height: 800 }).catch(() => {});
  await page.waitForTimeout(1000);
  expect(await responsive(page)).toBe(true);
  // The view keeps its last width and the document can still be edited: typing and Undo work.
  await expect(page.locator('.canvas-host')).toHaveClass(/view-web/);
  await input.focus(); await page.keyboard.insertText('!');
  await expect(input).toHaveValue(/a long way\.!$/);
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue(/a long way\.$/);
  // Taking the indent out lets the view follow the window again.
  for (let i = 0; i < 18; i++) await input.press('ControlOrMeta+z');
  await expect.poll(() => page.locator('canvas.canvas-page').first().evaluate(c => c.getBoundingClientRect().width)).toBeLessThan(600);
  expect(errors).toEqual([]);
});
