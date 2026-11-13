import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

for (const resize of [false, true]) test(`a delayed transform uses the latest ${resize ? 'resized' : 'edited'} embedded contents`, async ({ page }) => {
  await boot(page);
  const results = [];
  for (const delayed of [false, true]) {
    const name = delayed ? 'delayed' : 'ordered';
    await openImage(page, 64, 48, '#ffffff', `${name}.png`);
    const parent = await page.evaluate(async (name) => {
      const e = window.photoStudio;
      const { openFile } = await import('/src/features/files/open.ts');
      const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
      g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
      await openFile(e, await c.convertToBlob({ type: 'image/png' }), `${name}-contents.png`, true);
      return e.session.id;
    }, name);
    await run(page, 'layer.embed-edit');
    const child = await page.evaluate(() => window.photoStudio.session.id);
    await page.evaluate(async ({ parent, delayed }) => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions.find((s) => s.id === parent)!);
      const { startSession } = await import('/src/features/transform/session.ts');
      const transform = startSession(e, { mode: 'distort', quad: [{ x: 20, y: 15 }, { x: 42, y: 15 }, { x: 36, y: 27 }, { x: 20, y: 27 }] })!;
      await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
      if (delayed) {
        const assets = e.assets, add = assets.add.bind(assets);
        assets.add = async (...args) => {
          assets.add = add;
          await new Promise<void>((resolve) => Object.assign(window, { finishFrameAsset: resolve }));
          return add(...args);
        };
        Object.assign(window, { frameCommitted: Promise.resolve(transform.apply()) });
      } else await transform.apply();
    }, { parent, delayed });
    if (delayed) await page.waitForFunction(() => !!(window as unknown as { finishFrameAsset?: () => void }).finishFrameAsset);
    await page.evaluate(async (child) => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions.find((s) => s.id === child)!);
      e.setForeground('#00ff00');
    }, child);
    await run(page, 'edit.fill-foreground');
    if (resize) await page.evaluate(async () => {
      const { resampleDocument } = await import('/src/features/transform/image-size.ts');
      resampleDocument(window.photoStudio, 32, 24, 'nearest');
    });
    await run(page, 'file.save');
    results.push(await page.evaluate(async ({ parent, delayed }) => {
      const e = window.photoStudio;
      if (delayed) {
        const w = window as unknown as { finishFrameAsset(): void; frameCommitted: Promise<void> };
        w.finishFrameAsset(); await w.frameCommitted;
      }
      await e.switchSession(e.sessions.find((s) => s.id === parent)!);
      const { framesReady } = await import('/src/features/embedded/frame.ts');
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      await framesReady(e);
      const image = await compositeRGBA(e);
      const i = (20 * image.width + 28) * 4;
      return { quad: e.doc.layers.at(-1)!.embed!.frame!.quad, pixel: [...image.data.slice(i, i + 4)] };
    }, { parent, delayed }));
  }
  expect(results[0].pixel).toEqual([0, 255, 0, 255]);
  expect(results[1]).toEqual(results[0]);
});
