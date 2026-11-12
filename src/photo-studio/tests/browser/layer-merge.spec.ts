import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

// Merge Visible and Merge Down: what survives the merge and how the result looks.

type Spec = { name: string; color?: [number, number, number, number]; rect?: [number, number, number, number]; hidden?: boolean; blend?: string; opacity?: number; clipped?: boolean; children?: Spec[] };

/** Replaces the document's layers (bottom first). */
async function setLayers(page: Page, specs: Spec[]) {
  await page.evaluate(async (specs) => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    const w = e.doc.width, h = e.doc.height;
    const make = (s: Spec): ReturnType<typeof layer> => {
      if (s.children) {
        const g = layer('group', s.name, w, h);
        g.children = s.children.map(make);
        if (s.hidden) g.visible = false;
        return g;
      }
      const l = layer('pixel', s.name, w, h);
      const [x0, y0, rw, rh] = s.rect ?? [0, 0, w, h];
      const data = new Uint8ClampedArray(rw * rh * 4);
      for (let i = 0; i < rw * rh; i++) data.set(s.color!, i * 4);
      setLayerPixels(l, gridFromImage(e.assets.tiles, { width: rw, height: rh, data }, x0, y0), e.doc);
      if (s.hidden) l.visible = false;
      if (s.blend) l.blend = s.blend as never;
      if (s.opacity !== undefined) l.opacity = s.opacity;
      if (s.clipped) l.clipped = true;
      return l;
    };
    const layers = specs.map(make);
    e.command('Test Layers', (d) => {
      d.layers = layers;
    });
  }, specs);
  await idle(page);
}
const pixels = (page: Page) => page.evaluate(async () => Array.from(await window.photoStudio.renderer.documentPixels(window.photoStudio.doc, window.photoStudio.assets)));
const tree = (page: Page) =>
  page.evaluate(() => {
    type L = { name: string; visible: boolean; children: L[] };
    const walk = (ls: L[]): string[] => ls.flatMap((l) => [`${l.name}${l.visible ? '' : ' (hidden)'}`, ...walk(l.children).map((n) => `  ${n}`)]);
    return walk(window.photoStudio.doc.layers as unknown as L[]);
  });
const select = (page: Page, name: string) =>
  page.evaluate((name) => {
    const e = window.photoStudio;
    const find = (ls: typeof e.doc.layers): (typeof e.doc.layers)[number] | undefined => {
      for (const l of ls) {
        if (l.name === name) return l;
        const f = find(l.children);
        if (f) return f;
      }
    };
    e.selected = find(e.doc.layers)!.id;
    e.update();
  }, name);

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 8, 8, '#808080', 'merge.png');
});

test('Merge Visible keeps hidden layers, including those inside visible groups, in stacking order', async ({ page }) => {
  await setLayers(page, [
    { name: 'Low', color: [0, 0, 255, 255], hidden: true },
    { name: 'A', color: [255, 0, 0, 255] },
    { name: 'G', children: [{ name: 'Inner', color: [0, 255, 0, 255], hidden: true }, { name: 'B', color: [0, 0, 255, 255], rect: [0, 0, 4, 8] }] },
    { name: 'Top', color: [255, 255, 0, 255], hidden: true },
  ]);
  const before = await pixels(page);
  await select(page, 'A');
  await run(page, 'layer.merge-visible');
  expect(await tree(page)).toEqual(['Low (hidden)', 'Inner (hidden)', 'Merged', 'Top (hidden)']);
  expect(await pixels(page)).toEqual(before);
});

test('Merge Down keeps the blend mode of the lower layer and looks the same', async ({ page }) => {
  await setLayers(page, [
    { name: 'Back', color: [200, 100, 50, 255] },
    { name: 'Lower', color: [128, 255, 64, 255], blend: 'multiply', opacity: 0.5 },
    { name: 'Upper', color: [100, 200, 255, 255], rect: [0, 0, 4, 8], blend: 'multiply' },
  ]);
  const before = await pixels(page);
  await select(page, 'Upper');
  await run(page, 'layer.merge-down');
  expect(await tree(page)).toEqual(['Back', 'Lower']);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[1].blend)).toBe('multiply');
  const after = await pixels(page);
  for (let i = 0; i < before.length; i++) expect(Math.abs(after[i] - before[i]), `byte ${i}`).toBeLessThanOrEqual(2);
});

test('Merge Down onto a translucent Normal layer looks the same', async ({ page }) => {
  await setLayers(page, [
    { name: 'Back', color: [200, 100, 50, 255] },
    { name: 'Lower', color: [0, 0, 255, 255], opacity: 0.5 },
    { name: 'Upper', color: [0, 255, 0, 255], rect: [0, 0, 4, 8], opacity: 0.6 },
  ]);
  const before = await pixels(page);
  await select(page, 'Upper');
  await run(page, 'layer.merge-down');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[1].blend)).toBe('normal');
  const after = await pixels(page);
  for (let i = 0; i < before.length; i++) expect(Math.abs(after[i] - before[i]), `byte ${i}`).toBeLessThanOrEqual(2);
});

test('Merge Down of a clipped layer onto another clipped layer keeps its pixels', async ({ page }) => {
  // Both upper layers are clipped to Base; Upper reaches beyond Lower.
  await setLayers(page, [
    { name: 'Base', color: [0, 255, 0, 255] },
    { name: 'Lower', color: [255, 0, 0, 255], rect: [0, 0, 2, 8], clipped: true },
    { name: 'Upper', color: [0, 0, 255, 255], rect: [0, 0, 6, 8], clipped: true },
  ]);
  const before = await pixels(page);
  await select(page, 'Upper');
  await run(page, 'layer.merge-down');
  expect(await tree(page)).toEqual(['Base', 'Lower']);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[1].clipped)).toBe(true);
  expect(await pixels(page)).toEqual(before);
});

test('Merge Down on the base of a clipping group merges the group and looks the same', async ({ page }) => {
  await setLayers(page, [
    { name: 'Back', color: [255, 0, 0, 255] },
    { name: 'Base', color: [0, 255, 0, 255], rect: [2, 2, 4, 4], blend: 'multiply', opacity: 0.8 },
    { name: 'Clipped', color: [0, 0, 255, 255], clipped: true },
    { name: 'Hidden', color: [255, 255, 0, 255], clipped: true, hidden: true },
    { name: 'Top', color: [255, 255, 255, 255], rect: [0, 0, 1, 1] },
  ]);
  const before = await pixels(page);
  await select(page, 'Base');
  await run(page, 'layer.merge-down');
  expect(await tree(page)).toEqual(['Back', 'Base', 'Hidden (hidden)', 'Top']);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Merge Clipping Mask');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => !!l.clipped))).toEqual([false, false, true, false]);
  const after = await pixels(page);
  for (let i = 0; i < before.length; i++) expect(Math.abs(after[i] - before[i]), `byte ${i}`).toBeLessThanOrEqual(2);
  // The hidden clipped layer still shows only inside the merged base.
  await page.evaluate(() => window.photoStudio.command('Show', (d) => (d.layers[2].visible = true)));
  await idle(page);
  const shown = await pixels(page);
  expect(shown.slice(0, 4)).toEqual([255, 255, 255, 255]);
  expect(shown.slice(4, 8)).toEqual([255, 0, 0, 255]);
});
