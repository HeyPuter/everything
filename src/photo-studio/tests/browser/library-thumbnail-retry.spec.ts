import { expect, test } from '@playwright/test';
import { boot, idle, run } from './helpers';

for (const failure of ['missing', 'error']) {
  test(`library thumbnails retry after a temporary ${failure} asset`, async ({ page }) => {
    await boot(page);
    await run(page, 'window.panel.libraries');
    await page.evaluate(async (failure) => {
      const { libraries } = await import('/src/features/libraries/service.ts');
      const lib = libraries();
      await lib.load();
      const target = await lib.createLibrary('Pictures');
      const original = lib.readAsset.bind(lib);
      const state = { available: false, attempts: 0 };
      (window as unknown as { libraryAsset: typeof state }).libraryAsset = state;
      lib.readAsset = async (hash) => {
        state.attempts++;
        if (state.available) return original(hash);
        if (failure === 'error') throw new Error('Temporary storage failure');
        return undefined;
      };
      const canvas = new OffscreenCanvas(8, 8);
      canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
      await lib.addItem(target.id, { type: 'pattern', name: 'Dots', data: { width: 8, height: 8 } }, { content: await canvas.convertToBlob() });
    }, failure);
    await expect(page.locator('.lib-item')).toHaveCount(1);
    await page.waitForFunction(() => (window as unknown as { libraryAsset: { attempts: number } }).libraryAsset.attempts > 0);
    await idle(page);
    await page.evaluate(async () => {
      (window as unknown as { libraryAsset: { available: boolean } }).libraryAsset.available = true;
      const { libraries } = await import('/src/features/libraries/service.ts');
      await libraries().sync();
    });
    await idle(page);
    const loaded = await page.locator('.lib-item img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
    expect(loaded).toBe(true);
  });
}
