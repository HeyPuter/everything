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
