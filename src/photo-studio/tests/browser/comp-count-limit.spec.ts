import { expect, test } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { newLayerComp } from '../../src/model/layer-comps';
import { boot, idle, openProject, run, settleCommand, start } from './helpers';

for (const command of ['comps.new', 'comps.duplicate']) {
  test(`${command} respects the project comp limit and still works after deletion`, async ({ page }) => {
    await boot(page);
    const doc = newDocument(16, 16, 'Many comps');
    doc.layers = [layer('solid', 'Square', 16, 16)];
    doc.layerComps = Array.from({ length: 499 }, (_, i) => newLayerComp(doc, `Comp ${i + 1}`, { visibility: true, position: false, appearance: false }));
    doc.lastComp = doc.layerComps[0].id;
    await openProject(page, doc);
    const add = async () => {
      if (command === 'comps.duplicate') return run(page, command);
      await start(page, command);
      await settleCommand(page);
      const dialog = page.locator('dialog.comp-dialog[open]');
      if (await dialog.count()) {
        await dialog.locator('[name=name]').fill('Added comp');
        await dialog.getByRole('button', { name: 'OK', exact: true }).click();
      }
      await idle(page);
    };
    const count = () => page.evaluate(() => window.photoStudio.doc.layerComps!.length);
    await add();
    expect(await count()).toBe(500);
    const before = await page.evaluate(() => window.photoStudio.history.labels);
    await add();
    const roundTrip = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { serialize, deserialize } = await import('/src/model/serialization.ts');
      try {
        const loaded = await deserialize(await serialize(e.doc, e.assets));
        return { count: loaded.document.layerComps!.length, error: '' };
      } catch (error) {
        return { count: e.doc.layerComps!.length, error: (error as Error).message };
      }
    });
    expect(roundTrip).toEqual({ count: 500, error: '' });
    expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(before);
    await expect(page.locator('#status')).toContainText('500 layer comps');
    await run(page, 'comps.delete');
    expect(await count()).toBe(499);
    await add();
    expect(await count()).toBe(500);
  });
}
