import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('Generation History reports a read failure and can retry without losing saved results', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { generationStore, recordGeneration } = await import('/src/features/generations/record.ts');
    await recordGeneration(window.photoStudio, { kind: 'generate', prompt: 'Saved result' }, { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) });
    const store = generationStore();
    const original = store.list.bind(store);
    let first = true;
    store.list = async () => {
      if (first) { first = false; throw new Error('Temporary storage read failure'); }
      return original();
    };
    window.photoStudio.dock.show('generations');
  });
  await expect(page.locator('.generations-panel')).toBeVisible();
  await idle(page);
  const panel = page.locator('.generations-panel');
  expect(await panel.innerText()).toContain('Could not load Generation History');
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.locator('.gen-row q')).toHaveText('Saved result');
  await expect(panel.getByRole('searchbox', { name: 'Search prompts' })).toBeFocused();
  expect(await page.evaluate(async () => {
    const { generationStore } = await import('/src/features/generations/record.ts');
    const store = generationStore();
    const entries = await store.list();
    return entries.length === 1 && !!(await store.image(entries[0].id));
  })).toBe(true);
});
