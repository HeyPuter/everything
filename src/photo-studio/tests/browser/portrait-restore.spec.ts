// Filter → Portrait & Restore… in the running app: the workspace opens, filters
// toggle and preview in the worker, results apply as a new layer, a masked
// layer, the current layer or a Live Filter, and undo restores the document.
// AI requests go to a stubbed Puter SDK.
import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, menu, openImage, run, undo } from './helpers';

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
// The same, but each request waits for window.__aiOpen() while window.__aiGate is set.
const PUTER_GATED = PUTER.replace('window.puter.ai.calls.push({prompt,opts});', 'window.puter.ai.calls.push({prompt,opts});if(window.__aiGate)await window.__aiGate;window.__aiReturned=(window.__aiReturned||0)+1;');
// Holds the final-render worker's run requests while window.__holdFull is set.
const HOLD_FULL = `(() => {
  window.__heldRuns = [];
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(url, opts) { super(url, opts); this.__full = opts && opts.name === 'restore-full'; }
    postMessage(m, t) {
      if (this.__full && window.__holdFull && m && m.type === 'run') { window.__heldRuns.push(() => super.postMessage(m, t)); return; }
      return super.postMessage(m, t);
    }
  };
  window.__releaseFull = () => { window.__holdFull = false; for (const f of window.__heldRuns.splice(0)) f(); };
})();`;
type AIWindow = { puter: { ai: { calls: { prompt: string; opts: { input_image?: string } }[] } }; __aiGate?: Promise<void>; __aiOpen?: () => void; __aiReturned?: number; __holdFull?: boolean; __heldRuns: unknown[]; __releaseFull: () => void };

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
/** A pixel of the preview canvas at a document point. */
async function previewPixel(page: Page, x: number, y: number) {
  const [sx, sy] = await docToScreen(page, x, y);
  return page.evaluate(
    ([sx, sy]) => {
      const c = document.querySelector<HTMLCanvasElement>('dialog.pr-workspace[open] .pr-canvas')!;
      const r = c.getBoundingClientRect(), k = c.width / r.width;
      return Array.from(c.getContext('2d')!.getImageData(Math.round((sx - r.left) * k), Math.round((sy - r.top) * k), 1, 1).data);
    },
    [sx, sy],
  );
}
/** Red at (x, y) of a PNG data URL. */
const dataUrlRed = (page: Page, uri: string, x: number, y: number) =>
  page.evaluate(
    async ({ uri, x, y }) => {
      const img = new Image();
      img.src = uri;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return g.getImageData(x, y, 1, 1).data[0];
    },
    { uri, x, y },
  );
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
  // The result is kept in Generation History like other AI results.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { generationStore } = await import('/src/features/generations/record.ts');
        return (await generationStore().list()).map((x) => [x.kind, x.prompt]);
      }),
    )
    .toContainEqual(['restore', 'Scene: Golden hour']);
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

test('an AI result applied to the current layer marks it generated and is noted in provenance', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Scene Changer' }).click();
  await d.getByLabel('Protect Subject').uncheck();
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The changed scene is applied.');
  await settled(page);
  await d.getByLabel('Send the result to').selectOption('layer');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(1);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].generated?.prompt)).toBe('Scene: Golden hour');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { recordOf } = await import('/src/features/provenance/recorder.ts');
        const ps = window.photoStudio;
        const s = ps.sessions.find((x) => x.doc === ps.doc)!;
        return recordOf(s).ai.map((a) => a.kind);
      }),
    )
    .toContain('edit');
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

test('Live output while a layer mask or Quick Mask is edited filters the layer, not the mask', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  // A white layer mask, being edited.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: 200, height: 150, data: new Uint8Array(200 * 150).fill(255) });
    e.command('Add mask', (d) => void (d.layers[0].maskGrid = grid));
    e.maskTarget = e.doc.layers[0].id;
  });
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.editingMask)).toBe(true);
  const maskSum = () =>
    page.evaluate(async () => {
      const e = window.photoStudio;
      const { readMask } = await import('/src/model/tiles.ts');
      const grid = (e.settings.quickMask ?? e.doc.layers[0].maskGrid) as Parameters<typeof readMask>[1];
      return readMask(e.assets.tiles, grid, { x: 0, y: 0, width: 200, height: 150 }).data.reduce((a, v) => a + v, 0);
    });
  const liveOnce = async () => {
    await openWorkspace(page);
    const d = dialog(page);
    await d.getByRole('checkbox', { name: 'Use Skin Smoothing' }).uncheck();
    await d.getByRole('checkbox', { name: 'Use Photo Restoration' }).check();
    await settled(page);
    // The preview shows the layer's pixels with the scratch repaired.
    await d.getByTitle('Result only').click();
    expect((await previewPixel(page, 30.5, 70))[0]).toBeLessThan(150);
    await d.getByLabel('Send the result to').selectOption('live');
    await d.getByRole('button', { name: 'OK' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await idle(page);
  };
  const mask = await maskSum();
  await liveOnce();
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters?.map((f) => f.id))).toEqual(['portrait-restore']);
  expect((await pixel(page, 0, 30, 70))[0]).toBeLessThan(150);
  expect(await maskSum()).toBe(mask);
  await undo(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters)).toBeUndefined();
  // Quick Mask: the quick mask stays as it was.
  await page.evaluate(() => (window.photoStudio.maskTarget = ''));
  await run(page, 'select.quick-mask');
  const quick = await maskSum();
  await liveOnce();
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters?.map((f) => f.id))).toEqual(['portrait-restore']);
  expect((await pixel(page, 0, 30, 70))[0]).toBeLessThan(150);
  expect(await maskSum()).toBe(quick);
});

test('AI filters are sent the image as the filters before them leave it, the same each time', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Skin Smoothing' }).uncheck();
  await d.getByRole('checkbox', { name: 'Use Photo Restoration' }).check();
  await d.getByRole('button', { name: 'Scene Changer' }).click();
  await d.getByLabel('Protect Subject').uncheck();
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The changed scene is applied.');
  await d.getByRole('button', { name: 'Generate Again' }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The changed scene is applied.');
  const sent = await page.evaluate(() => (window as unknown as AIWindow).puter.ai.calls.map((c) => c.opts.input_image!));
  expect(sent.length).toBe(2);
  // The scratch (250 in the original) was repaired before the image was sent.
  expect(await dataUrlRed(page, sent[0], 30, 70)).toBeLessThan(150);
  expect(sent[1]).toBe(sent[0]);
  await expect(d.locator('.pr-ai-notice')).toContainText('filters that run before this one');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('Live output follows a Live Filter mask in the preview and is not offered with a selection it would ignore', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await run(page, 'filter.convert-live');
  // A Live Filter mask covering the right half: the scratch (x = 30) is outside it.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    const data = new Uint8Array(200 * 150);
    for (let y = 0; y < 150; y++) data.fill(255, y * 200 + 100, y * 200 + 200);
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: 200, height: 150, data });
    e.command('Add Live Filter Mask', (d) => void (d.layers[0].liveMask = grid));
  });
  await idle(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('checkbox', { name: 'Use Skin Smoothing' }).uncheck();
  await d.getByRole('checkbox', { name: 'Use Photo Restoration' }).check();
  await d.getByTitle('Result only').click();
  await settled(page);
  expect((await previewPixel(page, 30.5, 70))[0]).toBeLessThan(150);
  await d.getByLabel('Send the result to').selectOption('live');
  await settled(page);
  // Preview and result agree: the masked-out scratch stays.
  await expect.poll(async () => (await previewPixel(page, 30.5, 70))[0]).toBeGreaterThan(220);
  await expect(d.locator('.pr-output')).toContainText('Limited to the layer’s Live Filter mask.');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  expect((await pixel(page, 0, 30, 70))[0]).toBeGreaterThan(220);
  // With a selection the existing mask would override it: Live output is not offered.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { commitSelectionMask } = await import('/src/features/selection.ts');
    const data = new Uint8Array(200 * 150);
    for (let y = 0; y < 150; y++) data.fill(255, y * 200, y * 200 + 60);
    commitSelectionMask(e, { width: 200, height: 150, data }, 'replace', 'Select');
  });
  await idle(page);
  await openWorkspace(page);
  const out = dialog(page).getByLabel('Send the result to');
  expect(await out.locator('option[value="live"]').evaluate((o) => (o as HTMLOptionElement).disabled)).toBe(true);
  await expect(out).not.toHaveValue('live');
  await expect(dialog(page).locator('.pr-output')).toContainText('Live Filter mask limits all of its Live Filters');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('OK fixes the settings and zooming does not cancel the final render', async ({ page }) => {
  await page.addInitScript(HOLD_FULL);
  await boot(page, 'default', PUTER);
  // Large enough that zooming in asks for a full-size render, small enough that the fitted view does not.
  await openImage(page, 1700, 1275, '#b08070');
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByLabel('Send the result to').selectOption('new-layer');
  await page.evaluate(() => ((window as unknown as AIWindow).__holdFull = true));
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(d.locator('.pr-busy-text')).toHaveText('Rendering full size…');
  expect(await page.evaluate(() => (window as unknown as AIWindow).__heldRuns.length)).toBe(1);
  // The settings are inert while applying; Stop stays available.
  expect(await d.locator('.pr-side').evaluate((el) => el.inert)).toBe(true);
  expect(await d.locator('.pr-list').evaluate((el) => el.inert)).toBe(true);
  await expect(d.locator('.pr-stop')).toBeEnabled();
  // Zooming in past the preview would normally ask for a full-size render.
  for (let i = 0; i < 4; i++) await d.getByLabel('Zoom in').click();
  await d.getByRole('button', { name: '100%' }).click();
  // Give the zoom's debounce timers (250 ms, then 450 ms) time to fire.
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => (window as unknown as AIWindow).__heldRuns.length)).toBe(1);
  const before = await page.evaluate(() => window.photoStudio.doc.layers.length);
  await page.evaluate(() => (window as unknown as AIWindow).__releaseFull());
  await expect(dialog(page)).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(before + 1);
});

test('Reset All and loading a preset stop a running AI request', async ({ page }) => {
  await boot(page, 'default', PUTER_GATED);
  await page.evaluate(() => localStorage.removeItem('photo-studio-portrait-restore-presets'));
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  const gate = () => page.evaluate(() => {
    const w = window as unknown as AIWindow;
    w.__aiGate = new Promise<void>((r) => (w.__aiOpen = r));
  });
  const release = async (n: number) => {
    await page.evaluate(() => (window as unknown as AIWindow).__aiOpen!());
    await page.waitForFunction((n) => (window as unknown as AIWindow).__aiReturned === n, n);
    // The result decodes and would be applied within a few frames.
    await page.waitForTimeout(500);
  };
  // A preset to load later.
  await d.locator('.pr-presets summary').click();
  await d.getByLabel('Preset name').fill('Plain');
  await d.locator('[data-preset-act="save"]').click();
  await d.locator('.pr-presets summary').click();
  await d.getByRole('button', { name: 'Scene Changer' }).click();
  await d.getByLabel('Protect Subject').uncheck();
  await gate();
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toContainText('Generating');
  await d.getByRole('button', { name: 'Reset All' }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('Stopped by Reset All. Press the button to try again.');
  await expect(d.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  await release(1);
  await expect(d.getByRole('checkbox', { name: 'Use Scene Changer' })).not.toBeChecked();
  await expect(d.locator('.pr-ai-status')).toHaveText('Stopped by Reset All. Press the button to try again.');
  // Loading a preset stops it too.
  await d.getByLabel('Protect Subject').uncheck();
  await gate();
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toContainText('Generating');
  await d.locator('.pr-presets summary').click();
  await d.getByRole('button', { name: 'Plain', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('Stopped because a preset was loaded. Press the button to try again.');
  await release(2);
  await expect(d.getByRole('checkbox', { name: 'Use Scene Changer' })).not.toBeChecked();
  // Without interruptions a request still applies.
  await d.getByLabel('Protect Subject').uncheck();
  await page.evaluate(() => delete (window as unknown as AIWindow).__aiGate);
  await d.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(d.locator('.pr-ai-status')).toHaveText('The changed scene is applied.');
  await expect(d.getByRole('checkbox', { name: 'Use Scene Changer' })).toBeChecked();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('saving the depth map as a channel is not offered for Live Filter output', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page);
  await openWorkspace(page);
  const d = dialog(page);
  await d.getByRole('button', { name: 'Depth Blur', exact: true }).click();
  await d.getByRole('checkbox', { name: 'Use Depth Blur' }).check();
  await d.getByLabel('Save the depth map as a channel').check();
  await d.getByLabel('Send the result to').selectOption('live');
  await expect(d.getByLabel('Save the depth map as a channel')).toBeDisabled();
  await expect(d.locator('.pr-extra')).toContainText('Not available for Live Filter output');
  await d.getByLabel('Send the result to').selectOption('new-layer');
  await expect(d.getByLabel('Save the depth map as a channel')).toBeEnabled();
  await expect(d.getByLabel('Save the depth map as a channel')).toBeChecked();
  await d.getByLabel('Send the result to').selectOption('live');
  await settled(page);
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters?.map((f) => f.id))).toEqual(['portrait-restore']);
  expect(await page.evaluate(() => window.photoStudio.doc.channels?.length ?? 0)).toBe(0);
});
