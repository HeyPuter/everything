import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A design change reopens the package in place; the first save of the reopened package is parsed ahead while
// the page is idle (DocxPackage.prepareSave), as the first one's was, and the package it replaced is left alone.
test('a package reopened by a design change is prepared for saving, and the one it replaced is not', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of the report.`).join('\n'));
  // Record which packages are prepared, in order (the app and this page share the module).
  await page.evaluate(async () => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const prepare = DocxPackage.prototype.prepareSave, ids = new WeakMap();
    let next = 0;
    window.preparedPackages = [];
    DocxPackage.prototype.prepareSave = function (timeLeft) {
      if (!ids.has(this)) ids.set(this, next++);
      window.preparedPackages.push(ids.get(this));
      return prepare.call(this, timeLeft);
    };
  });
  const calls = () => page.evaluate(() => [...window.preparedPackages]);
  const watermark = async name => {
    await onTab(page, 'design');
    await page.locator('.ribbon-card').getByRole('button', { name: 'Watermark' }).click();
    await page.getByRole('menuitemradio', { name }).click();
    await expect(input).toBeFocused();
  };
  // Each change reopens the package: the new one is prepared while the page is idle (nothing is typed), and the
  // one it replaced is not prepared again.
  for (const name of ['DRAFT, diagonal', 'CONFIDENTIAL, diagonal']) {
    const before = new Set(await calls());
    await watermark(name);
    await expect.poll(async () => (await calls()).some(id => !before.has(id)), { timeout: 5000 }).toBe(true);
    await page.waitForTimeout(300);
    const after = await calls(), firstNew = after.findIndex(id => !before.has(id));
    expect(new Set(after.slice(firstNew)).size).toBe(1);
  }
  expect(errors).toEqual([]);
});
