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

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('the commit and cancel buttons stay visible in the options bar while editing', async ({ page }) => {
    await boot(page);
    await openImage(page, 400, 300, '#ffffff');
    await tool(page, 'Horizontal Type Tool');
    const [cx, cy] = await page.evaluate(() => window.photoStudio.clientPoint(100, 100));
    await page.mouse.click(cx, cy);
    await idle(page);
    const bar = (await page.locator('#tool-options').boundingBox())!;
    for (const name of ['Commit text', 'Cancel editing']) {
      const b = (await page.locator('#tool-options').getByRole('button', { name }).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(bar.x - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    }
    await page.locator('#tool-options').getByRole('button', { name: 'Cancel editing' }).click();
    await expect.poll(() => page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(false);
  });
});
