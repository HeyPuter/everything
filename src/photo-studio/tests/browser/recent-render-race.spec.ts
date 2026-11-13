import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('late thumbnails cannot replace newer recent-file tiles', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { localStore } = await import('/src/persistence/local-store.ts');
    const { noteRecent } = await import('/src/features/files/recent.ts');
    const store = localStore();
    const original = store.get.bind(store);
    let first = true;
    const state = { release: () => {} };
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    (window as unknown as { recentGate: typeof state }).recentGate = state;
    store.get = async function (name, key) {
      if (name === 'thumbs' && first) { first = false; await gate; }
      return original(name, key);
    };
    noteRecent(window.photoStudio, 'First.png', { kind: 'puter', path: '/First.png' });
    noteRecent(window.photoStudio, 'Second.png', { kind: 'puter', path: '/Second.png' });
  });
  const tiles = page.locator('.start-recent-name');
  await expect(tiles).toHaveText(['Second.png', 'First.png']);
  await page.evaluate(() => (window as unknown as { recentGate: { release(): void } }).recentGate.release());
  await idle(page);
  await expect(tiles).toHaveText(['Second.png', 'First.png']);
});
