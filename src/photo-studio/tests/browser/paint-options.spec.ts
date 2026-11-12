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
