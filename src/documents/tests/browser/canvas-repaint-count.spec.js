import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Each paint draws every page canvas on screen again, so a caret move or a typed character
// should paint once, not once more a frame later for the table tools' overlay.
test('a caret move or typed character paints the pages once', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Some words');
  // Moving past the word just typed has it spell-checked, which paints its marks.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const engine = window.__docs.current.view.engine, paint = engine.paint;
    window.paints = 0;
    engine.paint = function (...args) { window.paints++; return paint.apply(this, args); };
  });
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.paints)).toBe(1);
  await page.evaluate(() => { window.paints = 0; });
  await page.keyboard.type('x');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.paints)).toBe(1);
});
