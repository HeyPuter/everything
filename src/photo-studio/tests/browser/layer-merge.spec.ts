import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

// Merge Visible and Merge Down: what survives the merge and how the result looks.

type Spec = { name: string; color?: [number, number, number, number]; rect?: [number, number, number, number]; hidden?: boolean; blend?: string; opacity?: number; children?: Spec[] };

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
