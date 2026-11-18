// Lock All keeps a layer's opacity and blend mode, whatever control changes them.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('Lock All protects opacity and blend mode from the keyboard and the panel', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 300, 200);
  await run(page, 'layer.new-quick');
  await page.locator('.layers-panel [data-lock-button="all"]').click();
  await idle(page);
  const state = () =>
    page.evaluate(() => {
      const l = window.photoStudio.doc.layers.at(-1)!;
      return { locked: l.locked, opacity: l.opacity, blend: l.blend };
    });
  expect(await state()).toEqual({ locked: true, opacity: 1, blend: 'normal' });
  const steps = await page.evaluate(() => window.photoStudio.history.labels.length);
  // Number keys and Shift+plus set opacity and blend mode of unlocked layers only.
  await run(page, 'layer.set-opacity', 0.5);
  await run(page, 'layer.blend-next');
  expect(await state()).toEqual({ locked: true, opacity: 1, blend: 'normal' });
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(steps);
  await expect(page.locator('#status')).toHaveText('Unlock this layer to edit it.');
  // The panel's Opacity and Fill fields are disabled, like the blend menu.
  await expect(page.locator('.layers-panel #blend')).toBeDisabled();
  await expect(page.locator('.layers-panel #opacity')).toBeDisabled();
  await expect(page.locator('.layers-panel #fill-opacity')).toBeDisabled();
  // Unlocked again, the keys work.
  await page.locator('.layers-panel [data-lock-button="all"]').click();
  await idle(page);
  await run(page, 'layer.set-opacity', 0.5);
  await run(page, 'layer.blend-next');
  expect(await state()).toEqual({ locked: false, opacity: 0.5, blend: 'dissolve' });
  await expect(page.locator('.layers-panel #opacity')).toBeEnabled();
});
