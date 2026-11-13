import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { newLayerComp } from '../../src/model/layer-comps';
import { boot, idle, openProject, panel } from './helpers';

test('the layer comp list keeps its browsing position through edits and applying a comp', async ({ page }) => {
  await boot(page);
  const doc = newDocument(16, 16, 'Comps');
  doc.layers = [layer('solid', 'Square', 16, 16)];
  doc.layerComps = Array.from({ length: 40 }, (_, i) => newLayerComp(doc, `Comp ${i + 1}`, { visibility: true, position: true, appearance: true }));
  await openProject(page, doc);
  const body = await panel(page, 'Layer Comps');
  await idle(page);
  // Resolve the current list inside the same browser task as the read/write;
  // a panel update can replace a locator's element before evaluate runs.
  const position = await page.evaluate(() => {
    const el = document.querySelector('.comps-list')!;
    el.scrollTop = 500;
    return el.scrollTop;
  });
  const scrollTop = () => page.evaluate(() => document.querySelector('.comps-list')!.scrollTop);
  expect(position).toBe(500);
  await page.evaluate(() => window.photoStudio.command('Opacity', (d) => { d.layers[0].opacity = 0.5; }));
  await idle(page);
  expect(await scrollTop()).toBe(position);
  await body.getByRole('button', { name: 'Apply Comp 30', exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(1);
  expect(await scrollTop()).toBe(position);
});
