// Grouping and ungrouping layers.
import { test, expect } from '@playwright/test';
import { boot, compositePixel, idle, openImage, run } from './helpers';

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

test('Group Layers keeps how a blend-mode layer mixes with the layers below', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const l = layer('solid', 'Red', 300, 200);
    l.color = '#ff0000';
    l.blend = 'multiply';
    e.command('Add layer', (d) => d.layers.push(l));
    e.selectLayers([l.id]);
  });
  await idle(page);
  expect(await compositePixel(page, 10, 10)).toEqual([128, 0, 0, 255]);
  await run(page, 'layer.group');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.blend)).toBe(
    'pass through',
  );
  expect(await compositePixel(page, 10, 10)).toEqual([128, 0, 0, 255]);
});

test('Alt-clicking an eye shows only that group or nested layer, and again shows all', async ({
  page,
}) => {
  for (let i = 0; i < 3; i++) await run(page, 'layer.new-quick');
  // Background, Layer 1, Group { Layer 2, Layer 3 }
  const [, , a, b] = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.id));
  await page.evaluate((ids) => window.photoStudio.selectLayers(ids), [a, b]);
  await run(page, 'layer.group');
  const visibility = () =>
    page.evaluate(() =>
      window.photoStudio.doc.layers.map((l) => [l.visible, ...l.children.map((c) => c.visible)]),
    );
  const group = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.id);
  const eye = (id: string) => page.locator(`#layers [data-visibility="${id}"]`);
  // The group shows with its layers; everything else hides.
  await eye(group).click({ modifiers: ['Alt'] });
  await idle(page);
  expect(await visibility()).toEqual([[false], [false], [true, true, true]]);
  await eye(group).click({ modifiers: ['Alt'] });
  await idle(page);
  expect(await visibility()).toEqual([[true], [true], [true, true, true]]);
  // A layer inside the group shows with its group; a second Alt-click shows all.
  await eye(b).click({ modifiers: ['Alt'] });
  await idle(page);
  expect(await visibility()).toEqual([[false], [false], [true, false, true]]);
  await eye(b).click({ modifiers: ['Alt'] });
  await idle(page);
  expect(await visibility()).toEqual([[true], [true], [true, true, true]]);
});

test('ungrouping keeps the picture: a clipped group clips its layers, a masked group refuses', async ({
  page,
}) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const base = layer('solid', 'Base', 40, 40);
    base.color = '#ff0000';
    base.transform = { x: 10, y: 10, width: 40, height: 40, rotation: 0 };
    const blue = layer('solid', 'Blue', 300, 200);
    blue.color = '#0000ff';
    const green = layer('solid', 'Green', 20, 20);
    green.color = '#00ff00';
    green.transform = { x: 30, y: 30, width: 20, height: 20, rotation: 0 };
    const g = layer('group', 'Group', 300, 200);
    g.blend = 'pass through';
    g.clipped = true;
    g.children = [blue, green];
    e.command('Add layers', (d) => d.layers.push(base, g));
    e.selectLayers([g.id]);
  });
  await idle(page);
  const pixels = async () => [
    await compositePixel(page, 5, 5),
    await compositePixel(page, 15, 15),
    await compositePixel(page, 40, 40),
  ];
  const before = await pixels();
  expect(before).toEqual([
    [128, 128, 128, 255],
    [0, 0, 255, 255],
    [0, 255, 0, 255],
  ]);
  await run(page, 'layer.ungroup');
  expect(
    await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.name, !!l.clipped])),
  ).toEqual([
    ['Background', false],
    ['Base', false],
    ['Blue', true],
    ['Green', true],
  ]);
  expect(await pixels()).toEqual(before);
  // A group's layer mask would be lost: Ungroup refuses and changes nothing.
  await page.evaluate(() =>
    window.photoStudio.selectLayers(window.photoStudio.doc.layers.slice(1).map((l) => l.id)),
  );
  await run(page, 'layer.group');
  await run(page, 'layer.mask-hide-all');
  const masked = await pixels();
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  await run(page, 'layer.ungroup');
  await expect(page.locator('#status')).toContainText('before ungrouping');
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps);
  expect(await pixels()).toEqual(masked);
});
