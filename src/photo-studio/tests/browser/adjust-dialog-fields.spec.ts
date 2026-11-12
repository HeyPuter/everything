import { test, expect, type Page } from '@playwright/test';
import { boot, client, historyLabels, idle, layerPixel, openImage, selectRect, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Levels number fields show the value in use and ignore blank entries', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'adjust.levels');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  const field = (label: string) => dialog.getByRole('spinbutton', { name: label, exact: true });
  // Out of range: clamped, and the field says so.
  await field('Output black').fill('999');
  await field('Output black').press('Tab');
  await expect(field('Output black')).toHaveValue('255');
  await field('Output white').fill('-20');
  await field('Output white').press('Tab');
  await expect(field('Output white')).toHaveValue('0');
  // Clearing a field and leaving it keeps the previous value.
  await field('Gamma').fill('');
  await field('Gamma').press('Tab');
  await expect(field('Gamma')).toHaveValue('1.00');
  await field('Input white').fill('');
  await field('Input white').press('Tab');
  await expect(field('Input white')).toHaveValue('255');
  await expect(dialog.getByRole('slider', { name: 'Input white point' })).toHaveAttribute('aria-valuenow', '255');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Brightness/Contrast fields ignore blank entries', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'adjust.brightness-contrast');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  const num = dialog.getByRole('spinbutton', { name: 'Brightness value' });
  await num.fill('40');
  await num.press('Tab');
  await expect(num).toHaveValue('40');
  await num.fill('');
  await num.press('Tab');
  await expect(num).toHaveValue('40');
  await expect(dialog.locator('input[type=range]').first()).toHaveValue('40');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Curves point fields ignore blank entries', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'adjust.curves');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  // Click the middle of the graph to add a point there.
  const graph = (await dialog.locator('svg.adj-curve').boundingBox())!;
  await page.mouse.click(graph.x + graph.width / 2, graph.y + graph.height / 2);
  const output = dialog.getByRole('spinbutton', { name: 'Output', exact: true });
  const value = await output.inputValue();
  expect(Number(value)).toBeGreaterThan(100);
  await output.fill('');
  await output.press('Tab');
  await expect(output).toHaveValue(value);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('Gradient Map stop fields ignore blank entries', async ({ page }) => {
  await openImage(page, 120, 80, '#808080');
  await start(page, 'adjust.gradient-map');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.locator('.adj-stop[data-i="1"]').click();
  const location = dialog.getByRole('spinbutton', { name: 'Stop location' });
  await expect(location).toHaveValue('100');
  await location.fill('');
  await location.press('Tab');
  await expect(location).toHaveValue('100');
  await expect(dialog.locator('.adj-stop')).toHaveCount(2);
  await expect(dialog.locator('.adj-stop[data-i="1"]')).toHaveAttribute('aria-label', /at 100%/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

async function openHalves(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 100);
    const g = c.getContext('2d')!;
    g.fillStyle = '#202020';
    g.fillRect(0, 0, 100, 100);
    g.fillStyle = '#606060';
    g.fillRect(100, 0, 100, 100);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'halves.png');
  });
  await idle(page);
}

test('Curves on-image adjustment samples the tone under the pointer inside a selection', async ({ page }) => {
  await openHalves(page);
  await selectRect(page, { x: 100, y: 0, width: 100, height: 100 });
  await start(page, 'adjust.curves');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'On-image adjustment' }).click();
  const [x, y] = await client(page, 150, 50);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 20, { steps: 4 });
  await page.mouse.up();
  // A point was added at the sampled tone (0x60 = 96) and raised.
  await expect(dialog.getByRole('spinbutton', { name: 'Input', exact: true })).toHaveValue('96');
  await expect(dialog.getByRole('spinbutton', { name: 'Output', exact: true })).toHaveValue('106');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('OK applies Black & White with its fractional default weights', async ({ page }) => {
  await openImage(page, 60, 40, '#c03020');
  await start(page, 'adjust.black-white');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  // Yellows starts at 92.78 %, between the 1 % steps of its field.
  await expect(dialog.getByRole('spinbutton', { name: 'Yellows value' })).toHaveValue('92.78');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('dialog.adj-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toEqual(['Black & White']);
  const [r, g, b] = await layerPixel(page, 30, 20);
  expect(r).toBe(g);
  expect(g).toBe(b);
});

test('the Properties editor of an adjustment layer never keeps settings that were not stored', async ({ page }) => {
  await openImage(page, 60, 40, '#806040');
  await page.evaluate(async () => {
    const { addAdjustmentLayer } = await import('/src/features/adjust/layers.ts');
    addAdjustmentLayer(window.photoStudio, 'brightness-contrast');
  });
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    if (!e.dock.isVisible('properties')) e.dock.show('properties');
  });
  const props = page.locator('.panel-body[aria-label="Properties"]');
  const brightness = props.getByRole('spinbutton', { name: 'Brightness value' });
  const stored = () => page.evaluate(() => (window.photoStudio.layer!.adjustment as { params: { brightness: number } }).params.brightness);
  await expect(brightness).toHaveValue('0');
  // A slider move that only previewed (no release), then the layer is selected again.
  await props.locator('input[type=range]').first().evaluate((r: HTMLInputElement) => {
    r.value = '60';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const ids = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.id));
  await page.evaluate((id) => (window.photoStudio.selectLayers([id]), window.photoStudio.update()), ids[0]);
  await idle(page);
  await page.evaluate((id) => (window.photoStudio.selectLayers([id]), window.photoStudio.update()), ids[1]);
  await idle(page);
  await expect(brightness).toHaveValue('0');
  // An edit refused because the layer is locked goes back to the stored value.
  await page.evaluate(() => window.photoStudio.command('Lock', (d) => Object.assign(d.layers[1], { locked: true, locks: { all: true } })));
  await idle(page);
  await brightness.fill('40');
  await brightness.press('Tab');
  await expect(brightness).toHaveValue('0');
  expect(await stored()).toBe(0);
  // After unlocking, editing another setting stores only that change.
  await page.evaluate(() => window.photoStudio.command('Unlock', (d) => Object.assign(d.layers[1], { locked: false, locks: undefined })));
  await idle(page);
  const contrast = props.getByRole('spinbutton', { name: 'Contrast value' });
  await contrast.fill('10');
  await contrast.press('Tab');
  await idle(page);
  expect(await stored()).toBe(0);
});
