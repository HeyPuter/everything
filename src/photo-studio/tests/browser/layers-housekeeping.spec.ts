import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, compositePixel, historyLabels, idle, layerNames, menu, openImage, run, selectRect, tool, undo } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080', 'gray.png');
});

/** Add a solid color layer covering a rectangle above the selection. */
async function addBox(page: Page, name: string, color: string, r: { x: number; y: number; width: number; height: number }) {
  await page.evaluate(
    async ({ name, color, r }) => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const { insertAboveSelection } = await import('/src/features/files/open.ts');
      const l = layer('solid', name, r.width, r.height);
      l.color = color;
      l.transform = { ...r, rotation: 0 };
      insertAboveSelection(e, l, 'Add Box');
    },
    { name, color, r },
  );
  await idle(page);
}
const position = (page: Page, name: string) =>
  page.evaluate((name) => {
    const t = window.photoStudio.doc.layers.find((l) => l.name === name)!.transform;
    return [Math.round(t.x), Math.round(t.y)];
  }, name);

test('linked layers move together and unlink again', async ({ page }) => {
  await addBox(page, 'Red', '#ff0000', { x: 20, y: 20, width: 40, height: 30 });
  await addBox(page, 'Blue', '#0000ff', { x: 200, y: 120, width: 40, height: 30 });
  // Select both rows and link them from the panel footer.
  await page.locator('#layers').getByRole('button', { name: 'Red', exact: true }).click();
  await page.locator('#layers').getByRole('button', { name: 'Blue', exact: true }).click({ modifiers: ['Shift'] });
  await page.locator('.layer-footer [data-command="layer.link"]').click();
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Link Layers');
  await expect(page.locator('#layers .link-badge')).toHaveCount(2);
  // Select only Red and drag it: Blue follows.
  await page.locator('#layers').getByRole('button', { name: 'Red', exact: true }).click();
  await tool(page, 'Move Tool');
  await page.evaluate(() => (window.photoStudio.transform.snapping = false));
  await canvasDrag(page, [[40, 35], [70, 55]]);
  expect(await position(page, 'Red')).toEqual([50, 40]);
  expect(await position(page, 'Blue')).toEqual([230, 140]);
  expect(await compositePixel(page, 245, 150)).toEqual([0, 0, 255, 255]);
  // Select Linked Layers selects the partner; the menu offers Unlink.
  await run(page, 'layer.select-linked');
  await expect(page.locator('#layers .layer-row.selected')).toHaveCount(2);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Layer', exact: true }).click();
  await expect(page.locator('.menubar-entry.open .menu-item[data-command="layer.link"] .menu-label')).toHaveText('Unlink Layers');
  await page.keyboard.press('Escape');
  await run(page, 'layer.link');
  await expect(page.locator('#layers .link-badge')).toHaveCount(0);
  await page.locator('#layers').getByRole('button', { name: 'Red', exact: true }).click();
  await canvasDrag(page, [[60, 50], [70, 50]]);
  expect(await position(page, 'Red')).toEqual([60, 40]);
  expect(await position(page, 'Blue')).toEqual([230, 140]);
});

test('paste into masks the pasted pixels by the selection, unlinked', async ({ page }) => {
  await addBox(page, 'Red', '#ff0000', { x: 0, y: 0, width: 60, height: 60 });
  await selectRect(page, { x: 0, y: 0, width: 60, height: 60 });
  await run(page, 'edit.copy');
  await selectRect(page, { x: 150, y: 50, width: 40, height: 40 });
  await menu(page, 'Edit', 'Paste Special', 'Paste Into');
  expect(await layerNames(page)).toEqual(['Background', 'Red', 'Layer 1']);
  const info = await page.evaluate(() => {
    const l = window.photoStudio.layer!;
    return { mask: !!l.maskGrid, unlinked: l.maskUnlinked, selection: window.photoStudio.doc.selection };
  });
  expect(info).toEqual({ mask: true, unlinked: true, selection: null });
  // Inside the old selection the paste shows; around it the gray background does.
  expect(await compositePixel(page, 170, 70)).toEqual([255, 0, 0, 255]);
  expect(await compositePixel(page, 145, 70)).toEqual([128, 128, 128, 255]);
  // Moving the layer keeps the unlinked mask in place.
  await page.evaluate(() => window.photoStudio.transform.nudge(-15, 0));
  await idle(page);
  expect(await compositePixel(page, 185, 70)).toEqual([128, 128, 128, 255]);
  expect(await compositePixel(page, 160, 70)).toEqual([255, 0, 0, 255]);
  // Linking the mask from the panel glyph makes it follow the layer.
  await page.locator('#layers .mask-link').click();
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Link Layer Mask');
  await page.evaluate(() => window.photoStudio.transform.nudge(20, 0));
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.maskGrid!.x)).toBe(20);
  await undo(page);
  await undo(page);
  expect(await page.evaluate(() => !!window.photoStudio.layer!.maskUnlinked)).toBe(true);
  // Paste Outside uses the inverse of the selection (earlier pastes hidden).
  await page.evaluate(() => window.photoStudio.command('Hide', (d) => d.layers.slice(1).forEach((l) => (l.visible = false))));
  await selectRect(page, { x: 150, y: 50, width: 40, height: 40 });
  await run(page, 'edit.paste-outside');
  expect(await compositePixel(page, 170, 70)).toEqual([128, 128, 128, 255]);
  expect(await compositePixel(page, 125, 70)).toEqual([255, 0, 0, 255]);
});

// Paste, Paste Into and Paste Outside used to record a separate Deselect
// step, so one Undo left the pasted layer in place.
test('each paste is one undo step', async ({ page }) => {
  await addBox(page, 'Red', '#ff0000', { x: 0, y: 0, width: 60, height: 60 });
  await selectRect(page, { x: 0, y: 0, width: 60, height: 60 });
  await run(page, 'edit.copy');
  for (const id of ['edit.paste', 'edit.paste-into', 'edit.paste-outside']) {
    await selectRect(page, { x: 150, y: 50, width: 40, height: 40 });
    const before = await historyLabels(page);
    await run(page, id);
    expect(await layerNames(page)).toEqual(['Background', 'Red', 'Layer 1']);
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toBeNull();
    expect((await historyLabels(page)).length).toBe(before.length + 1);
    await undo(page);
    expect(await layerNames(page)).toEqual(['Background', 'Red']);
    expect(await page.evaluate(() => window.photoStudio.doc.selection)).toEqual({ x: 150, y: 50, width: 40, height: 40 });
  }
});

// Hide Layers on a mix of shown and hidden layers toggled each one, so the
// hidden layers appeared instead of every selected layer being hidden.
test('Hide Layers hides every selected layer, then shows them all', async ({ page }) => {
  await addBox(page, 'Red', '#ff0000', { x: 0, y: 0, width: 20, height: 20 });
  await addBox(page, 'Blue', '#0000ff', { x: 30, y: 0, width: 20, height: 20 });
  const visible = () => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.visible));
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Hide Blue', (d) => (d.layers[2].visible = false));
    e.selectLayers(e.doc.layers.slice(1).map((l) => l.id));
    e.update();
  });
  await run(page, 'layer.hide');
  expect(await visible()).toEqual([true, false, false]);
  expect((await historyLabels(page)).at(-1)).toBe('Hide Layers');
  await run(page, 'layer.hide');
  expect(await visible()).toEqual([true, true, true]);
  expect((await historyLabels(page)).at(-1)).toBe('Show Layers');
});

test('background layer, isolation, hidden layers and find', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { makeBackground } = await import('/src/model/housekeeping.ts');
    e.command('Make Background', (d) => makeBackground(d.layers[0]));
  });
  await idle(page);
  await expect(page.locator('#layers .layer-row.background-layer')).toHaveCount(1);
  await addBox(page, 'Hidden', '#00ff00', { x: 0, y: 0, width: 10, height: 10 });
  await page.evaluate(() => window.photoStudio.command('Hide', (d) => (d.layers[1].visible = false)));
  await addBox(page, 'Shown', '#00ff00', { x: 0, y: 0, width: 10, height: 10 });
  // Isolate Layers narrows the panel to the selection until turned off.
  await run(page, 'select.isolate-layers');
  await expect(page.locator('#layers .layer-row')).toHaveCount(1);
  await page.locator('.layer-banner button').click();
  await expect(page.locator('#layers .layer-row')).toHaveCount(3);
  await run(page, 'layer.delete-hidden');
  expect(await layerNames(page)).toEqual(['Background', 'Shown']);
  // Double-clicking the Background converts it to a normal layer.
  await page.locator('#layers .layer-row.background-layer .layer-name').dblclick();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await idle(page);
  expect(await layerNames(page)).toEqual(['Layer 0', 'Shown']);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].background)).toBeUndefined();
  // Find Layers focuses the name search.
  await page.locator('#viewport').focus();
  await page.keyboard.press('ControlOrMeta+Alt+Shift+F');
  await expect(page.locator('.layer-filter-text')).toBeFocused();
});

test('a duplicate of the Background is an ordinary layer', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { makeBackground } = await import('/src/model/housekeeping.ts');
    e.command('Make Background', (d) => makeBackground(d.layers[0]));
    e.selected = e.doc.layers[0].id;
  });
  await idle(page);
  await run(page, 'layer.duplicate');
  const layers = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => ({ background: !!l.background, position: !!l.protection?.position, transparency: !!l.protection?.transparency })));
  expect(layers).toEqual([
    { background: true, position: true, transparency: true },
    { background: false, position: false, transparency: false },
  ]);
  await expect(page.locator('#layers .layer-row.background-layer')).toHaveCount(1);
});
