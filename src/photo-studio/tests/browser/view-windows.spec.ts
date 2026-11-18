import { test, expect } from '@playwright/test';
import { boot, canvasClick, compositePixel, idle, menu, openImage, run, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080', 'first.png');
});

test('rotate view tool turns the canvas, keeps input mapped and resets with Escape', async ({ page }) => {
  await tool(page, 'Rotate View Tool');
  const box = (await page.locator('#viewport').boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  // A quarter turn clockwise, snapped by Shift.
  await page.keyboard.down('Shift');
  await page.mouse.move(cx + 150, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 100, { steps: 4 });
  await page.mouse.move(cx + 3, cy + 150, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => page.evaluate(() => window.photoStudio.rotation)).toBe(90);
  await expect(page.locator('#view-angle')).toHaveValue('90');
  // Document points still land where they are drawn: paint at a known point.
  const [x, y] = await page.evaluate(() => window.photoStudio.clientPoint(40, 30));
  expect(x).toBeGreaterThan(cx);
  expect(y).toBeLessThan(cy);
  await page.evaluate(() => window.photoStudio.setForeground('#ff0000'));
  await tool(page, 'Pencil Tool');
  await canvasClick(page, 40, 30);
  expect((await compositePixel(page, 40, 30)).slice(0, 3)).toEqual([255, 0, 0]);
  expect((await compositePixel(page, 260, 170)).slice(0, 3)).toEqual([128, 128, 128]);
  // The angle field sets the rotation; Escape resets it.
  await tool(page, 'Rotate View Tool');
  await page.locator('#view-angle').fill('-30');
  await page.locator('#view-angle').press('Enter');
  await expect.poll(() => page.evaluate(() => window.photoStudio.rotation)).toBe(-30);
  await page.locator('#viewport').focus();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.photoStudio.rotation)).toBe(0);
  // View → Flip Horizontal mirrors only the view.
  await menu(page, 'View', 'Flip Horizontal');
  const [fx] = await page.evaluate(() => window.photoStudio.clientPoint(0, 0));
  expect(fx).toBeGreaterThan(cx);
  await run(page, 'view.flip-horizontal');
});

test('2-up and tiled layouts show every document; clicking a window activates it', async ({ page }) => {
  await openImage(page, 200, 300, '#3060c0', 'second.png');
  await menu(page, 'Window', 'Arrange', '2-up Vertical');
  await expect(page.locator('.view-frame')).toHaveCount(2);
  await expect(page.locator('.view-frame.active')).toHaveCount(1);
  await expect(page.locator('.view-frame.active .tab-name')).toHaveText('second');
  // The inactive window shows a preview of the other document.
  const preview = page.locator('canvas.view-preview');
  await expect(preview).toHaveCount(1);
  const sample = () =>
    preview.evaluate((c: HTMLCanvasElement) => {
      const g = c.getContext('2d')!;
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  await expect.poll(sample).toEqual([128, 128, 128]);
  // Each window keeps its own zoom.
  await page.evaluate(() => window.photoStudio.zoomAt(2));
  const pbox = (await preview.boundingBox())!;
  await page.mouse.click(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
  await idle(page);
  await expect(page.locator('#document-name')).toHaveText('first');
  expect(await page.evaluate(() => window.photoStudio.views.map((v) => Math.round(v.zoom * 100)))).not.toEqual([200, 200]);
  await run(page, 'window.match-zoom');
  const zooms = await page.evaluate(() => window.photoStudio.views.map((v) => v.zoom));
  expect(zooms[0]).toBeCloseTo(zooms[1]);
  // A second window onto the same document follows edits live.
  await run(page, 'window.new-window');
  await run(page, 'window.tile-all');
  await expect(page.locator('.view-frame')).toHaveCount(3);
  await expect(page.locator('.document-tab .tab-window')).toHaveCount(2);
  await page.evaluate(() => window.photoStudio.setForeground('#00ff00'));
  await run(page, 'select.all');
  await run(page, 'edit.fill-foreground');
  const sibling = page.locator('canvas.view-preview').first();
  await expect
    .poll(() =>
      sibling.evaluate((c: HTMLCanvasElement) => {
        const d = c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return [d[0], d[1], d[2]];
      }),
    )
    .toEqual([0, 255, 0]);
  // Floating and consolidating.
  await run(page, 'window.float-all');
  await expect(page.locator('.view-float')).toHaveCount(3);
  await run(page, 'window.consolidate');
  await expect(page.locator('.view-frame')).toHaveCount(0);
  await expect(page.locator('.document-tabs .document-tab')).toHaveCount(3);
});

test('Cascade and Float All in Windows leave the tiled layout, also for the next session', async ({ page }) => {
  await openImage(page, 200, 300, '#3060c0', 'second.png');
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-preferences') ?? '{}').windowLayout);
  for (const id of ['window.cascade', 'window.float-all']) {
    await page.evaluate(() => window.photoStudio.runCommand('window.tile-vertical'));
    await idle(page);
    expect(await stored()).toBe('tile-vertical');
    await page.evaluate((id) => window.photoStudio.runCommand(id), id);
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.views.every((v) => !!v.floating))).toBe(true);
    expect(await stored(), id).toBe('tabs');
  }
});

test('Window › Documents lists the open windows, checks the active one and switches to another', async ({ page }) => {
  await openImage(page, 200, 300, '#3060c0', 'second.png');
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  const docs = page.locator('.menubar-entry.open > .menu-pop > .has-submenu').filter({ has: page.locator(':scope > .menu-label', { hasText: /^Documents$/ }) });
  await expect(docs).toHaveCount(1);
  const items = docs.locator('.submenu > .menu-item');
  await expect(items.locator('.menu-label')).toHaveText(['first', 'second']);
  await expect(items.nth(1)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await menu(page, 'Window', 'Documents', 'first');
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toBe('first');
});
