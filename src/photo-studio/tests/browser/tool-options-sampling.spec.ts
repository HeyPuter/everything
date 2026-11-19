import { test, expect } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, idle, openImage, run, tool } from './helpers';

// Sampling options: the Eyedropper's ring and layer choices, the Magic Wand's
// sample size and Select Subject in the assisted selection tools.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 100, '#ff0000');
});

test('the Eyedropper shows its sampling ring while dragging, unless turned off', async ({
  page,
}) => {
  await tool(page, 'Eyedropper Tool');
  const ring = page.locator('.sampling-ring');
  const [x, y] = await client(page, 50, 50);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(ring).toHaveCount(1);
  await page.mouse.move(x + 10, y);
  await page.mouse.up();
  await expect(ring).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.color)).toBe('#ff0000');
  await page.locator('#sampling-ring').uncheck();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y);
  await expect(ring).toHaveCount(0);
  await page.mouse.up();
});

test('Current & Below ignores the layers above', async ({ page }) => {
  // A blue layer above the red image; the red layer stays selected.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const red = e.selected;
    await e.runCommand('layer.new-quick');
    e.setForeground('#0000ff');
    await e.runCommand('edit.fill-foreground');
    e.selectLayers([red]);
    e.update();
  });
  await idle(page);
  await tool(page, 'Eyedropper Tool');
  const sample = page.locator('#sample-layers');
  await expect(sample.locator('option')).toHaveText([
    'Current Layer',
    'Current & Below',
    'All Layers',
    'All Layers No Adjustments',
    'Current & Below No Adjustments',
  ]);
  await sample.selectOption('all');
  await canvasClick(page, 20, 20);
  await expect.poll(() => page.evaluate(() => window.photoStudio.color)).toBe('#0000ff');
  await sample.selectOption('below');
  await canvasClick(page, 30, 30);
  await expect.poll(() => page.evaluate(() => window.photoStudio.color)).toBe('#ff0000');
});

test('the Magic Wand offers a sample size and Select Subject', async ({ page }) => {
  await tool(page, 'Magic Wand Tool');
  const size = page.locator('#wand-sample-size');
  await size.selectOption('5');
  expect(await page.evaluate(() => window.photoStudio.settings.wandSampleSize)).toBe(5);
  await canvasClick(page, 50, 50);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeEnabled();
  await tool(page, 'Object Selection Tool');
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeVisible();
  await tool(page, 'Quick Selection Tool');
  await expect(
    page.locator('#tool-options').getByRole('button', { name: 'Select Subject' }),
  ).toBeVisible();
  await run(page, 'select.deselect');
});

test('the Magic Eraser erases by its opacity', async ({ page }) => {
  await tool(page, 'Magic Eraser Tool');
  await page.locator('#magic-eraser-opacity').fill('50');
  await page.locator('#magic-eraser-opacity').press('Enter');
  await canvasClick(page, 50, 50);
  await idle(page);
  const alpha = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    return readRGBA(e.assets.tiles, l.pixels!, { x: 50, y: 50, width: 1, height: 1 }).data[3];
  });
  expect(alpha).toBeGreaterThan(120);
  expect(alpha).toBeLessThan(135);
});

test('Sharpen with Protect Detail adds no halo beyond the neighboring values', async ({ page }) => {
  // A soft gray step: 100 on the left, 160 on the right.
  const range = async (protect: boolean) => {
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
      const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
      e.command('Step', (d) => {
        const l = d.layers[0];
        const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
        for (let y = 0; y < 100; y++)
          for (let x = 0; x < 200; x++)
            img.data.set(x < 100 ? [100, 100, 100, 255] : [160, 160, 160, 255], (y * 200 + x) * 4);
        setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
      });
    });
    await idle(page);
    const box = page.locator('#sharpen-protect');
    if (protect) await box.check();
    else await box.uncheck();
    for (let i = 0; i < 4; i++)
      await canvasDrag(page, [
        [100, 20],
        [100, 80],
      ]);
    await idle(page);
    return page.evaluate(async () => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const img = readRGBA(e.assets.tiles, e.layer!.pixels!, {
        x: 90,
        y: 50,
        width: 20,
        height: 1,
      });
      const r = Array.from({ length: 20 }, (_, i) => img.data[i * 4]);
      return [Math.min(...r), Math.max(...r)];
    });
  };
  await tool(page, 'Sharpen Tool');
  await page.locator('#tool-strength').fill('100');
  await page.locator('#tool-strength').press('Enter');
  const [lo, hi] = await range(true);
  expect(lo).toBeGreaterThanOrEqual(100);
  expect(hi).toBeLessThanOrEqual(160);
  const [lo2, hi2] = await range(false);
  expect(lo2 < 100 || hi2 > 160).toBe(true);
});

test('the Note tool gives new notes the color chosen in its options bar', async ({ page }) => {
  await tool(page, 'Note Tool');
  const colors = page.getByRole('radiogroup', { name: 'Color of new notes' });
  await colors.getByRole('radio', { name: 'Note color 3' }).click();
  await expect(colors.getByRole('radio', { name: 'Note color 3' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(colors.getByRole('radio', { name: 'Note color 4' })).toBeFocused();
  await canvasClick(page, 40, 40);
  await idle(page);
  const color = await page.evaluate(async () => {
    const { notesOf } = await import('/src/features/measure/notes.ts');
    return notesOf(window.photoStudio)[0]?.color;
  });
  expect(color).toBe('#64d2ff');
});

test('the marquee size readout shows the square that Shift makes', async ({ page }) => {
  await page.evaluate(() => {
    window.photoStudio.preferences.toolReadouts = true;
    window.photoStudio.preferences.rulerUnits = 'px';
  });
  await tool(page, 'Rectangular Marquee Tool');
  const [x0, y0] = await client(page, 20, 10);
  const [x1, y1] = await client(page, 80, 40);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 3 });
  await page.keyboard.down('Shift');
  await page.mouse.move(x1, y1, { steps: 3 });
  await expect(page.locator('.drag-readout')).toHaveText(/W: 60 px\s+H: 60 px/);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.selection)).toMatchObject({
    width: 60,
    height: 60,
  });
});

test('Blur with Sample All Layers retouches onto an empty layer above the photo', async ({
  page,
}) => {
  // A hard red | blue edge at x = 100 on the photo, an empty layer above it.
  const photo = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Edge', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
      for (let y = 0; y < 100; y++)
        for (let x = 100; x < 200; x++) img.data.set([0, 0, 255, 255], (y * 200 + x) * 4);
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
    });
    const id = e.selected;
    await e.runCommand('layer.new-quick');
    return id;
  });
  await idle(page);
  await tool(page, 'Blur Tool');
  await page.locator('#tool-strength').fill('100');
  await page.locator('#tool-strength').press('Enter');
  await page.locator('#focus-sample-all').check();
  for (let i = 0; i < 3; i++)
    await canvasDrag(page, [
      [100, 20],
      [100, 80],
    ]);
  await idle(page);
  const read = (id: string | null, x: number, y: number) =>
    page.evaluate(
      async ({ id, x, y }) => {
        const e = window.photoStudio;
        const { readRGBA } = await import('/src/model/tiles.ts');
        const { findLayer } = await import('/src/model/document.ts');
        const l = id ? findLayer(e.doc.layers, id)! : e.layer!;
        return Array.from(readRGBA(e.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data);
      },
      { id, x, y },
    );
  const top = await read(null, 100, 50);
  // The new layer now holds an opaque blend of red and blue at the edge.
  expect(top[3]).toBeGreaterThan(200);
  expect(top[0]).toBeGreaterThan(30);
  expect(top[2]).toBeGreaterThan(30);
  // The photo itself is untouched, and the layer stays empty away from the stroke.
  expect(await read(photo, 100, 50)).toEqual([0, 0, 255, 255]);
  expect((await read(null, 20, 50))[3]).toBe(0);
});

test('Blur with Sample All Layers keeps to its Mode, judged against the image shown', async ({
  page,
}) => {
  // A hard red | blue edge at x = 100 on the photo, an empty layer above it.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Edge', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
      for (let y = 0; y < 100; y++)
        for (let x = 100; x < 200; x++) img.data.set([0, 0, 255, 255], (y * 200 + x) * 4);
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
    });
    await e.runCommand('layer.new-quick');
  });
  await idle(page);
  await tool(page, 'Blur Tool');
  await page.locator('#tool-strength').fill('100');
  await page.locator('#tool-strength').press('Enter');
  await page.locator('#brush-mode').selectOption('lighten');
  await page.locator('#focus-sample-all').check();
  await canvasDrag(page, [
    [100, 20],
    [100, 80],
  ]);
  await idle(page);
  const top = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    return Array.from(
      readRGBA(e.assets.tiles, e.layer!.pixels!, { x: 100, y: 50, width: 1, height: 1 }).data,
    );
  });
  // Lighten keeps the blue side's full blue and only adds the red blurred in.
  expect(top[3]).toBeGreaterThan(200);
  expect(top[0]).toBeGreaterThan(30);
  expect(top[2]).toBeGreaterThan(245);
});

test('the Healing Brush in Replace mode copies the source; Spot Healing offers the blend modes', async ({
  page,
}) => {
  // Gray photo with a dark band at the top to sample from.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Band', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
      for (let i = 0; i < img.data.length; i += 4)
        img.data.set(i < 200 * 30 * 4 ? [40, 40, 40, 255] : [160, 160, 160, 255], i);
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
    });
  });
  await idle(page);
  // (The tool() helper's flyout lookup also matches the Spot Healing Brush by name.)
  await page.evaluate(() => window.photoStudio.setTool('healing-brush'));
  await page.locator('#heal-mode').selectOption('replace');
  await page.locator('#retouch-size').fill('20');
  await page.locator('#retouch-size').press('Enter');
  await canvasClick(page, 100, 15, ['Alt']);
  await canvasDrag(page, [
    [100, 70],
    [101, 70],
  ]);
  await idle(page);
  const px = (x: number, y: number) =>
    page.evaluate(
      async ({ x, y }) => {
        const e = window.photoStudio;
        const { readRGBA } = await import('/src/model/tiles.ts');
        return readRGBA(e.assets.tiles, e.layer!.pixels!, { x, y, width: 1, height: 1 }).data[0];
      },
      { x, y },
    );
  // The source's dark gray, copied as is (a Normal heal would match the surroundings).
  expect(await px(100, 70)).toBeLessThan(70);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Healing Brush');
  // Spot Healing offers the blend modes, not Replace.
  await tool(page, 'Spot Healing Brush Tool');
  await expect(page.locator('#heal-mode option[value="replace"]')).toHaveCount(0);
  await expect(page.locator('#heal-mode option[value="darken"]')).toHaveCount(1);
});

test('Smudge with Sample All Layers smears the photo onto an empty layer', async ({ page }) => {
  const photo = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Edge', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 200, height: 100 });
      for (let y = 0; y < 100; y++)
        for (let x = 100; x < 200; x++) img.data.set([0, 0, 255, 255], (y * 200 + x) * 4);
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
    });
    const id = e.selected;
    await e.runCommand('layer.new-quick');
    return id;
  });
  await idle(page);
  await page.evaluate(() => window.photoStudio.setTool('smudge-tool'));
  await page.locator('#tool-strength').fill('90');
  await page.locator('#tool-strength').press('Enter');
  await page.locator('#focus-sample-all').check();
  // Drag red into the blue side.
  await canvasDrag(page, [
    [80, 50],
    [100, 50],
    [130, 50],
  ]);
  await idle(page);
  const top = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    return Array.from(
      readRGBA(e.assets.tiles, e.layer!.pixels!, { x: 115, y: 50, width: 1, height: 1 }).data,
    );
  });
  expect(top[3]).toBeGreaterThan(100);
  expect(top[0]).toBeGreaterThan(60);
  const base = await page.evaluate(async (id) => {
    const e = window.photoStudio;
    const { readRGBA } = await import('/src/model/tiles.ts');
    const { findLayer } = await import('/src/model/document.ts');
    return Array.from(
      readRGBA(e.assets.tiles, findLayer(e.doc.layers, id!)!.pixels!, {
        x: 115,
        y: 50,
        width: 1,
        height: 1,
      }).data,
    );
  }, photo);
  expect(base).toEqual([0, 0, 255, 255]);
});
