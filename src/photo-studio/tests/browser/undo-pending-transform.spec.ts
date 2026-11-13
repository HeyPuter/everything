import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, panel, run, start } from './helpers';

async function prepare(page: Page, emptyHistory: boolean, failed = false) {
  await boot(page);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  return page.evaluate(async ({ emptyHistory, failed }) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    if (emptyHistory) e.history.reset(e.doc);
    const placedId = e.layer!.id;
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishCommittedAsset: resolve }));
      if (failed) throw new Error('Frame asset could not be stored');
      return add(...args);
    };
    return placedId;
  }, { emptyHistory, failed });
}

for (const command of ['edit.undo', 'edit.toggle-last-state', 'panel-undo']) for (const emptyHistory of [false, true]) test(`${command} undoes the pending transform ${emptyHistory ? 'as the first edit' : 'without removing the placed layer'}`, async ({ page }) => {
  const placedId = await prepare(page, emptyHistory);
  if (command === 'panel-undo') await panel(page, 'History');
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishCommittedAsset?: () => void }).finishCommittedAsset);
  expect(await page.evaluate(() => !!window.photoStudio.modal)).toBe(false);
  try {
    if (command === 'panel-undo') {
      const history = page.locator('#history');
      const undo = history.getByRole('button', { name: 'Undo', exact: true });
      expect(await undo.isEnabled()).toBe(true);
      await undo.click();
    } else await start(page, command);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  } finally {
    await page.evaluate(() => (window as unknown as { finishCommittedAsset(): void }).finishCommittedAsset());
  }
  await page.evaluate(() => window.photoStudio.session.waitForEdits());
  await idle(page);
  expect(await page.evaluate((id) => {
    const e = window.photoStudio, placed = e.doc.layers.find((l) => l.id === id);
    return { exists: !!placed, frame: !!placed?.embed?.frame, redo: e.history.redoLabels };
  }, placedId)).toEqual({ exists: true, frame: false, redo: ['Transform'] });
  await run(page, command === 'edit.toggle-last-state' ? command : 'edit.redo');
  expect(await page.evaluate((id) => !!window.photoStudio.doc.layers.find((l) => l.id === id)?.embed?.frame, placedId)).toBe(true);
});

for (const emptyHistory of [false, true]) test(`a failed pending commit leaves ${emptyHistory ? 'Undo disabled for an empty history' : 'the previous edit intact'}`, async ({ page }) => {
  const placedId = await prepare(page, emptyHistory, true);
  const history = await panel(page, 'History');
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishCommittedAsset?: () => void }).finishCommittedAsset);
  try {
    expect(await history.getByRole('button', { name: 'Undo', exact: true }).isEnabled()).toBe(true);
    await start(page, 'edit.undo');
  } finally {
    await page.evaluate(() => (window as unknown as { finishCommittedAsset(): void }).finishCommittedAsset());
  }
  await idle(page);
  await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
  expect(await page.evaluate((id) => {
    const e = window.photoStudio, placed = e.doc.layers.find((l) => l.id === id);
    return { exists: !!placed, frame: !!placed?.embed?.frame, redo: e.history.redoLabels };
  }, placedId)).toEqual({ exists: true, frame: false, redo: [] });
  await expect(history.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled({ enabled: !emptyHistory });
});
