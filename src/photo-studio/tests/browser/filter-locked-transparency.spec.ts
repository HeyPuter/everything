import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openProject, run, start } from './helpers';

// Filters keep the alpha of a layer whose transparency is locked, as brushes,
// fills and the Gradient tool do: a blur softens colors inside the shape but
// not its edge, in the dialog's canvas preview and in what OK applies.
const W = 64,
  H = 48;

async function setup(page: Page) {
  await boot(page);
  await openProject(page, {
    version: 1,
    id: 'doc',
    name: 'Locked',
    width: W,
    height: H,
    selection: null,
    layers: [],
  });
  await page.evaluate(
    async ({ W, H }) => {
      const e = window.photoStudio;
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const data = new Uint8ClampedArray(W * H * 4);
      // A red and green square with a hard edge, on transparency.
      for (let y = 12; y < 36; y++)
        for (let x = 16; x < 48; x++)
          data.set(x < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * W + x) * 4);
      const l = newPixelLayer(
        'Shape',
        e.doc,
        gridFromImage(e.assets.tiles, { width: W, height: H, data }, 0, 0),
      );
      l.protection = { transparency: true, composite: false, position: false };
      e.doc.layers.push(l);
      e.selectLayer(l.id);
      e.update();
    },
    { W, H },
  );
  await idle(page);
}
/** RGBA of the Shape layer in the given state ('doc' or the shown preview). */
const pixels = (page: Page, which: 'doc' | 'shown') =>
  page.evaluate(
    async ({ which, W, H }) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const doc = which === 'doc' ? e.doc : e.shownDoc;
      const l = doc.layers.find((x) => x.name === 'Shape')!;
      return Array.from(
        readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: W, height: H }).data,
      );
    },
    { which, W, H },
  );
const alphas = (px: number[]) => px.filter((_, i) => i % 4 === 3);

test('filters keep the alpha of a layer with locked transparency', async ({ page }) => {
  await setup(page);
  const before = await pixels(page, 'doc');
  await run(page, 'filter.apply.gaussian-blur', { params: { radius: 4 } });
  const after = await pixels(page, 'doc');
  expect(alphas(after)).toEqual(alphas(before));
  // The colors inside did blur across the red/green boundary.
  const at = (px: number[], x: number, y: number) => px.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
  expect(at(after, 31, 24)[1]).toBeGreaterThan(40);
  expect(at(after, 32, 24)[0]).toBeGreaterThan(40);

  // The dialog's canvas preview shows the same thing OK applies.
  await run(page, 'edit.undo');
  await start(page, 'filter.apply.gaussian-blur');
  const dialog = page.locator('dialog.filter-dialog[open]');
  await expect(dialog).toBeVisible();
  const radius = dialog.locator('input[type=number][data-key="radius"]');
  await radius.fill('4');
  await radius.press('Tab');
  await expect.poll(async () => at(await pixels(page, 'shown'), 31, 24)[1]).toBeGreaterThan(40);
  const shown = await pixels(page, 'shown');
  expect(alphas(shown)).toEqual(alphas(before));
  await dialog.locator('.fd-ok').click();
  await expect(page.locator('dialog.filter-dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await pixels(page, 'doc')).toEqual(shown);
});

test('Liquify keeps the alpha of a layer with locked transparency, in its preview too', async ({
  page,
}) => {
  await setup(page);
  const before = await pixels(page, 'doc');
  await start(page, 'filter.liquify');
  const d = page.locator('dialog.liquify-dialog[open]');
  await expect(d).toBeVisible();
  const coverage = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const c = document.querySelector<HTMLCanvasElement>('.liquify-dialog .lq-canvas')!;
              const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
              let n = 0;
              for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
              resolve(n);
            }),
          ),
        ),
    );
  const shapeArea = await coverage();
  // Forward Warp from the middle of the shape out past its right edge.
  const box = (await d.locator('.lq-canvas').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx - box.width * 0.1, cy);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++)
    await page.mouse.move(cx - box.width * 0.1 + i * box.width * 0.025, cy);
  await page.mouse.up();
  expect(await coverage()).toBe(shapeArea);
  await d.locator('.lq-ok').click();
  await expect(page.locator('dialog.liquify-dialog[open]')).toHaveCount(0);
  await idle(page);
  const after = await pixels(page, 'doc');
  expect(after).not.toEqual(before);
  expect(alphas(after)).toEqual(alphas(before));
});
