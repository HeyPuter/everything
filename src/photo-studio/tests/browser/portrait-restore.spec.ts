// Filter → Portrait & Restore… in the running app: the workspace opens, filters
// toggle and preview in the worker, results apply as a new layer, a masked
// layer, the current layer or a Live Filter, and undo restores the document.
// AI requests go to a stubbed Puter SDK.
import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, menu, run, undo } from './helpers';

// txt2img returns a flat orange image, and records each call.
const PUTER = `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async(prompt,opts)=>{window.puter.ai.calls.push({prompt,opts});const c=document.createElement('canvas');c.width=200;c.height=150;const g=c.getContext('2d');g.fillStyle='#f08020';g.fillRect(0,0,200,150);return {src:c.toDataURL()};}}};`;

/** A 200x150 scene: a dark left half and a light right half with a noisy face-colored disc. */
async function scene(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 150), g = c.getContext('2d')!;
    g.fillStyle = '#404040';
    g.fillRect(0, 0, 100, 150);
    g.fillStyle = '#b8b8b8';
    g.fillRect(100, 0, 100, 150);
    g.fillStyle = '#dfac8c';
    g.beginPath();
    g.arc(150, 75, 34, 0, Math.PI * 2);
    g.fill();
    const id = g.getImageData(0, 0, 200, 150);
    let s = 7;
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < id.data.length; i += 4) for (let k = 0; k < 3; k++) id.data[i + k] += (r() - 0.5) * 24;
    // A scratch for Photo Restoration.
    for (let y = 10; y < 140; y++) id.data.set([250, 250, 250], (y * 200 + 30) * 4);
    g.putImageData(id, 0, 0);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob(), 'restore.png');
  });
  await idle(page);
}
const dialog = (page: Page) => page.locator('dialog.pr-workspace[open]');
/** Wait until the preview has rendered (no busy indicator). */
async function settled(page: Page) {
  await expect(dialog(page).locator('.pr-busy')).toBeHidden({ timeout: 60_000 });
}
async function openWorkspace(page: Page) {
  await menu(page, 'Filter', 'Portrait & Restore…');
  await expect(dialog(page).getByRole('heading', { name: 'Portrait & Restore' })).toBeVisible();
  await settled(page);
}
/** Screen position of a document point in the fitted preview. */
async function docToScreen(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await dialog(page).locator('.pr-canvas').boundingBox())!;
  const z = Math.min(box.width / 200, box.height / 150) * 0.96;
  return [box.x + box.width / 2 + (x - 100) * z, box.y + box.height / 2 + (y - 75) * z];
}
const pixel = (page: Page, layer: number, x: number, y: number) =>
  page.evaluate(
    async ({ layer, x, y }) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      return Array.from(readRGBA(e.assets.tiles, e.doc.layers[layer].pixels!, { x, y, width: 1, height: 1 }).data);
    },
    { layer, x, y },
  );

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-portrait-restore'));
});

test('opens from the Filter menu, toggles filters and applies as a new layer that undo removes', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  // Every filter is listed with a switch, grouped.
  for (const name of ['Skin Smoothing', 'JPEG Artifact Removal', 'Photo Restoration', 'Colorize', 'Color Transfer', 'Depth Blur', 'Style Transfer', 'Scene Changer']) await expect(d.getByRole('checkbox', { name: `Use ${name}` })).toBeVisible();
  for (const g of ['Portrait', 'Restoration', 'Color', 'Creative']) await expect(d.getByRole('group', { name: g })).toBeVisible();
  // Skin Smoothing starts on; add Photo Restoration and select it.
  await expect(d.getByRole('checkbox', { name: 'Use Skin Smoothing' })).toBeChecked();
  await d.getByRole('checkbox', { name: 'Use Photo Restoration' }).check();
  await d.getByRole('button', { name: 'Photo Restoration' }).click();
  await expect(d.getByRole('heading', { name: 'Photo Restoration' })).toBeVisible();
  await d.getByLabel('Show detected defects').check();
  await settled(page);
  await expect(d.locator('.pr-status')).toHaveText('2 filters on.');
  // Compare modes and hold-to-compare.
  await d.getByTitle('Side by side').click();
  await expect(d.getByTitle('Side by side')).toHaveAttribute('aria-checked', 'true');
  await d.getByRole('button', { name: 'Hold to Compare' }).dispatchEvent('pointerdown');
  await expect(d.getByRole('button', { name: 'Hold to Compare' })).toHaveAttribute('aria-pressed', 'true');
  await d.getByRole('button', { name: 'Hold to Compare' }).dispatchEvent('pointerup');
  await d.getByLabel('Zoom in').click();
  await d.getByRole('button', { name: 'Fit' }).click();
  // Output: new layer.
  await d.getByLabel('Send the result to').selectOption('new-layer');
  const before = await page.evaluate(() => window.photoStudio.doc.layers.length);
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  expect(await historyLabels(page)).toContain('Portrait & Restore');
  const names = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name));
  expect(names.length).toBe(before + 1);
  expect(names.at(-1)).toMatch(/Portrait & Restore/);
  // The scratch is repaired in the new layer, the original layer is untouched.
  expect((await pixel(page, 1, 30, 70))[0]).toBeLessThan(150);
  expect((await pixel(page, 0, 30, 70))[0]).toBeGreaterThan(220);
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(before);
});

test('colorize hints spread on the current layer, and settings are remembered', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Skin Smoothing' }).uncheck();
  await d.getByRole('button', { name: 'Colorize', exact: true }).click();
  await d.getByLabel('Hint color').fill('#2050e0');
  // Click the dark left half of the preview to place a blue hint.
  await d.getByTitle('Result only').click();
  await page.mouse.click(...(await docToScreen(page, 50, 75)));
  await expect(d.locator('.pr-count')).toHaveText('1 hint');
  await expect(d.getByRole('checkbox', { name: 'Use Colorize' })).toBeChecked();
  await settled(page);
  await d.getByLabel('Send the result to').selectOption('layer');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  const [r, , b] = await pixel(page, 0, 60, 120);
  expect(b).toBeGreaterThan(r + 8);
  // The light right half is across a strong edge and stays neutral.
  const [r2, g2, b2] = await pixel(page, 0, 120, 10);
  expect(Math.abs(b2 - r2)).toBeLessThan(14);
  expect(Math.abs(g2 - r2)).toBeLessThan(14);
  expect((await historyLabels(page)).at(-1)).toBe('Portrait & Restore');
  await undo(page);
  const [ru, , bu] = await pixel(page, 0, 60, 120);
  expect(Math.abs(bu - ru)).toBeLessThan(14);
  // Reopening remembers the selected filter.
  await openWorkspace(page);
  await expect(dialog(page).getByRole('heading', { name: 'Colorize' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('Scene Changer sends a request only on Generate and applies as a masked layer', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Scene Changer' }).click();
  await expect(d.getByText('Uses your Puter account')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { puter: { ai: { calls: unknown[] } } }).puter.ai.calls.length)).toBe(0);
  await d.getByLabel('Protect Subject').uncheck();
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The changed scene is applied.');
  const calls = await page.evaluate(() => (window as unknown as { puter: { ai: { calls: { prompt: string }[] } } }).puter.ai.calls);
  expect(calls.length).toBe(1);
  expect(calls[0].prompt).toContain('golden hour');
  await settled(page);
  // AI results cannot be a Live Filter.
  expect(await d.getByLabel('Send the result to').locator('option[value="live"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  await d.getByLabel('Send the result to').selectOption('masked-layer');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  const top = await page.evaluate(() => {
    const l = window.photoStudio.doc.layers.at(-1)!;
    return { mask: !!l.maskGrid, generated: l.generated };
  });
  expect(top.mask).toBe(true);
  expect(top.generated?.prompt).toBe('Scene: Golden hour');
  const [r, g, b] = await pixel(page, 1, 50, 50);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeGreaterThan(100);
  expect(b).toBeLessThan(80);
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(1);
});

test('applies as an editable Live Filter in one step and replays from settings', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Photo Restoration' }).check();
  await settled(page);
  await d.getByLabel('Send the result to').selectOption('live');
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  const live = await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters?.map((f) => f.id));
  expect(live).toEqual(['portrait-restore']);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps + 1);
  expect((await pixel(page, 0, 30, 70))[0]).toBeLessThan(150);
  // Double-clicking the Live Filter row reopens the workspace to edit it.
  await page.locator('#layers .live-filter-row[data-live-filter]').first().dblclick();
  await expect(dialog(page).getByRole('heading', { name: 'Portrait & Restore (Live Filter)' })).toBeVisible();
  await settled(page);
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  // Undo removes the Live Filter and its conversion together.
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters)).toBeUndefined();
  expect((await pixel(page, 0, 30, 70))[0]).toBeGreaterThan(220);
  // An action replays the stack from its settings.
  await run(page, 'filter.portrait-restore', { params: { filters: [{ id: 'restore', enabled: true, params: { scratches: 60, dust: 60 } }] } });
  expect((await pixel(page, 0, 30, 70))[0]).toBeLessThan(150);
});

test('presets save and load the settings', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await page.evaluate(() => localStorage.removeItem('photo-studio-portrait-restore-presets'));
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Depth Blur' }).check();
  await d.locator('.pr-presets summary').click();
  await d.getByLabel('Preset name').fill('Soft focus');
  await d.locator('[data-preset-act="save"]').click();
  await expect(d.locator('.pr-preset-list')).toContainText('Soft focus');
  await d.getByRole('button', { name: 'Reset All' }).click();
  await expect(d.getByRole('checkbox', { name: 'Use Depth Blur' })).not.toBeChecked();
  await d.locator('.pr-presets summary').click();
  await d.getByRole('button', { name: 'Soft focus', exact: true }).click();
  await expect(d.getByRole('checkbox', { name: 'Use Depth Blur' })).toBeChecked();
  await expect(d.locator('.pr-status')).toContainText('Soft focus');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
});

test('AI style with a reference image, and depth blur focus with the depth map saved as a channel', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  // A second layer to serve as the style reference.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(200 * 150 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([30, 90, 200, 255], i);
    const l = newPixelLayer('Reference', e.doc, gridFromImage(e.assets.tiles, { width: 200, height: 150, data }, 0, 0));
    l.visible = false;
    e.command('Add reference', (d) => d.layers.splice(0, 0, l));
    e.selectLayers([e.doc.layers[1].id]);
  });
  await idle(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Skin Smoothing' }).uncheck();
  await d.getByRole('button', { name: 'Style Transfer', exact: true }).click();
  await d.locator('.pr-form select').first().selectOption('ai');
  await expect(d.getByLabel('Brush Size')).toHaveCount(0);
  await d.getByLabel('Describe the Style').fill('a bold poster');
  await d.getByLabel('Style reference').selectOption({ label: 'Reference' });
  await expect(d.getByRole('button', { name: 'Remove Reference' })).toBeVisible();
  await d.getByRole('button', { name: 'Generate Style' }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The AI style is applied; Strength blends it.');
  const call = await page.evaluate(() => (window as unknown as { puter: { ai: { calls: { prompt: string; opts: { input_images?: string[] } }[] } } }).puter.ai.calls[0]);
  expect(call.prompt).toContain('Restyle this photo as a bold poster');
  expect(call.opts.input_images?.length).toBe(2);
  // Depth Blur: clicking the preview focuses there.
  await d.getByRole('checkbox', { name: 'Use Style Transfer' }).uncheck();
  await d.getByRole('button', { name: 'Depth Blur', exact: true }).click();
  await d.getByRole('checkbox', { name: 'Use Depth Blur' }).check();
  await settled(page);
  const focal = d.locator('.pr-form .fp-number').filter({ hasText: 'Focal Distance' }).locator('input[type="number"]');
  const before = await focal.inputValue();
  await d.getByTitle('Result only').click();
  // Click near the top of the image (far away), so the focus moves.
  await page.mouse.click(...(await docToScreen(page, 100, 6)));
  await expect(focal).not.toHaveValue(before);
  await d.getByLabel('Save the depth map as a channel').check();
  await settled(page);
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  const channels = await page.evaluate(() => window.photoStudio.doc.channels?.map((c) => c.name));
  expect(channels).toContain('Depth Map');
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.channels?.length ?? 0)).toBe(0);
});
