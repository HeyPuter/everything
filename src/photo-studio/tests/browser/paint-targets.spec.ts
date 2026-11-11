import { test, expect } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 120, '#808080', 'gray.png');
});

test('brush strokes stop at the canvas edge', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const l = newPixelLayer('Paint', e.doc);
    e.command('New Layer', (d) => d.layers.push(l));
    e.selected = l.id;
    e.color = '#ff0000';
  });
  await idle(page);
  await tool(page, 'Brush Tool');
  // A 40 px brush dragged from inside the canvas well past its right edge.
  await page.evaluate(async () => {
    const { brushFor } = await import('/src/features/paint.ts');
    Object.assign(brushFor('brush'), { size: 40, hardness: 1, smoothing: 0 });
  });
  await canvasDrag(page, [[150, 60], [260, 60]]);
  const result = await page.evaluate(() => {
    const e = window.photoStudio;
    const l = e.doc.layers.at(-1)!;
    return { bounds: l.pixels!.bounds, x: l.pixels!.x, keys: Object.keys(l.pixels!.tiles) };
  });
  expect(result.bounds).not.toBeNull();
  // Paint reaches the edge but no pixels are stored beyond it.
  expect(result.x + result.bounds!.x + result.bounds!.width).toBe(200);
  expect(result.bounds!.y).toBeGreaterThanOrEqual(0);
  expect(result.keys).toEqual(['0,0']);
});
