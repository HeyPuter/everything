import { expect, test } from '@playwright/test';
import { boot, idle, run } from './helpers';

for (const hidden of [false, true]) {
test(`deleted library thumbnails release their URLs with the panel ${hidden ? 'hidden' : 'visible'}`, async ({ page }) => {
  await boot(page);
  await run(page, 'window.panel.libraries');
  await page.evaluate(async () => {
    const { libraries } = await import('/src/features/libraries/service.ts');
    const lib = libraries();
    await lib.load();
    const target = await lib.createLibrary('Pictures');
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
    const blob = await canvas.convertToBlob();
    for (const name of ['First', 'Second']) {
      await lib.addItem(target.id, { type: 'pattern', name, data: { width: 8, height: 8 } }, { content: blob });
    }
  });
  const images = page.locator('.lib-item img');
  await expect(images).toHaveCount(2);
  await expect.poll(() => images.evaluateAll((xs) => xs.every((x) => (x as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const urls = await images.evaluateAll((xs) => xs.map((x) => (x as HTMLImageElement).src));
  expect(urls[0]).toBe(urls[1]);
  await page.evaluate(async () => {
    const revoked: string[] = [];
    (window as unknown as { libraryRevoked: string[] }).libraryRevoked = revoked;
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (url) => { revoked.push(url); original.call(URL, url); };
    const { libraries } = await import('/src/features/libraries/service.ts');
    const lib = libraries();
    await lib.deleteItem(lib.index.libraries[0].items[0].id);
  });
  await expect(images).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { libraryRevoked: string[] }).libraryRevoked)).not.toContain(urls[0]);
  await expect(images).toHaveAttribute('src', urls[0]);
  if (hidden) await run(page, 'window.panel.libraries');
  await page.evaluate(async () => {
    const { libraries } = await import('/src/features/libraries/service.ts');
    const lib = libraries();
    await lib.deleteLibrary(lib.index.libraries[0].id);
  });
  await expect(images).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => (window as unknown as { libraryRevoked: string[] }).libraryRevoked)).toContain(urls[0]);
});
}
