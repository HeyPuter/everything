// Assisted editing in the running app: Denoise and Upscale end to end, plus
// Generate Image with a stubbed Puter SDK, Mask All Objects and Harmonize.
import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, menu, run } from './helpers';

// Puter stub: txt2img returns a flat image whose hue identifies the call.
const PUTER = `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async(prompt,opts)=>{const n=window.puter.ai.calls.push({prompt,opts});const c=document.createElement('canvas');c.width=256;c.height=192;const g=c.getContext('2d');g.fillStyle='hsl('+(n*90)+',80%,50%)';g.fillRect(0,0,256,192);return {src:c.toDataURL()};}}};`;

/** A 240x160 scene: gradient, three shapes, optional Gaussian-like noise. */
async function scene(page: Page, noise: number) {
  await page.evaluate(async (noise) => {
    const c = new OffscreenCanvas(240, 160), g = c.getContext('2d')!;
    g.fillStyle = '#7a8fa6';
    g.fillRect(0, 0, 240, 160);
    g.fillStyle = '#c0392b';
    g.beginPath();
    g.arc(60, 70, 32, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#27ae60';
    g.fillRect(130, 40, 60, 45);
    g.fillStyle = '#f1c40f';
    g.beginPath();
    g.arc(180, 125, 20, 0, Math.PI * 2);
    g.fill();
    const id = g.getImageData(0, 0, 240, 160);
    let s = 5;
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < id.data.length; i += 4) for (let k = 0; k < 3; k++) id.data[i + k] += (r() + r() + r() - 1.5) * noise * 2;
    g.putImageData(id, 0, 0);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob(), 'scene.png');
  }, noise);
  await idle(page);
}
/** Standard deviation of luma in a flat background patch of the bottom layer. */
const flatNoise = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const img = readRGBA(e.assets.tiles, e.doc.layers[0].pixels!, { x: 4, y: 110, width: 40, height: 40 });
    const v: number[] = [];
    for (let i = 0; i < img.data.length; i += 4) v.push(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]);
    const m = v.reduce((a, b) => a + b) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  });

test('Denoise from the Filter menu removes noise with a preview, and replays from an action', async ({ page }) => {
  await boot(page);
  await scene(page, 14);
  const before = await flatNoise(page);
  await menu(page, 'Filter', 'Denoise…');
  const dialog = page.locator('dialog.filter-dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Denoise' })).toBeVisible();
  await expect(dialog.getByText('Luminance Noise')).toBeVisible();
  await dialog.locator('.fd-ok').click();
  await idle(page);
  expect(await historyLabels(page)).toContain('Denoise');
  const after = await flatNoise(page);
  expect(after).toBeLessThan(before * 0.35);
  // Same filter with explicit settings (as an action plays it back), then as a live filter.
  await run(page, 'edit.undo');
  await run(page, 'filter.denoise', { params: { strength: 80, color: 80, detail: 20, quality: 'high' } });
  expect(await flatNoise(page)).toBeLessThan(before * 0.3);
  await run(page, 'filter.convert-live');
  await run(page, 'filter.sharpen-details', { params: { amount: 120, radius: 1.2, iterations: 10 } });
  const live = await page.evaluate(() => window.photoStudio.doc.layers[0].liveFilters?.map((f) => f.id));
  expect(live).toEqual(['sharpen-details']);
});

test('Upscale enlarges every layer and mask with Enhanced Upscale', async ({ page }) => {
  await boot(page);
  await scene(page, 0);
  // A second layer with a mask, and a selection, to check they all follow.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage, writeRect, emptyGrid } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(40 * 30 * 4).fill(255);
    const l = newPixelLayer('Patch', e.doc, gridFromImage(e.assets.tiles, { width: 40, height: 30, data }, 20, 100));
    l.maskGrid = writeRect(e.assets.tiles, emptyGrid(1), 20, 100, { width: 20, height: 30, data: new Uint8Array(600).fill(255) });
    e.command('Add', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
    e.update();
  });
  await idle(page);
  // Its live filter source follows the enlargement too.
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 1 } });
  await menu(page, 'Image', 'Upscale…');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Upscale' })).toBeVisible();
  await dialog.getByRole('button', { name: '3×' }).click();
  await expect(dialog.getByText('720 × 480 px')).toBeVisible();
  // The comparison renders both previews.
  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('dialog.adj-dialog .assist-compare canvas:last-of-type');
    return c ? c.getContext('2d')!.getImageData(80, 80, 1, 1).data[3] : 0;
  })).toBe(255);
  await dialog.getByRole('button', { name: 'OK' }).click();
  await page.waitForFunction(() => window.photoStudio.doc.width === 720);
  await idle(page);
  const state = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridDocBounds } = await import('/src/model/tiles.ts');
    const [bg, patch] = e.doc.layers;
    return { size: [e.doc.width, e.doc.height], bg: gridDocBounds(bg.pixels!), patch: gridDocBounds(patch.liveSource!), mask: gridDocBounds(patch.maskGrid!), labels: e.history.labels };
  });
  expect(state.size).toEqual([720, 480]);
  expect(state.bg).toEqual({ x: 0, y: 0, width: 720, height: 480 });
  expect(state.patch).toEqual({ x: 60, y: 300, width: 120, height: 90 });
  expect(state.mask!.width).toBeGreaterThanOrEqual(58);
  expect(state.mask!.width).toBeLessThanOrEqual(64);
  expect(state.labels).toContain('Upscale');
  // Edges stay crisp: the red disc's rim goes from background to red within a few pixels.
  const rim = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const row = readRGBA(e.assets.tiles, e.doc.layers[0].pixels!, { x: 60, y: 210, width: 120, height: 1 });
    const red = Array.from({ length: 120 }, (_, x) => row.data[x * 4] - row.data[x * 4 + 1]);
    const lo = red.findIndex((v) => v > 20), hi = red.findIndex((v) => v > 120);
    return hi - lo;
  });
  expect(rim).toBeLessThanOrEqual(4);
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.width)).toBe(240);
});

test('Generate Image adds the chosen variation as a layer with its prompt', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await scene(page, 0);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { rasterizeEllipse } = await import('/src/imaging/segment/mask-ops.ts');
    const { writeRect, emptyGrid } = await import('/src/model/tiles.ts');
    const { applySelection } = await import('/src/model/selection.ts');
    const m = rasterizeEllipse(120, 80, 60, 40, 240, 160);
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, m);
    e.command('Select', (d) => applySelection(d, grid));
    e.update();
  });
  await idle(page);
  await menu(page, 'Edit', 'Generate Image…');
  const dialog = page.locator('dialog.assist-studio');
  await expect(dialog.getByText('Before you generate')).toBeVisible();
  // Nothing is sent before Generate is pressed.
  expect(await page.evaluate(() => (window as unknown as { puter: { ai: { calls: unknown[] } } }).puter.ai.calls.length)).toBe(0);
  await dialog.locator('#as-prompt').fill('a paper boat');
  await dialog.locator('#as-style').selectOption('watercolor');
  await dialog.locator('#as-count').selectOption('3');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await dialog.getByRole('radio', { name: 'Variation 2' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await idle(page);
  const out = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { gridDocBounds } = await import('/src/model/tiles.ts');
    const top = e.doc.layers.at(-1)!;
    const calls = (window as unknown as { puter: { ai: { calls: { prompt: string; opts: Record<string, unknown> }[] } } }).puter.ai.calls;
    return { name: top.name, generated: top.generated, bounds: gridDocBounds(top.pixels!), masked: !!top.maskGrid, prompts: calls.map((c) => c.prompt), ratio: calls[0].opts.ratio, selection: e.doc.selection };
  });
  expect(out.name).toBe('Generated: a paper boat');
  expect(out.generated).toEqual({ kind: 'generate', prompt: 'a paper boat', style: 'watercolor' });
  expect(out.bounds).toEqual({ x: 60, y: 40, width: 120, height: 80 });
  expect(out.masked).toBe(true);
  expect(out.prompts).toHaveLength(3);
  expect(out.prompts[0]).toMatch(/^a paper boat\. Style: watercolor/);
  expect(out.ratio).toEqual({ w: 120, h: 80 });
  expect(out.selection).toBeNull();
  await expect(page.locator('#properties .assist-generated')).toContainText('a paper boat');
});

test('Mask All Objects and Harmonize create editable layers', async ({ page }) => {
  await boot(page);
  await scene(page, 0);
  await run(page, 'layer.mask-all-objects', { params: { minSize: 1, output: 'copies', source: 'layer' } });
  const objects = await page.evaluate(() => {
    const g = window.photoStudio.doc.layers.at(-1)!;
    return { name: g.name, kind: g.kind, children: g.children.map((c) => [c.name, !!c.maskGrid]) };
  });
  expect(objects.name).toBe('Objects');
  expect(objects.children).toHaveLength(3);
  expect(objects.children.every(([, masked]) => masked)).toBe(true);
  // Harmonize the top object copy against the scene beneath it.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers([e.doc.layers.at(-1)!.children.at(-1)!.id]);
    e.update();
  });
  await menu(page, 'Layer', 'Harmonize…');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog.getByRole('heading', { name: 'Harmonize' })).toBeVisible();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  const adj = await page.evaluate(() => {
    const kids = window.photoStudio.doc.layers.at(-1)!.children;
    const a = kids.at(-1)!;
    return { kind: a.kind, clipped: a.clipped, look: (a.adjustment?.params as { source?: { type: string } }).source?.type };
  });
  expect(adj).toEqual({ kind: 'adjustment', clipped: true, look: 'cube' });
});

test('Edit with Prompt sends the layer and keeps its transparency', async ({ page }) => {
  // txt2img with an input image returns it opaque and tinted; the input is kept.
  const puter = `window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{calls:[],txt2img:async(prompt,opts)=>{window.puter.ai.calls.push({prompt,opts});const c=document.createElement('canvas');c.width=opts.width||240;c.height=opts.height||160;const g=c.getContext('2d');g.fillStyle='#204080';g.fillRect(0,0,c.width,c.height);return {src:c.toDataURL()};}}};`;
  await boot(page, 'default', puter);
  await scene(page, 0);
  // Erase the left half of the photo layer.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Erase', (d) => {
      const l = d.layers[0];
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, { width: 120, height: 160, data: new Uint8ClampedArray(120 * 160 * 4) }), d);
    });
    e.selectLayers([e.doc.layers[0].id]);
    e.update();
  });
  await idle(page);
  await menu(page, 'Edit', 'Edit with Prompt…');
  const dialog = page.locator('dialog.assist-studio');
  await expect(dialog.getByText('Before you generate')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { puter: { ai: { calls: unknown[] } } }).puter.ai.calls.length)).toBe(0);
  await dialog.locator('#as-prompt').fill('make it blue');
  await dialog.locator('#as-count').selectOption('1');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog.getByRole('radio')).toHaveCount(1);
  await dialog.getByRole('radio', { name: 'Variation 1' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await idle(page);
  const out = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, gridDocBounds } = await import('/src/model/tiles.ts');
    const calls = (window as unknown as { puter: { ai: { calls: { opts: { input_image: string } }[] } } }).puter.ai.calls;
    // The image sent is the layer's own pixels (the visible right half).
    const bmp = await createImageBitmap(await (await fetch(calls[0].opts.input_image)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0);
    const sent = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const source = readRGBA(e.assets.tiles, e.doc.layers[0].pixels!, gridDocBounds(e.doc.layers[0].pixels!)!);
    let sentDiff = 0;
    for (let i = 0; i < source.data.length; i++) if (source.data[i + 3 - (i & 3)] === 255) sentDiff = Math.max(sentDiff, Math.abs(sent[i] - source.data[i]));
    const top = e.doc.layers.at(-1)!;
    const b = gridDocBounds(top.pixels!)!;
    const img = readRGBA(e.assets.tiles, top.pixels!, b);
    let transparent = true;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) transparent = false;
    return { size: [bmp.width, bmp.height, source.width, source.height], sentDiff, name: top.name, bounds: b, opaque: transparent, pixel: Array.from(img.data.subarray(0, 4)) };
  });
  expect(out.size).toEqual([120, 160, 120, 160]);
  expect(out.sentDiff).toBe(0);
  expect(out.name).toBe('Edited: make it blue');
  // The result covers only where the layer had pixels.
  expect(out.bounds).toEqual({ x: 120, y: 0, width: 120, height: 160 });
  expect(out.opaque).toBe(true);
  expect(out.pixel).toEqual([0x20, 0x40, 0x80, 255]);

  // An empty layer has nothing to edit: a message, no dialog.
  const messages = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { emptyGrid } = await import('/src/model/tiles.ts');
    const empty = newPixelLayer('Empty', e.doc, emptyGrid(4));
    e.command('New Layer', (d) => void d.layers.push(empty));
    e.selectLayers([empty.id]);
    const seen: string[] = [];
    const message = e.message.bind(e);
    e.message = (text: string, ...rest: unknown[]) => {
      seen.push(text);
      return (message as (...a: unknown[]) => void)(text, ...rest);
    };
    (window as unknown as { __seen: string[] }).__seen = seen;
    return e.doc.layers.length;
  });
  expect(messages).toBe(3);
  await run(page, 'edit.edit-with-prompt');
  expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toContain('There is nothing visible to edit here.');
  await expect(dialog).toBeHidden();
});
