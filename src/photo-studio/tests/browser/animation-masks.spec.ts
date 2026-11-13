import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

for (const backend of ['default', 'WebGL'] as const) {
  test(`rendered animation frames keep linked masks with moving layers (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openImage(page, 64, 48, '#ffffff');
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const { filledMask } = await import('/src/model/tiles.ts');
      e.command('Masked card', (d) => {
        const card = layer('solid', 'Card', 20, 20);
        card.color = '#ff0000';
        card.transform.x = 4;
        card.transform.y = 4;
        card.maskGrid = filledMask(e.assets.tiles, { x: 4, y: 4, width: 10, height: 20 });
        d.layers.push(card);
      });
    });
    await run(page, 'animation.create');
    await run(page, 'animation.new-frame');
    await page.evaluate(() => window.photoStudio.command('Move card', (d) => { d.layers[1].transform.x += 24; }));
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { frameDocument } = await import('/src/model/animation.ts');
      const { compositeFrame } = await import('/src/features/animation/render.ts');
      const exported = await compositeFrame(e, frameDocument(e.doc, 0));
      await e.runCommand('animation.first');
      const selected = await compositeFrame(e, e.doc);
      const at = (img: ImageData, x: number) => Array.from(img.data.slice((8 * img.width + x) * 4, (8 * img.width + x) * 4 + 4));
      return { exported: at(exported, 8), selected: at(selected, 8), outside: at(exported, 18), equal: exported.data.every((v, i) => v === selected.data[i]) };
    });
    expect(result.selected).toEqual([255, 0, 0, 255]);
    expect(result.exported).toEqual(result.selected);
    expect(result.outside).toEqual([255, 255, 255, 255]);
    expect(result.equal).toBe(true);
  });
}
