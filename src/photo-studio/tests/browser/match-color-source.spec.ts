// Match Color measures the chosen source asynchronously. Choosing a source
// that takes a while and then another one used to let the first measurement
// land last, so the dialog applied a source that was no longer selected.
import { test, expect } from '@playwright/test';
import { boot, idle, layerPixel, openImage, start } from './helpers';

test('Match Color uses the source chosen last, however long the earlier one takes', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 64, '#808080');
  const red = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const l = layer('solid', 'Red', 64, 64);
    l.color = '#ff2000';
    e.command('Add', (d) => d.layers.push(l));
    e.selected = e.doc.layers[0].id;
    e.update();
    return l.id;
  });
  await idle(page);
  await start(page, 'adjust.match-color');
  const dialog = page.locator('dialog.adj-dialog[open]');
  const source = dialog.locator('.adj-select select').first();
  await expect(source).toBeVisible();
  // The layer needs a read-back; None answers at once. Both in one task.
  await source.evaluate((s: HTMLSelectElement, id) => {
    s.value = `layer:${id}`;
    s.dispatchEvent(new Event('change'));
    s.value = '';
    s.dispatchEvent(new Event('change'));
  }, red);
  await page.waitForTimeout(1000);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  const [r, g, b] = await layerPixel(page, 32, 32);
  expect(Math.abs(r - 128) + Math.abs(g - 128) + Math.abs(b - 128)).toBeLessThanOrEqual(3);
});
