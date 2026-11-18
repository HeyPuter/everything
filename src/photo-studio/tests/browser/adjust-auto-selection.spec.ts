import { test, expect, type Page } from '@playwright/test';
import { boot, idle, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

// Dark columns at the left, a mid-tone ramp elsewhere; the selection covers
// the ramp and one dark pixel, so its bounds include the dark columns.
async function scene(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(120, 80);
    const g = c.getContext('2d')!;
    for (let x = 0; x < 120; x++) {
      const v = x < 30 ? 10 : 100 + Math.round((x - 30) * 0.6);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, 0, 1, 80);
    }
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'ramp.png');
  });
  await idle(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const data = new Uint8Array(120 * 80);
    for (let y = 0; y < 80; y++) for (let x = 40; x < 120; x++) data[y * 120 + x] = 255;
    data[40 * 120] = 255;
    commitSelectionMask(e, { width: 120, height: 80, data }, 'replace', 'Select');
  });
  await idle(page);
}
const pixels = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    return [50, 80, 110].map(
      (x) => readRGBA(e.assets.tiles, l.pixels!, { x, y: 20, width: 1, height: 1 }).data[0],
    );
  });

for (const kind of ['levels', 'curves'] as const)
  test(`${kind} Auto analyzes the selected pixels, as Image > Auto Tone does`, async ({ page }) => {
    await scene(page);
    await run(page, 'image.auto-tone');
    const reference = await pixels(page);
    // Stretched from the ramp's own black point, not the dark columns'.
    expect(reference[0]).toBeLessThan(40);
    await run(page, 'edit.undo');
    await start(page, `adjust.${kind}`);
    const dialog = page.locator('dialog.adj-dialog[open]');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Automatic/ }).click();
    await dialog.locator('button.primary').click();
    await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
    await idle(page);
    const got = await pixels(page);
    for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - reference[i])).toBeLessThanOrEqual(2);
  });
