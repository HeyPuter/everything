import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { newLayerComp } from '../../src/model/layer-comps';
import { boot, idle, openProject, panel, run } from './helpers';

for (const method of ['button', 'command', 'default command']) {
  test(`apply a layer comp by ${method} without selecting a row first`, async ({ page }) => {
    await boot(page);
    const doc = newDocument(16, 16, 'Comps');
    const square = layer('solid', 'Square', 16, 16);
    doc.layers = [square];
    const comp = newLayerComp(doc, 'Visible', { visibility: true, position: true, appearance: true });
    doc.layerComps = [comp];
    square.visible = false;
    await openProject(page, doc);
    const body = await panel(page, 'Layer Comps');
    if (method === 'button') await body.getByRole('button', { name: 'Apply Visible', exact: true }).click();
    else await run(page, 'comps.apply', method === 'command' ? comp.id : undefined);
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.layers[0].visible)).toBe(true);
    await body.getByRole('button', { name: 'Apply Last Document State', exact: true }).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.layers[0].visible)).toBe(false);
    // Restoring the last state also clears both the selected and applied comp.
    await body.getByRole('button', { name: 'Apply Visible', exact: true }).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.layers[0].visible)).toBe(true);
  });
}
