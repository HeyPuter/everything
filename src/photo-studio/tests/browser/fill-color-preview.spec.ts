// Changing a solid color fill layer's color previews on the canvas while the
// picker is open; Cancel shows the layer as it was and records nothing.
import { expect, test } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test('the fill color picker previews live and Cancel restores', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 32, '#808080');
  const id = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const l = layer('solid', 'Color Fill', 32, 32);
    l.color = '#ffffff';
    e.command('New Fill Layer', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
    return l.id;
  });
  await idle(page);
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  const shown = () =>
    page.evaluate((id) => {
      const d = (window.photoStudio as unknown as { lastDoc: typeof window.photoStudio.doc })
        .lastDoc;
      return d.layers.find((l) => l.id === id)!.color;
    }, id);
  await page.evaluate(() => void window.photoStudio.runCommand('color.pick-layer-color'));
  const hex = page.locator('.color-picker-dialog [data-f="hex"]');
  await hex.fill('ff0000');
  await hex.dispatchEvent('input');
  await expect.poll(shown).toBe('#ff0000');
  await page.locator('.color-picker-dialog .cp-cancel').click();
  await expect.poll(shown).toBe('#ffffff');
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps);
});
