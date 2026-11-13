import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';
import type { Quad } from '../../src/features/transform/math';

async function prepare(page: Page, kind: string) {
  await boot(page);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  await page.evaluate(async (kind) => {
    const e = window.photoStudio;
    if (kind === 'embedded') {
      const { openFile } = await import('/src/features/files/open.ts');
      const canvas = new OffscreenCanvas(16, 12), g = canvas.getContext('2d')!;
      g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
      await openFile(e, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    }
    if (kind === 'free') { e.transform.begin(); e.transform.nudge(4, 3); }
    else {
      const { startSession } = await import('/src/features/transform/session.ts');
      const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] as Quad })!;
      await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    }
  }, kind);
}

async function nameSnapshot(page: Page, accept = true) {
  await start(page, 'history.snapshot');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('New Snapshot');
  await dialog.getByLabel('Name', { exact: true }).fill('Transformed');
  await dialog.getByRole('button', { name: accept ? 'OK' : 'Cancel', exact: true }).click();
}

async function snapshotState(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const { sessionSnapshots } = await import('/src/features/history-tools.ts');
    const snap = sessionSnapshots(e).find((s) => s.name === 'Transformed');
    const layer = snap?.doc.layers.at(-1);
    return { id: snap?.id, transform: layer?.transform, frame: !!layer?.embed?.frame, pending: e.hasPendingChanges(), busy: e.busy };
  });
}

for (const kind of ['free', 'pixel', 'embedded']) test(`New Snapshot includes a pending ${kind} transform`, async ({ page }) => {
  await prepare(page, kind);
  await nameSnapshot(page);
  await idle(page);
  const state = await snapshotState(page);
  expect(state.transform).toMatchObject({ x: 4, y: 3 });
  expect(state.pending).toBe(false);
  if (kind === 'embedded') expect(state.frame).toBe(true);
  await page.evaluate(() => window.photoStudio.command('Move again', (d) => { d.layers.at(-1)!.transform.x = 18; }));
  await run(page, 'history.restore-snapshot', state.id);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.transform)).toMatchObject({ x: 4, y: 3 });
});

for (const commit of [false, true]) for (const failed of [false, true]) test(`New Snapshot ${failed ? 'stops after' : 'waits for'} an ${commit ? 'already committed' : 'active'} transform asset ${failed ? 'failure' : 'write'}`, async ({ page }) => {
  await prepare(page, 'embedded');
  await page.evaluate((failed) => {
    const assets = window.photoStudio.assets, add = assets.add.bind(assets);
    const gate = new Promise<void>((resolve) => Object.assign(window, { finishSnapshotAsset: resolve }));
    assets.add = async (...args) => {
      assets.add = add;
      Object.assign(window, { snapshotAssetStarted: true });
      await gate;
      if (failed) throw new Error('Snapshot transform could not be stored');
      return add(...args);
    };
  }, failed);
  if (commit) {
    await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
    await page.waitForFunction(() => !!(window as unknown as { snapshotAssetStarted?: boolean }).snapshotAssetStarted);
  }
  await nameSnapshot(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const waiting = await snapshotState(page);
  await page.evaluate(() => (window as unknown as { finishSnapshotAsset(): void }).finishSnapshotAsset());
  await idle(page);
  expect(waiting.id).toBeUndefined();
  expect(waiting.busy).toBe(true);
  const result = await snapshotState(page);
  if (failed) {
    await expect(page.locator('#status')).toHaveText('Snapshot transform could not be stored');
    expect(result.id).toBeUndefined();
    await page.evaluate(async () => {
      const { startSession } = await import('/src/features/transform/session.ts');
      const transform = startSession(window.photoStudio, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] as Quad })!;
      await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    });
    await nameSnapshot(page);
    await idle(page);
    expect(await snapshotState(page)).toMatchObject({ frame: true, transform: { x: 4, y: 3 }, pending: false });
  } else {
    expect(result.transform).toMatchObject({ x: 4, y: 3 });
    expect(result.frame).toBe(true);
  }
});

for (const kind of ['free', 'embedded']) test(`cancelling New Snapshot preserves the pending ${kind} transform`, async ({ page }) => {
  await prepare(page, kind);
  await nameSnapshot(page, false);
  await idle(page);
  expect(await snapshotState(page)).toMatchObject({ id: undefined, pending: true });
});
