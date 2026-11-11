import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, downloadFrom, idle, layerNames, menu, openFiles, openImage, panel, run, selectRect, tool, undo } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

async function openSplit(page: Page, name = 'split.png') {
  await page.evaluate(async (name) => {
    const c = new OffscreenCanvas(200, 150);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 100, 150);
    g.fillStyle = '#0000ff';
    g.fillRect(100, 0, 100, 150);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob(), name);
  }, name);
  await idle(page);
}

/** Add a pixel layer with an opaque rectangle above the selected layer. */
async function addRectLayer(page: Page, name: string, rgba: number[], r: { x: number; y: number; width: number; height: number }) {
  await page.evaluate(
    async ({ name, rgba, r }) => {
      const e = window.photoStudio;
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const { insertAboveSelection } = await import('/src/features/files/open.ts');
      const data = new Uint8ClampedArray(r.width * r.height * 4);
      for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
      insertAboveSelection(e, newPixelLayer(name, e.doc, gridFromImage(e.assets.tiles, { width: r.width, height: r.height, data }, r.x, r.y)), 'Add layer');
    },
    { name, rgba, r },
  );
  await idle(page);
}

const samplePoints: [number, number][] = [
  [10, 10], [60, 40], [99, 75], [100, 75], [130, 100], [190, 140], [50, 120], [150, 20],
];
/** Composite RGBA at the sample points for the current document. */
async function sampleComposite(page: Page) {
  return page.evaluate(async (points) => {
    const e = window.photoStudio;
    await e.renderer.settle();
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const img = await compositeRGBA(e);
    return points.map(([x, y]) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)));
  }, samplePoints);
}
function expectClose(a: number[][], b: number[][], tolerance: number) {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => p.forEach((v, c) => expect(Math.abs(v - b[i][c]), `point ${samplePoints[i]} channel ${c}: ${p} vs ${b[i]}`).toBeLessThanOrEqual(tolerance)));
}

test('Quick Export names the file as Export As does: after the File Info title, else the document', async ({ page }) => {
  await openSplit(page, 'IMG_0042.png');
  expect((await downloadFrom(page, () => run(page, 'file.quick-export-png'))).name).toBe('IMG_0042.png');
  await page.evaluate(() => window.photoStudio.command('File Info', (d) => (d.info = { ...d.info, title: ' Harbor at Dusk ' })));
  await idle(page);
  expect((await downloadFrom(page, () => run(page, 'file.quick-export-png'))).name).toBe('Harbor at Dusk.png');
});

test('Quick Export as PNG downloads a PNG that decodes to the document', async ({ page }) => {
  await openSplit(page);
  const file = await downloadFrom(page, () => run(page, 'file.quick-export-png'));
  expect(file.name).toMatch(/\.png$/);
  expect([...file.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const decoded = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d')!;
    g.drawImage(bitmap, 0, 0);
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data);
    return { w: bitmap.width, h: bitmap.height, left: px(20, 20), right: px(180, 20) };
  }, [...file.bytes]);
  expect(decoded).toEqual({ w: 200, h: 150, left: [255, 0, 0, 255], right: [0, 0, 255, 255] });
});

test('.photo projects round trip pixel layers, masks, text and Live Filters', async ({ page }) => {
  await openSplit(page);
  // Live Filter on the background.
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 3 } });
  // A masked rectangle layer.
  await addRectLayer(page, 'Green', [0, 200, 0, 255], { x: 40, y: 30, width: 120, height: 90 });
  await selectRect(page, { x: 40, y: 30, width: 60, height: 90 });
  await run(page, 'layer.mask-reveal-selection');
  await run(page, 'select.deselect');
  // A text layer made with the type tool.
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 20, 140);
  await page.keyboard.type('Saved');
  await page.keyboard.press('Escape');
  await idle(page);
  await tool(page, 'Move Tool');
  const describe = () =>
    page.evaluate(async () => {
      const e = window.photoStudio;
      const { readMask, readRGBA } = await import('/src/model/tiles.ts');
      return e.doc.layers.map((l) => ({
        name: l.name,
        kind: l.kind,
        text: l.textData?.text,
        live: l.liveFilters?.map((f) => ({ id: f.id, params: f.params, enabled: f.enabled })),
        mask: l.maskGrid ? [readMask(e.assets.tiles, l.maskGrid, { x: 50, y: 50, width: 1, height: 1 }).data[0], readMask(e.assets.tiles, l.maskGrid, { x: 150, y: 50, width: 1, height: 1 }).data[0]] : undefined,
        pixel: l.pixels ? Array.from(readRGBA(e.assets.tiles, l.pixels, { x: 60, y: 40, width: 1, height: 1 }).data) : undefined,
      }));
    });
  const before = await describe();
  expect(before.map((l) => [l.name, l.kind])).toEqual([
    ['Background', 'pixel'],
    ['Green', 'pixel'],
    ['Saved', 'text'],
  ]);
  expect(before[0].live).toEqual([{ id: 'gaussian-blur', params: { radius: 3 }, enabled: true }]);
  expect(before[1].mask).toEqual([255, 0]);
  const composite = await sampleComposite(page);
  const file = await downloadFrom(page, () => run(page, 'file.download-project'));
  expect(file.name).toMatch(/\.photo$/);
  await openFiles(page, { name: 'roundtrip.photo', mimeType: 'application/octet-stream', buffer: file.bytes });
  await expect(page.locator('.document-tab')).toHaveCount(2);
  expect(await describe()).toEqual(before);
  expectClose(await sampleComposite(page), composite, 0);
});

test('PSD export and import round trip pixel layers, clipping and masks', async ({ page }) => {
  await openSplit(page);
  await addRectLayer(page, 'Base', [255, 255, 0, 255], { x: 20, y: 20, width: 100, height: 100 });
  await addRectLayer(page, 'Clipped', [0, 160, 0, 255], { x: 60, y: 60, width: 120, height: 80 });
  await run(page, 'layer.clipping-mask');
  // Mask the base layer to its left half.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selected = e.doc.layers[1].id;
    e.update();
  });
  await selectRect(page, { x: 0, y: 0, width: 70, height: 150 });
  await run(page, 'layer.mask-reveal-selection');
  await run(page, 'select.deselect');
  const structure = () =>
    page.evaluate(async () => {
      const { hasMask } = await import('/src/model/masks.ts');
      return window.photoStudio.doc.layers.map((l) => ({ name: l.name, clipped: !!l.clipped, masked: hasMask(l) || !!l.maskGrid || !!l.pixelMask }));
    });
  const before = await structure();
  expect(before).toEqual([
    { name: 'Background', clipped: false, masked: false },
    { name: 'Base', clipped: false, masked: true },
    { name: 'Clipped', clipped: true, masked: false },
  ]);
  const composite = await sampleComposite(page);
  // The clipped layer only shows inside the masked base: at (130,100) it is outside Base.
  expect(composite[4]).toEqual([0, 0, 255, 255]);
  const file = await downloadFrom(page, () => run(page, 'file.export-psd'));
  expect(file.name).toMatch(/\.psd$/);
  expect(file.bytes.subarray(0, 4).toString('latin1')).toBe('8BPS');
  await openFiles(page, { name: 'roundtrip.psd', mimeType: 'application/octet-stream', buffer: file.bytes });
  await expect(page.locator('.document-tab')).toHaveCount(2);
  expect(await structure()).toEqual(before);
  expectClose(await sampleComposite(page), composite, 1);
});

test('multiple documents open as tabs and switch and close independently', async ({ page }) => {
  await openImage(page, 120, 80, '#ff0000', 'red.png');
  await openImage(page, 90, 60, '#00ff00', 'green.png');
  const tabs = page.getByRole('tablist', { name: 'Open documents' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-size')).toHaveText('90 × 60 px');
  await tabs.nth(0).click();
  await idle(page);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tab-size')).toHaveText('120 × 80 px');
  // Edits stay with their own document's history.
  await run(page, 'layer.duplicate');
  expect(await layerNames(page)).toEqual(['Background', 'Background copy']);
  await expect(tabs.nth(0).locator('.dirty-dot')).toBeVisible();
  await tabs.nth(1).click();
  await idle(page);
  expect(await layerNames(page)).toEqual(['Background']);
  await expect(tabs.nth(1).locator('.dirty-dot')).toBeHidden();
  await tabs.nth(1).getByRole('button', { name: /^Close green/ }).click();
  await idle(page);
  await expect(tabs).toHaveCount(1);
  await expect(page.locator('#tab-size')).toHaveText('120 × 80 px');
  expect(await layerNames(page)).toEqual(['Background', 'Background copy']);
});

test('Actions record commands and play them back', async ({ page }) => {
  await openImage(page, 160, 100, '#808080', 'gray.png');
  const actions = await panel(page, 'Actions');
  await actions.getByRole('button', { name: 'Create new action', exact: true }).click();
  const dialog = page.locator('#dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill('Duplicate and rotate');
  await dialog.getByRole('button', { name: 'Record', exact: true }).click();
  await idle(page);
  await expect(actions.locator('.action-row.recording')).toHaveCount(1);
  await menu(page, 'Layer', 'Duplicate Layer');
  await menu(page, 'Image', 'Image Rotation', '90° Clockwise');
  await actions.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await idle(page);
  await expect(actions.locator('.action-row.recording')).toHaveCount(0);
  await expect(actions.locator('.action-row.step')).toHaveText(['Duplicate Layer', '90° Clockwise'].map((t) => new RegExp(t)));
  await undo(page);
  await undo(page);
  await expect(page.locator('#tab-size')).toHaveText('160 × 100 px');
  expect(await layerNames(page)).toEqual(['Background']);
  await actions.locator('.action-row.action', { hasText: 'Duplicate and rotate' }).click();
  await actions.getByRole('button', { name: 'Play selection', exact: true }).click();
  await idle(page);
  await expect(page.locator('#tab-size')).toHaveText('100 × 160 px');
  expect(await layerNames(page)).toEqual(['Background', 'Background copy']);
});
