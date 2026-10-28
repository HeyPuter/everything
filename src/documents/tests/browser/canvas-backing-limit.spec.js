import { test, expect } from '@playwright/test';

// Safari on iOS draws nothing in a canvas larger than 4096 × 4096 pixels. A Letter page at 200% on a
// 3x display would need 4896 × 6336, so its canvas is given fewer device pixels instead. The painted
// selection must still sit where the pointer finds the same text.
test.use({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 3 });
test('keeps zoomed pages within the canvas pixel limit with painting aligned to the pointer', async ({ page }) => {
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^A small beginning/);
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('2');
  const canvas = page.locator('canvas.canvas-page').first();
  await expect.poll(() => canvas.evaluate(c => c.getBoundingClientRect().width)).toBeCloseTo(1632, 0);
  const size = await canvas.evaluate(c => ({ width: c.width, height: c.height, css: c.getBoundingClientRect().width }));
  expect(size.width * size.height).toBeLessThanOrEqual(4096 * 4096);
  expect(size.width / size.css).toBeGreaterThan(2);
  // Select "small" and find its painted highlight.
  await input.evaluate(el => { el.focus(); el.setSelectionRange(2, 7); el.dispatchEvent(new Event('select', { bubbles: true })); });
  // The painted highlight's bounds in CSS pixels, or null while it is not painted yet.
  const highlight = () => canvas.evaluate(c => {
    const rows = Math.round(c.height / 3), data = c.getContext('2d').getImageData(0, 0, c.width, rows).data;
    let left = Infinity, right = -1, top = Infinity, bottom = -1;
    for (let y = 0; y < rows; y += 2) for (let x = 0; x < c.width; x += 2) {
      const i = (y * c.width + x) * 4, r = data[i], b = data[i + 2];
      if (b > 200 && b - r > 20 && r > 150) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    const scale = c.getBoundingClientRect().width / c.width;
    return right < 0 ? null : { left: left * scale, right: right * scale, top: top * scale, bottom: bottom * scale };
  });
  await expect.poll(highlight).not.toBeNull();
  const painted = await highlight();
  // The highlight covers one word on the first line: about 5 letters at 200%.
  expect(painted.right - painted.left).toBeGreaterThan(40);
  expect(painted.right - painted.left).toBeLessThan(160);
  const rect = await canvas.boundingBox();
  // Separate single clicks (a quick second click would select the word).
  const at = async x => { await page.waitForTimeout(700); await page.mouse.click(rect.x + x, rect.y + (painted.top + painted.bottom) / 2); return input.evaluate(el => el.selectionStart); };
  // Just inside the painted highlight's edges the pointer lands at that word's ends.
  expect(await at(painted.left + 3)).toBe(2);
  expect(await at(painted.right - 3)).toBe(7);
});
