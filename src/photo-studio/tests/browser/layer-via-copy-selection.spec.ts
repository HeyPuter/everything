import { test, expect } from '@playwright/test';
import { boot, historyLabels, layerNames, openImage, run, selectRect, undo } from './helpers';

// Layer via Copy and Layer via Cut drop the selection they used, in the same
// undo step; Reselect brings it back.

const hasSelection = (page: import('@playwright/test').Page) =>
  page.evaluate(() => !!(window.photoStudio.doc.selection || window.photoStudio.doc.selectionMask));

for (const [id, label] of [
  ['layer.via-copy', 'Layer via Copy'],
  ['layer.via-cut', 'Layer via Cut'],
] as const) {
  test(`${label} deselects in one step, and Reselect restores the selection`, async ({ page }) => {
    await boot(page);
    await openImage(page, 200, 150, '#808080');
    await selectRect(page, { x: 20, y: 20, width: 60, height: 40 });
    expect(await hasSelection(page)).toBe(true);
    const before = (await layerNames(page)).length;
    await run(page, id);
    expect((await layerNames(page)).length).toBe(before + 1);
    expect(await hasSelection(page)).toBe(false);
    expect((await historyLabels(page)).at(-1)).toBe(label);
    await undo(page);
    expect((await layerNames(page)).length).toBe(before);
    expect(await hasSelection(page)).toBe(true);
    await run(page, id);
    await run(page, 'select.reselect');
    expect(await hasSelection(page)).toBe(true);
  });
}
