import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

for (const scenario of [
  { commit: true, target: 0, limited: false },
  { commit: true, target: 1, limited: false },
  { commit: false, target: 1, limited: false },
  { commit: true, target: 1, limited: true },
  { commit: true, target: 0, limited: true },
  { commit: true, target: 0, limited: true, failed: true },
  { commit: false, target: 0, limited: true, failed: true },
]) test(`History row ${scenario.target} preserves a transform ${scenario.commit ? 'after Commit' : 'still in the tool'}${scenario.limited ? ' at the history limit' : ''}${scenario.failed ? ' with an asset failure' : ''}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  const placedId = await page.evaluate(async ({ limited, failed }) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    if (limited) e.history.limit = 1;
    const id = e.layer!.id;
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const gate = new Promise<void>((resolve) => Object.assign(window, { finishHistoryAsset: resolve }));
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      Object.assign(window, { historyAssetStarted: true });
      await gate;
      if (failed) throw new Error('Frame asset could not be stored');
      return add(...args);
    };
    return id;
  }, scenario);
  const history = await panel(page, 'History');
  if (scenario.commit) {
    await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { historyAssetStarted?: boolean }).historyAssetStarted);
  }
  try {
    await history.locator(`[data-history="${scenario.target}"]`).click();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally {
    await page.evaluate(() => (window as unknown as { finishHistoryAsset(): void }).finishHistoryAsset());
  }
  if (!scenario.failed) await page.evaluate(() => window.photoStudio.session.waitForEdits());
  await idle(page);
  if (scenario.failed) {
    await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
    expect(await page.evaluate((id) => window.photoStudio.doc.layers.some((l) => l.id === id), placedId)).toBe(true);
    await page.evaluate(() => window.photoStudio.command('Rename', (d) => { d.name = 'After failure'; }));
    expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Rename']);
    return;
  }
  expect(await page.evaluate((id) => {
    const e = window.photoStudio, placed = e.doc.layers.find((l) => l.id === id);
    return { exists: !!placed, frame: !!placed?.embed?.frame, redo: e.history.redoLabels, modal: !!e.modal };
  }, placedId)).toEqual({ exists: scenario.target === 1, frame: false, redo: scenario.target === 0 ? ['Place Embedded', 'Transform'] : ['Transform'], modal: false });
  if (scenario.target === 0) await run(page, 'edit.redo');
  await run(page, 'edit.redo');
  expect(await page.evaluate((id) => !!window.photoStudio.doc.layers.find((l) => l.id === id)?.embed?.frame, placedId)).toBe(true);
});

test('History rows respect a running task and remain usable afterward', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#ffffff', 'original.png');
  await page.evaluate(() => window.photoStudio.command('Rename', (d) => { d.name = 'Edited'; }));
  const history = await panel(page, 'History');
  await page.evaluate(() => void window.photoStudio.run(() => new Promise<void>((resolve) => Object.assign(window, { finishHistoryTask: resolve }))));
  try {
    await history.locator('[data-history="0"]').click();
    expect(await page.evaluate(() => window.photoStudio.doc.name)).toBe('Edited');
  } finally {
    await page.evaluate(() => (window as unknown as { finishHistoryTask(): void }).finishHistoryTask());
  }
  await idle(page);
  await history.locator('[data-history="0"]').click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.name)).toBe('original');
});
