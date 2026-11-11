// Browser storage behind versions and crash recovery.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('a write that does not fit in browser storage fails instead of reporting success', async ({ page }) => {
  await boot(page);
  const origin = new URL(page.url()).origin;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 200_000 });
  try {
    const result = await page.evaluate(async () => {
      const { IndexedDbStore } = await import('/src/persistence/local-store.ts');
      const store = new IndexedDbStore('photo-studio-quota-test', ['recovery']);
      const big = new Blob([new Uint8Array(4_000_000).map((_, i) => i * 7)]);
      let put = 'stored';
      await store.put('recovery', 'big', { project: big }).catch((error: Error) => (put = error.name));
      const kept = (await store.get('recovery', 'big')) !== undefined;
      return { put, kept };
    });
    expect(result).toEqual({ put: 'QuotaExceededError', kept: false });
    // With space again, writes and deletions are stored as before.
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
    const after = await page.evaluate(async () => {
      const { IndexedDbStore } = await import('/src/persistence/local-store.ts');
      const store = new IndexedDbStore('photo-studio-quota-test', ['recovery']);
      await store.put('recovery', 'small', { project: 'ok' });
      const small = await store.get<{ project: string }>('recovery', 'small');
      await store.delete('recovery', 'small');
      return { small: small?.project, deleted: (await store.get('recovery', 'small')) === undefined };
    });
    expect(after).toEqual({ small: 'ok', deleted: true });
  } finally {
    await cdp.send('Storage.overrideQuotaForOrigin', { origin });
  }
});

test('a damaged recovery record does not stop the others from being restored', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#aa3355', 'kept.png');
  await run(page, 'adjust.invert');
  await run(page, 'file.autosave-now');
  // A record whose project cannot be read, newer than the good one (restored first).
  await page.evaluate(async () => {
    const { localStore } = await import('/src/persistence/local-store.ts');
    await localStore().put('recovery', 'damaged', { sessionId: 'damaged', instance: 'gone', docId: 'x', name: 'Damaged', time: Date.now() + 1000, project: new Blob(['not a project']) });
  });
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.recovery-item')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#document-name')).toHaveText('kept');
  await expect(page.locator('#toast')).toContainText('“Damaged” could not be restored; restored 1 other document');
  await idle(page);
  // Only the damaged record is offered again.
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer);
  await expect(dialog.locator('.recovery-item')).toHaveCount(1);
  await expect(dialog.locator('.recovery-item')).toContainText('Damaged');
  await dialog.getByRole('button', { name: 'Discard All' }).click();
});
