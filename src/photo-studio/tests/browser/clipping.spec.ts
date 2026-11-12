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

// Releasing a layer in the middle of a clipping group used to leave the
// layers above it clipped to the released layer instead of the base.
test('Release Clipping Mask in the middle of a group releases the layers above too', async ({ page }) => {
  await boot(page);
  const doc = newDocument(100, 40, 'Release');
  const base = layer('solid', 'Base', 100, 40);
  base.color = '#ff0000';
  const c1 = layer('solid', 'C1', 20, 20);
  c1.color = '#00ff00';
  const c2 = layer('solid', 'C2', 20, 20);
  c2.color = '#0000ff';
  c2.transform.x = 30;
  const c3 = layer('solid', 'C3', 20, 20);
  c3.color = '#ffffff';
  c3.transform.x = 60;
  for (const l of [c1, c2, c3]) l.clipped = true;
  doc.layers = [base, c1, c2, c3];
  await openProject(page, doc, [], 'release.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selected = e.doc.layers[2].id;
    e.update();
  });
  await run(page, 'layer.clipping-mask');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true, false, false]);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Release Clipping Mask');
  // C3 still shows where it did, instead of being cut away by C2's shape.
  expect(await compositePixel(page, 70, 10)).toEqual([255, 255, 255, 255]);
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, true, true, true]);
});
