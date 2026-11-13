import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const command of ['file.save', 'file.save-as', 'image.duplicate']) test(`${command} stops after a transform storage failure and can be retried`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path,blob)=>{
    window.failureSavedBlob=blob;return {path,name:'failure.photo'};
  }},ui:{showSaveFilePicker:async(blob)=>{
    window.failureSavedBlob=blob;return {path:'/failure.photo',name:'failure.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  const original = await page.evaluate(async (command) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    if (command === 'file.save') e.session.storage.path = '/failure.photo';
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async () => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { failTransformAsset: resolve }));
      throw new Error('Frame asset could not be stored');
    };
    return e.session.id;
  }, command);
  const begin = async () => {
    await start(page, command);
    if (command === 'image.duplicate') await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  };
  await begin();
  await page.waitForFunction(() => !!(window as unknown as { failTransformAsset?: () => void }).failTransformAsset);
  await page.evaluate(() => (window as unknown as { failTransformAsset(): void }).failTransformAsset());
  await idle(page);
  expect(await page.evaluate((original) => {
    const e = window.photoStudio;
    return { original: e.session.id === original, sessions: e.sessions.length, dirty: e.session.dirty, saved: !!(window as unknown as { failureSavedBlob?: Blob }).failureSavedBlob };
  }, original)).toEqual({ original: true, sessions: 1, dirty: true, saved: false });
  await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
  // A failed commit must not poison the next attempt or persist old geometry.
  await page.evaluate(async () => {
    const { startSession } = await import('/src/features/transform/session.ts');
    startSession(window.photoStudio, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] });
  });
  await begin();
  await idle(page);
  expect(await page.evaluate(async (duplicate) => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const blob = duplicate ? await serialize(e.doc, e.assets) : (window as unknown as { failureSavedBlob: Blob }).failureSavedBlob;
    const loaded = await deserialize(blob);
    return { frame: !!loaded.document.layers.at(-1)!.embed?.frame, transform: loaded.document.layers.at(-1)!.transform };
  }, command === 'image.duplicate')).toMatchObject({ frame: true, transform: { x: 4, y: 3 } });
});
