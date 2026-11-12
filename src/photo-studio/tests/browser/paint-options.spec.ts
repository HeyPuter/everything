import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

// Clearing a tool option keeps its value (and shows it) instead of applying
// 0, 1 or a default behind a blank field.
const fields: [string, string, string][] = [
  ['brush', '#brush-size', '37'],
  ['brush', '#brush-hardness', '37'],
  ['brush', '#brush-opacity', '37'],
  ['brush', '#brush-flow', '37'],
  ['brush', '#brush-smoothing', '37'],
  ['bucket', '#bucket-opacity', '37'],
  ['bucket', '#tolerance', '37'],
  ['magic-wand', '#tolerance', '37'],
  ['rect-marquee', '#sel-feather', '37'],
  ['rect-marquee', '#marquee-w', '37'],
  ['dodge', '#tone-exposure', '37'],
  ['blur-tool', '#tool-strength', '37'],
  ['background-eraser', '#bg-tolerance', '37'],
  ['color-replacement', '#replace-tolerance', '37'],
  ['mixer-brush', '#mixer-wet', '37'],
  ['art-history', '#art-area', '37'],
  ['art-history', '#art-tolerance', '37'],
  ['spot-healing', '#retouch-size', '37'],
  ['healing-brush', '#retouch-hardness', '37'],
  ['context-move', '#contextMove-structure', '5'],
  ['red-eye', '#red-pupil', '37'],
];

test('clearing a painting or selection tool option keeps its value', async ({ page }) => {
  await boot(page);
  await openImage(page);
  const wrong: string[] = [];
  for (const [tool, selector, value] of fields) {
    await page.evaluate((t) => window.photoStudio.setTool(t), tool);
    await idle(page);
    const input = page.locator(`#options ${selector}, ${selector}`).first();
    await input.fill(value);
    await input.dispatchEvent('change');
    await input.fill('');
    await input.dispatchEvent('change');
    const shown = await page.locator(selector).first().inputValue();
    // Redraw the options bar from the stored value.
    await page.evaluate(() => window.photoStudio.options());
    const stored = await page.locator(selector).first().inputValue();
    if (shown !== value || stored !== value) wrong.push(`${tool} ${selector}: shown ${shown}, stored ${stored}`);
  }
  expect(wrong).toEqual([]);
});

test('the brush popover works from the keyboard and the brush button toggles it', async ({ page }) => {
  await boot(page);
  await openImage(page);
  await page.evaluate(() => window.photoStudio.setTool('brush'));
  const button = page.locator('[data-brush-popover="brush"]');
  await button.focus();
  await page.keyboard.press('Enter');
  const popover = page.getByRole('dialog', { name: 'Brush settings' });
  await expect(popover).toBeVisible();
  // Focus moves into the popover; arrow keys change the size.
  expect(await popover.evaluate((p) => p.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(page.locator('[data-brush-popover="brush"]')).toBeFocused();
  expect(await page.evaluate(() => window.photoStudio.activeTool!.brush!.get(window.photoStudio).size)).toBe(31);
  // A second click on the brush button closes it again.
  await page.locator('[data-brush-popover="brush"]').click();
  await expect(popover).toBeVisible();
  await page.locator('[data-brush-popover="brush"]').click();
  await expect(popover).toHaveCount(0);
  // Switching tools closes it.
  await page.locator('[data-brush-popover="brush"]').click();
  await page.evaluate(() => window.photoStudio.setTool('eraser'));
  await expect(popover).toHaveCount(0);
});
