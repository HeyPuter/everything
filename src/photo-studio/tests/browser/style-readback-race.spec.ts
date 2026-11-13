import { expect, test } from '@playwright/test';
import { boot, canvasClick, idle, openImage, tool } from './helpers';

test('a queued readback can finish before a deferred text-effect capture', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 140, '#ffffff');
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 30, 70);
  await page.keyboard.type('Shadow');
  await page.keyboard.press('Escape');
  await idle(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
    const r = e.renderer as unknown as { draw: (...args: unknown[]) => Promise<void> };
    const draw = r.draw;
    const gate = new Promise<void>((resolve) => Object.assign(window, { releaseStylePreview: resolve }));
    r.draw = async function (...args) {
      r.draw = draw;
      Object.assign(window, { stylePreviewWaiting: true });
      await gate;
      return draw.apply(this, args);
    };
    e.command('Text shadow', (d) => { d.layers.at(-1)!.style = { dropShadow: [defaultDropShadow()] }; });
  });
  await page.waitForFunction(() => !!(window as unknown as { stylePreviewWaiting?: boolean }).stylePreviewWaiting);
  await page.evaluate(() => {
    const e = window.photoStudio;
    // Queue the readback before the preview gets far enough to schedule its capture.
    void e.renderer.documentPixels(e.doc, e.assets).then((pixels) => Object.assign(window, { styleReadback: Array.from(pixels) }));
    (window as unknown as { releaseStylePreview(): void }).releaseStylePreview();
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { styleReadback?: number[] }).styleReadback), { timeout: 6000 }).toBe(true);
  await idle(page);
  expect(await page.evaluate(async () => {
    const e = window.photoStudio;
    const fresh = await e.renderer.documentPixels({ ...e.doc, layers: e.doc.layers.map((l) => ({ ...l, id: crypto.randomUUID() })) }, e.assets);
    const readback = (window as unknown as { styleReadback: number[] }).styleReadback;
    return fresh.every((n, i) => n === readback[i]);
  })).toBe(true);
});
