import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('a late generation list cannot disable actions on newer results', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { generationStore, recordGeneration } = await import('/src/features/generations/record.ts');
    const img = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
    await recordGeneration(window.photoStudio, { kind: 'generate', prompt: 'First' }, img);
    const store = generationStore();
    const original = store.list.bind(store);
    const state = { started: false, release: () => {} };
    (window as unknown as { generationGate: typeof state }).generationGate = state;
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    let first = true;
    store.list = async () => {
      const list = await original();
      if (first) { first = false; state.started = true; await gate; }
      return list;
    };
    window.photoStudio.dock.show('generations');
  });
  await page.waitForFunction(() => (window as unknown as { generationGate: { started: boolean } }).generationGate.started);
  await page.evaluate(async () => {
    const { recordGeneration } = await import('/src/features/generations/record.ts');
    await recordGeneration(window.photoStudio, { kind: 'generate', prompt: 'Second' }, { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) });
  });
  await expect(page.locator('.gen-row')).toHaveCount(2);
  await page.evaluate(() => (window as unknown as { generationGate: { release(): void } }).generationGate.release());
  await idle(page);
  await page.locator('.gen-row').filter({ hasText: 'Second' }).locator('[data-gen-act="delete"]').click();
  await idle(page);
  expect(await page.locator('.gen-row').count()).toBe(1);
  await expect(page.locator('.gen-row q')).toHaveText('First');
});
