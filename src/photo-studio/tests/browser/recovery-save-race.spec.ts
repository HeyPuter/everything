// A recovery write that was still running when the document was saved left a
// record behind, so the next launch offered to restore a saved document.
import { expect, test } from '@playwright/test';
import { boot } from './helpers';

test('saving while a recovery copy is written leaves no recovery record', async ({ page }) => {
  await boot(page);
  const kept = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument, layer } = await import('/src/model/document.ts');
    const { recoveryTick } = await import('/src/features/versions/recovery.ts');
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    const store = new RecoveryStore();
    const s = e.sessionForOpen();
    s.history.reset(newDocument(400, 300, 'Race'));
    s.hasDocument = true;
    e.session = s;
    e.command('Add', (d) => d.layers.push(layer('solid', 'X', 10, 10)));
    const tick = recoveryTick(e);
    // Saved before the recovery copy finished writing.
    s.saved = s.doc;
    for (const hook of e.saveHooks) hook(s, new Blob());
    await tick;
    await new Promise((r) => setTimeout(r, 200));
    const found = (await store.list()).some((r) => r.sessionId === s.id);
    await store.remove(s.id);
    return found;
  });
  expect(kept).toBe(false);
});
