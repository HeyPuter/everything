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

test('a locked layer can still be renamed in place', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200);
  await run(page, 'layer.new-quick');
  await page.locator('.layers-panel [data-lock-button="all"]').click();
  await idle(page);
  const id = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.id);
  await page.locator(`#layers .layer-row[data-row="${id}"] .layer-name`).dblclick();
  await page.locator('#layers input.layer-rename').fill('Locked title');
  await page.locator('#layers input.layer-rename').press('Enter');
  await idle(page);
  const l = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!);
  expect([l.name, l.locked]).toEqual(['Locked title', true]);
  // The Enter that commits the name does not also press the Lock button.
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Rename Layer');
  await expect(page.locator(`#layers .layer-select[data-layer="${id}"]`)).toBeFocused();
  await expect(page.locator(`#layers .layer-row[data-row="${id}"] .name-text`)).toHaveText(
    'Locked title',
  );
});

test('inside a locked group, the lock buttons of a layer are disabled', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200);
  await run(page, 'layer.new-quick');
  await run(page, 'layer.group');
  await page.locator('.layers-panel [data-lock-button="all"]').click();
  await idle(page);
  const child = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.children[0].id);
  await page.evaluate((id) => window.photoStudio.selectLayer(id), child);
  for (const key of ['transparency', 'composite', 'position', 'all'])
    await expect(page.locator(`.layers-panel [data-lock-button="${key}"]`)).toBeDisabled();
  // The group's own buttons stay available to unlock it.
  await page.evaluate(() =>
    window.photoStudio.selectLayer(window.photoStudio.doc.layers.at(-1)!.id),
  );
  await expect(page.locator('.layers-panel [data-lock-button="all"]')).toBeEnabled();
});

test('Lock Layers (Mod+/) unlocks a layer fully, also its individual locks', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200);
  await run(page, 'layer.new-quick');
  // Lock position on its own, then Lock All from the panel.
  await page.locator('.layers-panel [data-lock-button="position"]').click();
  await page.locator('.layers-panel [data-lock-button="all"]').click();
  await idle(page);
  await run(page, 'layer.lock-all');
  const state = await page.evaluate(async () => {
    const { ownLock } = await import('/src/model/locks.ts');
    const l = window.photoStudio.doc.layers.at(-1)!;
    return [l.locked, ownLock(l, 'position'), ownLock(l, 'pixels'), ownLock(l, 'transparency')];
  });
  expect(state).toEqual([false, false, false, false]);
  for (const key of ['transparency', 'composite', 'position', 'all'])
    await expect(page.locator(`.layers-panel [data-lock-button="${key}"]`)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  // Locking again locks everything.
  await run(page, 'layer.lock-all');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.locked)).toBe(true);
});
