import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test('a late version list cannot replace the active document list after a tab switch', async ({ page }) => {
  await boot(page);
  for (const name of ['First', 'Second']) {
    await openImage(page, 16, 16, '#336699', `${name}.png`);
    await page.evaluate(async (name) => {
      const e = window.photoStudio;
      const { addVersion } = await import('/src/features/versions/index.ts');
      await addVersion(e, e.session, name, 'named');
    }, name);
  }
  await run(page, 'file.version-history');
  const panel = page.locator('.versions-panel');
  await expect(panel.locator('.version-row')).toContainText('Second');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { VersionStore } = await import('/src/persistence/versions.ts');
    const original = VersionStore.prototype.list;
    const first = e.sessions.find((s) => s.doc.name === 'First')!;
    const state = { started: false, release: () => {} };
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    (window as unknown as { versionListGate: typeof state }).versionListGate = state;
    VersionStore.prototype.list = async function (id) {
      const list = await original.call(this, id);
      if (id === first.doc.id) { state.started = true; await gate; }
      return list;
    };
    e.session = first;
    e.update();
  });
  await page.waitForFunction(() => (window as unknown as { versionListGate: { started: boolean } }).versionListGate.started);
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.doc.name === 'Second')!;
    e.update();
    (window as unknown as { versionListGate: { release(): void } }).versionListGate.release();
  });
  await idle(page);
  await expect(panel.locator('.version-row')).toContainText('Second');
  await panel.locator('[data-version-act="preview"]').click();
  await idle(page);
  expect(await page.evaluate(() => !!window.photoStudio.modal)).toBe(true);
  await expect(panel.locator('.versions-banner')).toContainText('Second');
});
