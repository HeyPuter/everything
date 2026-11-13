import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('keyboard users can step through frames without losing the timeline control', async ({ page }) => {
  await boot(page);
  await openImage(page, 48, 32);
  await run(page, 'animation.create');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.first');
  const next = page.locator('.timeline-controls [data-command="animation.next"]');
  await next.focus();
  await page.keyboard.press('Enter');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.animation?.current)).toBe(1);
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.animation?.current)).toBe(2);
  await expect(next).toBeFocused();
});

test('loading frame thumbnails does not scroll away from the frames being browsed', async ({ page }) => {
  await boot(page);
  await openImage(page, 48, 32);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const original = e.renderer.documentPixels;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    (window as unknown as { releaseThumbs: () => void }).releaseThumbs = release;
    e.renderer.documentPixels = async (...args) => {
      await gate;
      return original.apply(e.renderer, args);
    };
    const { createAnimation, duplicateFrames, applyFrame } = await import('/src/model/animation.ts');
    e.command('Frames', (d) => {
      d.animation = createAnimation(d);
      for (let i = 0; i < 31; i++) duplicateFrames(d, [i]);
      applyFrame(d, 0);
    });
    e.dock.show('timeline');
  });
  const strip = page.locator('.timeline-frames');
  await expect(strip.locator('.frame-cell')).toHaveCount(32);
  const before = await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth; return el.scrollLeft; });
  expect(before).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { releaseThumbs: () => void }).releaseThumbs());
  await expect(strip.locator('.frame-thumb img')).toHaveCount(32);
  expect(await strip.evaluate((el) => el.scrollLeft)).toBeCloseTo(before, 0);
  // Explicit navigation must still bring the newly selected frame into view.
  await run(page, 'animation.last');
  await run(page, 'animation.first');
  await expect.poll(() => strip.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const first = el.querySelector('.frame-cell')!.getBoundingClientRect();
    return first.left >= bounds.left && first.right <= bounds.right;
  })).toBe(true);
});
