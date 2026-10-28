import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The Draw tab paints strokes being drawn on a canvas over the page. Like the page canvas, it must stay
// within Safari's 4096 × 4096 pixel limit (a Letter page at 200% on a 3x display would need
// 4896 × 6336) or it draws nothing; with fewer device pixels the ink must still land under the pointer.
test.use({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 3 });
test('ink being drawn on a zoomed page stays within the canvas pixel limit and under the pointer', async ({ page }) => {
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('2');
  const canvas = page.locator('canvas.canvas-page').first();
  await expect.poll(() => canvas.evaluate(c => c.getBoundingClientRect().width)).toBeCloseTo(1632, 0);
  await onTab(page, 'draw');
  await page.locator('#ribbon-panel-draw .draw-pen').first().click();
  const box = await canvas.boundingBox();
  // A horizontal stroke below the text, checked while it is being drawn (the overlay shows it until the pointer lifts).
  const y = Math.min(box.y + 560, 860), from = { x: box.x + 300, y }, to = { x: box.x + 600, y };
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (to.x - from.x) * i / 10, from.y, { steps: 2 });
  const overlay = page.locator('canvas.draw-overlay').first();
  await expect(overlay).toHaveCount(1);
  const size = await overlay.evaluate(c => ({ width: c.width, height: c.height }));
  expect(size.width * size.height).toBeLessThanOrEqual(4096 * 4096);
  // The ink's painted extent, in CSS pixels from the overlay's corner, or null until painted.
  const ink = () => overlay.evaluate(c => {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, scale = c.getBoundingClientRect().width / c.width;
    let left = Infinity, right = -1, top = Infinity, bottom = -1;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) if (data[(y * c.width + x) * 4 + 3] > 128) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    return right < 0 ? null : { left: left * scale, right: right * scale, top: top * scale, bottom: bottom * scale };
  });
  await expect.poll(ink).not.toBeNull();
  const painted = await ink(), origin = await overlay.boundingBox();
  // Within a few pixels of where the pointer went.
  expect(Math.abs(painted.left - (from.x - origin.x))).toBeLessThan(12);
  expect(Math.abs(painted.right - (to.x - origin.x))).toBeLessThan(12);
  expect(Math.abs((painted.top + painted.bottom) / 2 - (from.y - origin.y))).toBeLessThan(6);
  await page.mouse.up();
});
