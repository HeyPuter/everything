import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, panel, run, start } from './helpers';
import type { Quad } from '../../src/features/transform/math';

async function placeImage(page: Page) {
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const canvas = new OffscreenCanvas(16, 12), g = canvas.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(window.photoStudio, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
}

async function snapshot(page: Page) {
  await start(page, 'history.snapshot');
  const dialog = page.locator('dialog[open]');
  await dialog.getByLabel('Name', { exact: true }).fill('Checkpoint');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await idle(page);
  return page.evaluate(async () => {
    const { sessionSnapshots } = await import('/src/features/history-tools.ts');
    return sessionSnapshots(window.photoStudio).find((s) => s.name === 'Checkpoint')!.id;
  });
}

async function beginDistort(page: Page) {
  await page.evaluate(async () => {
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(window.photoStudio, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] as Quad })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
  });
}

for (const scenario of [
  { commit: false, containsImage: false },
  { commit: true, containsImage: false },
  { commit: false, containsImage: true },
  { commit: true, containsImage: true },
  { commit: true, containsImage: false, limited: true },
  { commit: false, containsImage: false, failed: true },
  { commit: true, containsImage: false, failed: true },
]) test(`restoring a snapshot ${scenario.containsImage ? 'with' : 'without'} the placed image ${scenario.failed ? 'stops on failure of' : 'waits for'} an ${scenario.commit ? 'already committed' : 'active'} transform${scenario.limited ? ' at the history limit' : ''}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  if (scenario.containsImage) await placeImage(page);
  const id = await snapshot(page);
  if (!scenario.containsImage) await placeImage(page);
  const placed = await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Rename', (d) => { d.name = 'Edited'; });
    return e.layer!.id;
  });
  if (scenario.limited) await page.evaluate(() => { window.photoStudio.history.limit = 1; });
  await beginDistort(page);
  await page.evaluate((failed) => {
    const assets = window.photoStudio.assets, add = assets.add.bind(assets);
    const gate = new Promise<void>((resolve) => Object.assign(window, { finishRestoreAsset: resolve }));
    assets.add = async (...args) => {
      assets.add = add;
      Object.assign(window, { restoreAssetStarted: true });
      await gate;
      if (failed) throw new Error('Restore transform could not be stored');
      return add(...args);
    };
  }, !!scenario.failed);
  const history = await panel(page, 'History');
  if (scenario.commit) {
    await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { restoreAssetStarted?: boolean }).restoreAssetStarted);
  }
  await history.locator(`[data-snapshot="${id}"]`).click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const waiting = await page.evaluate(() => ({ busy: window.photoStudio.busy, name: window.photoStudio.doc.name }));
  await page.evaluate(() => (window as unknown as { finishRestoreAsset(): void }).finishRestoreAsset());
  if (!scenario.failed) await page.evaluate(() => window.photoStudio.session.waitForEdits());
  await idle(page);
  const result = await page.evaluate((id) => {
    const e = window.photoStudio, layer = e.doc.layers.find((l) => l.id === id);
    return { name: e.doc.name, exists: !!layer, frame: !!layer?.embed?.frame, labels: e.history.labels };
  }, placed);
  if (scenario.failed) {
    await expect(page.locator('#status')).toHaveText('Restore transform could not be stored');
    expect(result.name).toBe('Edited');
    expect(result.exists).toBe(true);
    expect(result.labels.at(-1)).toBe('Rename');
    // A failed commit must not make the saved snapshot unusable.
    await history.locator(`[data-snapshot="${id}"]`).click();
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.doc.name)).toBe('original');
  } else {
    expect(result).toMatchObject({ name: 'original', exists: scenario.containsImage, frame: false });
    expect(result.labels.slice(-2)).toEqual(scenario.limited ? ['Revert to Checkpoint'] : ['Transform', 'Revert to Checkpoint']);
    await run(page, 'edit.undo');
    expect(await page.evaluate((id) => {
      const e = window.photoStudio;
      return { name: e.doc.name, frame: !!e.doc.layers.find((l) => l.id === id)?.embed?.frame };
    }, placed)).toEqual({ name: 'Edited', frame: true });
    await run(page, 'edit.redo');
    expect(await page.evaluate(() => ({ name: window.photoStudio.doc.name, frame: !!window.photoStudio.doc.layers.at(-1)?.embed?.frame }))).toEqual({ name: 'original', frame: false });
  }
  expect(waiting).toEqual({ busy: true, name: 'Edited' });
});

for (const kind of ['free', 'pixel']) test(`restoring a snapshot keeps the pending ${kind} transform available to Undo`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  const id = await snapshot(page);
  if (kind === 'free') await page.evaluate(() => { const e = window.photoStudio; e.transform.begin(); e.transform.nudge(4, 3); });
  else await beginDistort(page);
  const history = await panel(page, 'History');
  await history.locator(`[data-snapshot="${id}"]`).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].transform)).toMatchObject({ x: 0, y: 0 });
  await run(page, 'edit.undo');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].transform)).toMatchObject({ x: 4, y: 3 });
  await run(page, 'edit.redo');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].transform)).toMatchObject({ x: 0, y: 0 });
});
