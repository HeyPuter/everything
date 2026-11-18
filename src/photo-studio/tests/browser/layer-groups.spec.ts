// Grouping and ungrouping layers.
import { test, expect } from '@playwright/test';
import { boot, openImage, run } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
});

test('a group made with New Group (Pass Through) ungroups', async ({ page }) => {
  await run(page, 'layer.new-quick');
  await run(page, 'layer.new-quick');
  const ids = await page.evaluate(() => window.photoStudio.doc.layers.slice(1).map((l) => l.id));
  await run(page, 'layer.new-group-quick');
  const group = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!);
  expect(group.blend).toBe('pass through');
  // Move both layers into the group, as a drop on its row does.
  await page.evaluate(
    async ({ ids, id }) => {
      const e = window.photoStudio;
      const { moveLayers } = await import('/src/model/layers.ts');
      e.command('Move layers', (d) => moveLayers(d, new Set(ids), id, 'inside'));
      e.selectLayers([id]);
    },
    { ids, id: group.id },
  );
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(2);
  await run(page, 'layer.ungroup');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.kind))).toEqual([
    'pixel',
    'pixel',
    'pixel',
  ]);
  expect(await page.evaluate(() => [...window.photoStudio.selectedIds])).toEqual(ids);
});
