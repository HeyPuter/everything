import { test, expect } from '@playwright/test';
import { boot, canvasDrag, historyLabels, idle, layerNames, layerPixel, layerRow, menu, openImage, panel, run, selectedRows, tool, undo } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150, '#808080', 'gray.png');
});

test('menus open from the menu bar and run commands', async ({ page }) => {
  const bar = page.getByRole('menubar');
  await bar.getByRole('menuitem', { name: 'Layer', exact: true }).click();
  await expect(bar.getByRole('menuitem', { name: 'Layer', exact: true })).toHaveAttribute('aria-expanded', 'true');
  // Entries without a registered command are omitted; registered ones show their shortcuts.
  await expect(page.locator('.menubar-entry.open .menu-item[data-command="layer.duplicate-dialog"]')).toBeVisible();
  // A pointer press outside closes the menu.
  await page.locator('#status').click();
  await expect(page.locator('.menubar-entry.open')).toHaveCount(0);
  await menu(page, 'Layer', 'Duplicate Layer…');
  await page.locator('#dialog[open]').getByRole('button', { name: 'OK' }).click();
  await idle(page);
  expect(await layerNames(page)).toEqual(['Background', 'Background copy']);
  await menu(page, 'Edit', 'Undo');
  expect(await layerNames(page)).toEqual(['Background']);
  // Nested submenus open on hover.
  await menu(page, 'Image', 'Image Rotation', '90° Clockwise');
  await expect(page.locator('#tab-size')).toHaveText('150 × 200 px');
  // Keyboard navigation: Enter opens a menu, arrows move, Escape closes.
  await bar.getByRole('menuitem', { name: 'File', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menubar-entry.open')).toHaveCount(1);
  const items = page.locator('.menubar-entry.open > .menu-pop > .menu-item');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.menubar-entry.open')).toHaveCount(0);
  await expect(bar.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(bar.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(bar.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('tool switching through slots, flyouts and shortcut cycling', async ({ page }) => {
  await tool(page, 'Brush Tool');
  await expect(page.getByRole('toolbar', { name: 'Editing tools' }).getByRole('button', { name: 'Brush Tool', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // The flyout lists every tool of the group.
  await page.locator('[data-slot="marquee"]').click({ button: 'right' });
  await expect(page.getByRole('menuitemradio')).toHaveText(['Rectangular Marquee Tool', 'Elliptical Marquee Tool', 'Single Row Marquee Tool', 'Single Column Marquee Tool'].map((t) => new RegExp(t)));
  await page.getByRole('menuitemradio', { name: /Elliptical Marquee Tool/ }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('ellipse-marquee');
  // The slot now shows the last used tool of its group.
  await expect(page.locator('[data-slot="marquee"]')).toHaveAttribute('aria-label', 'Elliptical Marquee Tool');
  await page.locator('#viewport').focus();
  await page.keyboard.press('v');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('move');
  await page.keyboard.press('b');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  await page.keyboard.press('Shift+B');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('pencil');
  await page.keyboard.press('Shift+B');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('color-replacement');
  await page.keyboard.press('Shift+B');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('mixer-brush');
  await page.keyboard.press('Shift+B');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  // A bare key reselects the group's current tool.
  await page.keyboard.press('m');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('ellipse-marquee');
  await expect(page.locator('#tool-name')).toHaveText('Elliptical Marquee Tool');
});

test('brush stroke paints pixels and undo restores them', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.setForeground('#ff0000'));
  await tool(page, 'Brush Tool');
  expect(await layerPixel(page, 100, 75)).toEqual([128, 128, 128, 255]);
  await canvasDrag(page, [[40, 75], [160, 75]]);
  await expect.poll(() => historyLabels(page)).toEqual(['Brush Tool']);
  const painted = await layerPixel(page, 100, 75);
  expect(painted[0]).toBeGreaterThan(240);
  expect(painted[1]).toBeLessThan(15);
  expect(await layerPixel(page, 100, 10)).toEqual([128, 128, 128, 255]);
  await undo(page);
  expect(await layerPixel(page, 100, 75)).toEqual([128, 128, 128, 255]);
});

test('rectangular marquee and Layer via Copy lift the selected pixels', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  await canvasDrag(page, [[20, 30], [80, 90]]);
  const sel = await page.evaluate(() => window.photoStudio.doc.selection);
  expect(sel).toEqual({ x: 20, y: 30, width: 60, height: 60 });
  await menu(page, 'Layer', 'New', 'Layer via Copy');
  expect(await layerNames(page)).toEqual(['Background', 'Background copy']);
  await expect(selectedRows(page)).toHaveCount(1);
  await expect(layerRow(page, 'Background copy')).toHaveAttribute('aria-pressed', 'true');
  const bounds = await page.evaluate(() => window.photoStudio.layer!.pixels!.bounds);
  expect(bounds).toMatchObject({ x: 20, y: 30, width: 60, height: 60 });
  expect(await layerPixel(page, 50, 60)).toEqual([128, 128, 128, 255]);
  expect((await layerPixel(page, 10, 10))[3]).toBe(0);
});

test('Quick Mask round trip turns painted mask into a selection', async ({ page }) => {
  await page.locator('#viewport').focus();
  await page.keyboard.press('q');
  await expect(page.locator('.quick-mask-button')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('brush');
  // White adds to the selection while in Quick Mask.
  await page.evaluate(() => window.photoStudio.setForeground('#ffffff'));
  await canvasDrag(page, [[50, 75], [150, 75]]);
  // Painting the quick mask does not touch layer pixels.
  expect(await layerPixel(page, 100, 75)).toEqual([128, 128, 128, 255]);
  await page.locator('#viewport').focus();
  await page.keyboard.press('q');
  await expect(page.locator('.quick-mask-button')).toHaveAttribute('aria-pressed', 'false');
  const sel = await page.evaluate(() => window.photoStudio.doc.selection);
  expect(sel).not.toBeNull();
  expect(sel!.x).toBeLessThanOrEqual(50);
  expect(sel!.x + sel!.width).toBeGreaterThanOrEqual(150);
  expect(sel!.y).toBeGreaterThan(30);
  expect(await historyLabels(page)).toContain('Quick Mask');
});

test('the Layers panel Add layer mask button adds a mask', async ({ page }) => {
  await page.locator('.layers-panel .layer-footer').getByRole('button', { name: 'Add layer mask', exact: true }).click();
  await idle(page);
  await expect(page.locator('#layers .mask-thumbnail')).toHaveCount(1);
});

test('Escape closes a menu opened with the pointer', async ({ page }) => {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Layer', exact: true }).click();
  await expect(page.locator('.menubar-entry.open')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.menubar-entry.open')).toHaveCount(0);
});

test('layer mask painting hides pixels and the mask thumbnail is the target', async ({ page }) => {
  await menu(page, 'Layer', 'Layer Mask', 'Reveal All');
  await expect(page.locator('#layers .mask-thumbnail')).toHaveCount(1);
  await page.locator('#layers .mask-thumbnail').click();
  await expect(page.locator('#layers .mask-thumbnail')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => window.photoStudio.setForeground('#000000'));
  await tool(page, 'Brush Tool');
  await canvasDrag(page, [[40, 75], [160, 75]]);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readMask, readRGBA } = await import('/src/model/tiles.ts');
    const l = e.layer!;
    const at = (x: number, y: number) => readMask(e.assets.tiles, l.maskGrid!, { x, y, width: 1, height: 1 }).data[0];
    return { painted: at(100, 75), untouched: at(100, 10), pixel: Array.from(readRGBA(e.assets.tiles, l.pixels!, { x: 100, y: 75, width: 1, height: 1 }).data) };
  });
  expect(result.painted).toBeLessThan(10);
  expect(result.untouched).toBe(255);
  // The layer's own pixels are unchanged; only the mask hides them.
  expect(result.pixel).toEqual([128, 128, 128, 255]);
  await idle(page);
  const shown = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const img = await compositeRGBA(window.photoStudio);
    const at = (x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
    return [at(100, 75), at(100, 10)];
  });
  expect(shown[0]).toBeLessThan(10);
  expect(shown[1]).toBe(255);
});

test('History panel jumps between states', async ({ page }) => {
  await run(page, 'layer.duplicate');
  await run(page, 'layer.duplicate');
  const history = await panel(page, 'History');
  // States are listed under the automatic first snapshot.
  const states = history.locator('.history-entries .history-row');
  await expect(states).toHaveCount(3);
  await states.first().click();
  await idle(page);
  expect(await layerNames(page)).toEqual(['Background']);
  await expect(history.locator('.history-row.undone')).toHaveCount(2);
  await states.nth(2).click();
  await idle(page);
  expect((await layerNames(page)).length).toBe(3);
});
