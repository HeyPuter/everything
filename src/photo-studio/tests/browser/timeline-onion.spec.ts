// Onion skin settings on the frame and video timelines.
import { expect, test } from '@playwright/test';
import { boot, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Onion Skin Settings shows whether onion skins are on and keeps them off on OK', async ({ page }) => {
  await openImage(page, 60, 40, '#f0f0f0', 'onion.png');
  await run(page, 'animation.create');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.onion');
  await run(page, 'animation.onion');
  expect(await page.evaluate(() => window.photoStudio.doc.animation?.onion?.enabled)).toBe(false);
  await start(page, 'animation.onion-settings');
  const d = page.locator('dialog[open]', { hasText: 'Onion Skins' });
  await expect(d).toBeVisible();
  await expect(d.getByRole('checkbox', { name: 'Show onion skins' })).not.toBeChecked();
  await d.getByLabel('Frames before').fill('3');
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(d).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.doc.animation?.onion)).toMatchObject({ enabled: false, before: 3 });
  // Turned on, the box is checked.
  await run(page, 'animation.onion');
  await start(page, 'animation.onion-settings');
  await expect(d.getByRole('checkbox', { name: 'Show onion skins' })).toBeChecked();
  await d.getByRole('button', { name: 'Cancel' }).click();
});

test('the video timeline Onion Skin Settings shows whether onion skins are on', async ({ page }) => {
  await openImage(page, 60, 40, '#f0f0f0', 'onion.png');
  await run(page, 'timeline.create');
  await run(page, 'animation.onion');
  await run(page, 'animation.onion');
  expect(await page.evaluate(() => window.photoStudio.doc.timeline?.onion?.enabled)).toBe(false);
  await start(page, 'animation.onion-settings');
  const d = page.locator('dialog[open]', { hasText: 'Onion Skins' });
  await expect(d).toBeVisible();
  await expect(d.getByRole('checkbox', { name: 'Show onion skins' })).not.toBeChecked();
  await d.getByRole('button', { name: 'OK' }).click();
  await expect(d).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.doc.timeline?.onion?.enabled)).toBe(false);
});

test('keeps large onion images separate from small frame thumbnails', async ({ page }) => {
  await openImage(page, 256, 128, '#b03060', 'onion-size.png');
  await run(page, 'animation.create');
  await run(page, 'animation.new-frame');
  await run(page, 'animation.onion');
  const onion = page.locator('.onion-skin');
  await expect(onion).toHaveCount(1);
  const thumb = page.locator('.frame-thumb img').first();
  await expect(thumb).toBeVisible();
  const dimensions = await page.evaluate(async () => {
    const size = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    };
    return {
      thumb: await size(document.querySelector<HTMLImageElement>('.frame-thumb img')!.src),
      onion: await size(document.querySelector('.onion-skin')!.getAttribute('href')!),
    };
  });
  expect(dimensions).toEqual({ thumb: [112, 56], onion: [256, 128] });
  const url = await thumb.getAttribute('src');
  await run(page, 'animation.first');
  await expect(onion).toHaveCount(1);
  await expect(thumb).toHaveAttribute('src', url!);
});
