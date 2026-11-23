import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { addShapeAnnotation } from '../../src/core/annotations.js';

// Each comment in the Comments panel was a Tab stop of its own, so a keyboard had to press Tab
// once for every comment of a long review to get past the list. The list is one Tab stop; the
// arrow keys, Home and End go through it.
test('the Comments panel is one Tab stop, gone through with the arrow keys', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (let p = 0; p < 2; p++) {
    doc.addPage([400, 500]);
    for (let i = 0; i < 3; i++)
      addShapeAnnotation(doc, p, {
        kind: 'square',
        rect: { x: 40 + i * 100, y: 300, width: 60, height: 40 },
        text: `Remark ${p * 3 + i + 1}`,
      });
  }
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'comment-panel-keys.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await page.getByRole('tab', { name: /Comments/ }).click();
  const items = page.getByRole('group', { name: 'Comments' }).getByRole('button');
  await expect(items).toHaveCount(6);
  const named = (n) => items.filter({ hasText: `Remark ${n}` });
  // Only the first comment is reached by Tab, until another is moved to.
  expect(await items.evaluateAll((all) => all.map((item) => item.tabIndex))).toEqual([
    0, -1, -1, -1, -1, -1,
  ]);
  await named(1).focus();
  await page.keyboard.press('ArrowDown');
  await expect(named(2)).toBeFocused();
  await page.keyboard.press('End');
  await expect(named(6)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(named(1)).toBeFocused();
  // Across the pages' lists too.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(named(4)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(named(3)).toBeFocused();
  // One Tab leaves the list, and Shift+Tab comes back to the comment left.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.comments'))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(named(3)).toBeFocused();
});
