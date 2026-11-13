import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

for (const choice of ['Cancel', 'Don’t Save', 'Save', 'failed']) test(choice === 'failed' ? 'a failed commit after source loading keeps the document open and allows closing to be retried' : `closing while a committed transform loads its source preserves the ${choice} decision`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path,blob)=>{
    window.closeSavedBlob=blob;return {path,name:'close.photo'};
  }},ui:{showSaveFilePicker:async(blob)=>{
    window.closeSavedBlob=blob;return {path:'/close.photo',name:'close.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
  await run(page, 'file.save');
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
  const original = await page.evaluate(async (choice) => {
    const e = window.photoStudio;
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const read = Renderer.prototype.layerPixels;
    Renderer.prototype.layerPixels = async function (...args) {
      if (args[0].id.startsWith('embedded-source:')) {
        Renderer.prototype.layerPixels = read;
        await new Promise<void>((resolve) => Object.assign(window, { finishCloseSource: resolve }));
      }
      return read.apply(this, args);
    };
    if (choice === 'failed') {
      const assets = e.assets, add = assets.add.bind(assets);
      assets.add = async () => {
        assets.add = add;
        throw new Error('Frame asset could not be stored');
      };
    }
    const { startSession } = await import('/src/features/transform/session.ts');
    startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] });
    return e.session.id;
  }, choice);
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishCloseSource?: () => void }).finishCloseSource);
  // Repeated Commit clicks must share the pending work.
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.locator('.tab-close').click();
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(true);
    expect(await page.locator('dialog[open]').count()).toBe(0);
  } finally {
    await page.evaluate(() => (window as unknown as { finishCloseSource(): void }).finishCloseSource());
  }
  if (choice === 'failed') {
    await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
    await idle(page);
    expect(await page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(true);
    await page.locator('.tab-close').click();
    await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(false);
    return;
  }
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('Save changes');
  await dialog.getByRole('button', { name: choice, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(choice === 'Cancel');
  if (choice === 'Cancel') expect(await page.evaluate(() => ({ dirty: window.photoStudio.session.dirty, frame: !!window.photoStudio.doc.layers.at(-1)!.embed?.frame }))).toEqual({ dirty: true, frame: true });
  else if (choice === 'Save') expect(await page.evaluate(async () => {
    const { deserialize } = await import('/src/model/serialization.ts');
    const loaded = await deserialize((window as unknown as { closeSavedBlob: Blob }).closeSavedBlob);
    return loaded.document.layers.at(-1)!.transform;
  })).toMatchObject({ x: 4, y: 3 });
});
