import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, tool } from './helpers';

// The Character and Paragraph panels show sizes in the type unit preference.
test('Paragraph and Character fields follow the type unit, with limits in that unit', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.preferences.typeUnits = 'px';
    e.command('Resolution', (d) => void (d.resolution = { horizontalResolution: 300, horizontalResolutionUnit: 'PPI', verticalResolution: 300, verticalResolutionUnit: 'PPI' } as typeof d.resolution));
  });
  await idle(page);
  await tool(page, 'Horizontal Type Tool');
  const defaults = () => page.evaluate(async () => (await import('/src/features/type/session.ts')).typeDefaults(window.photoStudio));
  // 300 ppi: 1 pt = 300 / 72 px.
  const para = await panel(page, 'Paragraph');
  const indent = para.locator('[data-para="indentLeft"]');
  await expect(indent.locator('xpath=following-sibling::span')).toHaveText('px');
  await indent.fill('25');
  await indent.press('Enter');
  await expect.poll(async () => (await defaults()).paragraph.indentLeft).toBeCloseTo(6, 6);
  const char = await panel(page, 'Character');
  const size = char.locator('[data-char="size"]');
  await expect(size).toHaveValue('100');
  // The stepper goes past 1296 px (the 1296 pt limit is 5400 px here).
  expect(await size.getAttribute('max')).toBe('5400');
  await size.fill('1296');
  await size.press('ArrowUp');
  await expect(size).toHaveValue('1296.5');
  await size.press('Enter');
  await expect.poll(async () => (await defaults()).style.size).toBeCloseTo(1296.5 * 72 / 300, 6);
});
