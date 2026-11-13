import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('a recent tile opens the displayed file while a newer list is loading', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { noteRecent } = await import('/src/features/files/recent.ts');
    noteRecent(window.photoStudio, 'First.png', { kind: 'puter', path: '/First.png' });
  });
  await expect(page.locator('.start-recent-name')).toHaveText(['First.png']);
  await page.evaluate(async () => {
    const { localStore } = await import('/src/persistence/local-store.ts');
    const { noteRecent, setRecentOpener } = await import('/src/features/files/recent.ts');
    const state = { opened: '', release: () => {} };
    (window as unknown as { recentClick: typeof state }).recentClick = state;
    setRecentOpener(async (_e, entry) => { state.opened = entry.name; });
    const store = localStore();
    const original = store.get.bind(store);
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    store.get = async function (name, key) {
      if (name === 'thumbs') await gate;
      return original(name, key);
    };
    noteRecent(window.photoStudio, 'Second.png', { kind: 'puter', path: '/Second.png' });
  });
  await page.locator('.start-recent-item').filter({ hasText: 'First.png' }).click();
  await idle(page);
  const opened = await page.evaluate(() => {
    const state = (window as unknown as { recentClick: { opened: string; release(): void } }).recentClick;
    state.release();
    return state.opened;
  });
  expect(opened).toBe('First.png');
  await expect(page.locator('.start-recent-name')).toHaveText(['Second.png', 'First.png']);
  await page.locator('.start-recent-item').filter({ hasText: 'Second.png' }).click();
  await idle(page);
  expect(await page.evaluate(() => (window as unknown as { recentClick: { opened: string } }).recentClick.opened)).toBe('Second.png');
});
