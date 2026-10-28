import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Set Transparent Color takes the color under the pointer, also in a cropped, flipped picture: the crop
// is of the picture as stored, and the flip mirrors what is left of it.
// A 40 × 20 picture: red on its left half, blue on its right half.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJ0lEQVR4nGO4IydHNqJA6x2GUYtHLR61eNTiUYtHLR61eNTikWMxALnMay7BH6g1AAAAAElFTkSuQmCC', 'base64');

test('Set Transparent Color picks the color shown under the pointer in a cropped, flipped picture', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'halves.png', mimeType: 'image/png', buffer: PNG });
  const panel = page.locator('#ribbon-panel-picture');
  await expect(panel).toBeVisible();
  // Keep the right 40 % of the picture (all blue), mirrored, and make it large enough to click in.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.execute(() => e.model.setImageProperties({ width: 914400 * 2, height: 914400, crop: { left: 60000 }, flipH: true })); });
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.selectedImage?.flipH)).toBe(true);
  await panel.getByRole('button', { name: 'Color', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Set Transparent Color' }).click();
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  // Near the left edge of what shows: blue, from the right of the stored picture.
  await page.mouse.click(frame.x + frame.width * 0.1, frame.y + frame.height / 2);
  await expect.poll(() => page.evaluate(() => {
    const m = window.__docs.current.view.engine.model, image = m.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
    return /<a:clrFrom><a:srgbClr val="([0-9A-F]{6})"/.exec(image.shell || '')?.[1] || null;
  })).toBe('1E1EDC');
  expect(errors).toEqual([]);
});
