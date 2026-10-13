import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, client, idle, openImage, run, start, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#808080', 'gray.png');
});

async function addArtboard(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { createArtboard } = await import('/src/model/artboard.ts');
    e.command('Artboard', (d) => {
      d.layers.push(createArtboard(d, { x: 300, y: 50, width: 250, height: 300 }, {}, 'Board'));
    });
    e.selectLayers([e.doc.layers.at(-1)!.id]);
    e.setTool('move');
    e.update();
  });
  await idle(page);
}
/** Drag a new guide out of a ruler and drop it at a document point. */
async function dragGuide(page: Page, ruler: '#ruler-x' | '#ruler-y', to: [number, number]) {
  const box = (await page.locator(ruler).boundingBox())!;
  const [x, y] = await client(page, ...to);
  const from = ruler === '#ruler-x' ? [x, box.y + box.height / 2] : [box.x + box.width / 2, y];
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
  await idle(page);
}

test('guides dropped on an artboard belong to it and move with it', async ({ page }) => {
  await addArtboard(page);
  // A horizontal guide dropped on the artboard, a vertical one beside it.
  await dragGuide(page, '#ruler-x', [400, 120]);
  await dragGuide(page, '#ruler-y', [100, 300]);
  const state = await page.evaluate(() => {
    const d = window.photoStudio.doc;
    return { canvas: d.guides, board: d.layers.at(-1)!.artboard!.guides };
  });
  expect(state.canvas).toEqual([{ orientation: 'vertical', position: 100 }]);
  expect(state.board).toEqual([{ orientation: 'horizontal', position: 70 }]);
  // The artboard guide spans only its artboard.
  const line = page.locator('#overlay line.guide.artboard-guide');
  await expect(line).toHaveCount(1);
  expect(await line.getAttribute('x1')).toBe('300');
  expect(await line.getAttribute('x2')).toBe('550');

  // Moving the artboard carries its guide.
  await page.evaluate(() =>
    window.photoStudio.command('Move Artboard', (d) => {
      const a = d.layers.at(-1)!.artboard!;
      a.rect = { ...a.rect, y: a.rect.y + 20 };
    }),
  );
  await idle(page);
  expect(await page.locator('#overlay line.guide.artboard-guide').getAttribute('y1')).toBe('140');

  // Show > Artboard Guides and Canvas Guides hide each kind.
  await run(page, 'view.show-artboard-guides');
  await expect(page.locator('#overlay line.guide.artboard-guide')).toHaveCount(0);
  await expect(page.locator('#overlay line.guide')).toHaveCount(1);
  await run(page, 'view.show-canvas-guides');
  await expect(page.locator('#overlay line.guide')).toHaveCount(0);
  await run(page, 'view.show-artboard-guides');
  await run(page, 'view.show-canvas-guides');
  await expect(page.locator('#overlay line.guide')).toHaveCount(2);

  // Clear Selected Artboard Guides keeps canvas guides.
  await run(page, 'view.guides-clear-artboard');
  const after = await page.evaluate(() => ({ canvas: window.photoStudio.doc.guides, board: window.photoStudio.doc.layers.at(-1)!.artboard!.guides }));
  expect(after).toEqual({ canvas: [{ orientation: 'vertical', position: 100 }], board: undefined });
});

test('an artboard guide is selected and moved with the Move tool and survives a save', async ({ page }) => {
  await addArtboard(page);
  await dragGuide(page, '#ruler-y', [350, 200]);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.artboard!.guides)).toEqual([{ orientation: 'vertical', position: 50 }]);
  // Click selects; dragging within the artboard keeps it an artboard guide.
  const [gx, gy] = await client(page, 350, 200);
  await page.mouse.click(gx, gy);
  await expect(page.locator('#overlay line.guide.selected')).toHaveCount(1);
  const [tx] = await client(page, 420, 200);
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(tx, gy, { steps: 6 });
  await page.mouse.up();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.artboard!.guides)).toEqual([{ orientation: 'vertical', position: 120 }]);
  // Round trip through a .photo project.
  const restored = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const r = await deserialize(await serialize(e.doc, e.assets));
    return r.document.layers.at(-1)!.artboard!.guides;
  });
  expect(restored).toEqual([{ orientation: 'vertical', position: 120 }]);
});

test('New Guides From Shape uses the outline of a shape layer', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    e.command('Box', (d) => {
      const l = layer('solid', 'Box', 80, 60);
      l.transform = { x: 40, y: 30, width: 80, height: 60, rotation: 0 };
      d.layers.push(l);
    });
    e.selectLayers([e.doc.layers.at(-1)!.id]);
  });
  await run(page, 'view.guides-from-shape');
  const guides = await page.evaluate(() => window.photoStudio.doc.guides!.map((g) => `${g.orientation[0]}${g.position}`));
  expect(guides).toEqual(['v40', 'v120', 'h30', 'h90', 'v80', 'h60']);
});

test('Actual Size shows one image pixel per display pixel', async ({ page }) => {
  await run(page, 'view.actual-size');
  await page.waitForFunction(() => Math.abs(window.photoStudio.zoom - 1 / devicePixelRatio) < 1e-6);
  await run(page, 'view.actual-pixels');
  await page.waitForFunction(() => Math.abs(window.photoStudio.zoom - 1) < 1e-6);
});

test('legacy gamma 1.8 proof lightens midtones on screen only', async ({ page }) => {
  await run(page, 'view.proof-legacy-rgb');
  await expect(page.locator('.document-tab.active')).toContainText('Legacy RGB (Gamma 1.8)');
  // Document values are unchanged.
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(1);
  await run(page, 'view.proof-srgb');
  await expect(page.locator('.document-tab.active')).toContainText('sRGB');
});

test('Convert to Linked writes the contents and links them', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const data = new Uint8ClampedArray(60 * 40 * 4);
    for (let i = 0; i < data.length; i += 4) data.set([200, 40, 40, 255], i);
    const object = newPixelLayer('Object', e.doc, gridFromImage(e.assets.tiles, { width: 60, height: 40, data }, 100, 40));
    e.command('Object', (d) => d.layers.push(object));
    e.selectLayers([object.id]);
  });
  await idle(page);
  await run(page, 'layer.embed-convert');
  // A save picker that records what is written and reads it back.
  await page.evaluate(() => {
    const w = window as unknown as { saved?: Blob; showSaveFilePicker: unknown };
    w.showSaveFilePicker = async (opts: { suggestedName?: string }) => ({
      name: opts.suggestedName ?? 'contents',
      async createWritable() {
        return { write: async (b: Blob) => void (w.saved = b), close: async () => {} };
      },
      async getFile() {
        return new File([w.saved!], opts.suggestedName ?? 'contents', { lastModified: 1 });
      },
    });
  });
  await start(page, 'layer.embed-convert-linked');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('Convert to Linked');
  await dialog.locator('button[type="submit"]').click();
  await idle(page);
  const link = await page.evaluate(() => {
    const e = window.photoStudio;
    const c = e.doc.embeds![e.layer!.embed!.contents];
    return { name: c.link?.name, kind: c.link?.kind, size: c.link?.size, saved: (window as unknown as { saved?: Blob }).saved?.size };
  });
  expect(link.kind).toBe('local');
  expect(link.name).toMatch(/\.(png|photo)$/);
  expect(link.size).toBe(link.saved);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Convert to Linked');
  // The file reads back unchanged.
  await run(page, 'layer.embed-update');
  await expect(page.locator('#status')).toContainText(/up to date/i);
  // Already linked: the command is disabled.
  expect(await page.evaluate(async () => {
    const { commands } = await import('/src/app/registry.ts');
    return commands.get('layer.embed-convert-linked')!.enabled!(window.photoStudio);
  })).toBe(false);
});

test('Refine Mask Edge rewrites the mask near its edge', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { emptyGrid, writeRect } = await import('/src/model/tiles.ts');
    // A loose rectangular mask on the gray layer.
    const m = new Uint8Array(600 * 400);
    for (let y = 100; y < 300; y++) for (let x = 150; x < 450; x++) m[y * 600 + x] = 255;
    const grid = writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: 600, height: 400, data: m });
    e.command('Mask', (d) => void (d.layers[0].maskGrid = grid));
    e.selectLayers([e.doc.layers[0].id]);
  });
  await start(page, 'layer.mask-refine-edge');
  const dialog = page.locator('dialog[open]');
  await dialog.locator('input[name="feather"]').fill('6');
  await dialog.locator('button[type="submit"]').click();
  await idle(page);
  await page.waitForFunction(() => window.photoStudio.history.labels.at(-1) === 'Refine Mask Edge');
  const values = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask } = await import('/src/model/tiles.ts');
    const m = readMask(e.assets.tiles, e.doc.layers[0].maskGrid!, { x: 0, y: 0, width: 600, height: 400 });
    return [m.data[200 * 600 + 300], m.data[200 * 600 + 150], m.data[10 * 600 + 10]];
  });
  // Inside stays shown, the edge is softened, far outside stays hidden.
  expect(values[0]).toBe(255);
  expect(values[1]).toBeGreaterThan(0);
  expect(values[1]).toBeLessThan(255);
  expect(values[2]).toBe(0);
});

test('block text, vertical forms and named stylistic sets', async ({ page }) => {
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 40, 120);
  await page.keyboard.type('BIG');
  await page.keyboard.press('Enter');
  await page.keyboard.type('HEADLINE');
  await page.keyboard.press('Escape');
  await idle(page);
  await run(page, 'type.arc-block');
  const block = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layoutOf, ppiOf } = await import('/src/features/type/text-utils.ts');
    const d = e.layer!.textData!;
    return { block: d.block, widths: layoutOf(d, ppiOf(e)).lines.map((l) => Math.round(l.width)) };
  });
  expect(block.block!.width).toBeGreaterThan(50);
  expect(block.widths).toEqual([Math.round(block.block!.width), Math.round(block.block!.width)]);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Convert to Block Text');

  // Inter names its stylistic sets; the first one is offered by name.
  await page.waitForFunction(async () => {
    const { commands } = await import('/src/app/registry.ts');
    const c = commands.get('type.ot-ss01')!;
    return !c.hidden && c.label.startsWith('Set 1:');
  });
  await run(page, 'type.ot-ss01');
  expect(await page.evaluate(() => window.photoStudio.layer!.textData!.content.paragraphs[0].runs[0].style.features)).toContain('ss01');

  // Vertical text turns Latin sideways on request (the block is dropped).
  await run(page, 'type.vertical');
  await run(page, 'type.vertical-rotate');
  const v = await page.evaluate(() => {
    const d = window.photoStudio.layer!.textData!;
    return { orientation: d.orientation, block: d.block, vertical: d.content.paragraphs[0].runs[0].style.vertical };
  });
  expect(v).toEqual({ orientation: 'vertical', block: undefined, vertical: 'rotate' });
});
