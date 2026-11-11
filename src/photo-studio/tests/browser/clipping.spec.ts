import { test, expect } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, canvasDrag, compositePixel, openProject, run, type Backend } from './helpers';

for (const backend of ['default', 'WebGL'] as Backend[])
  test(`a solid-color shape clips to the layer below (${backend})`, async ({ page }) => {
    await boot(page, backend);
    const doc = newDocument(200, 100, 'Clip');
    const base = layer('solid', 'Base', 60, 60);
    base.color = '#ff0000';
    base.transform.x = 10;
    base.transform.y = 10;
    doc.layers = [base];
    await openProject(page, doc, [], 'clip.photo');
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.color = '#0000ff';
      e.setTool('rect-shape');
    });
    await canvasDrag(page, [[40, 20], [120, 60]]);
    expect(await page.evaluate(() => window.photoStudio.layer?.kind)).toBe('vector');
    await run(page, 'layer.clipping-mask');
    expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true]);
    // The shape shows inside the base only; the base shows around it.
    expect(await compositePixel(page, 50, 30)).toEqual([0, 0, 255, 255]);
    expect(await compositePixel(page, 20, 30)).toEqual([255, 0, 0, 255]);
    expect((await compositePixel(page, 100, 30))[3]).toBe(0);
    // A new color reaches the clipped shape.
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { setVectorColor } = await import('/src/color/vector.ts');
      e.editLayer('Color', (l) => setVectorColor(l, '#00ff00'));
    });
    expect(await compositePixel(page, 50, 30)).toEqual([0, 255, 0, 255]);
  });
