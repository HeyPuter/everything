import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const saveAs of [false, true]) test(`${saveAs ? 'Save As' : 'Save'} waits for a pending embedded transform`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path,blob)=>{
    window.frameSavedBlob=blob;return {path,name:'frame.photo'};
  }},ui:{showSaveFilePicker:async(blob)=>{
    window.frameSavedBlob=blob;return {path:'/frame.photo',name:'frame.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff');
  await page.evaluate(async (saveAs) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const canvas = new OffscreenCanvas(16, 12);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 12);
    await openFile(e, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    if (!saveAs) e.session.storage.path = '/frame.photo';
    const { startSession } = await import('/src/features/transform/session.ts');
    const s = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => s.ready ? resolve() : setTimeout(check, 10); check(); });
    const add = e.assets.add.bind(e.assets);
    e.assets.add = async (...args) => {
      e.assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishFrameAsset: resolve }));
      return add(...args);
    };
  }, saveAs);
  await start(page, saveAs ? 'file.save-as' : 'file.save');
  await page.waitForFunction(() => !!(window as unknown as { finishFrameAsset?: () => void }).finishFrameAsset);
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => ({ busy: window.photoStudio.busy, written: !!(window as unknown as { frameSavedBlob?: Blob }).frameSavedBlob }))).toEqual({ busy: true, written: false });
  } finally {
    await page.evaluate(() => (window as unknown as { finishFrameAsset(): void }).finishFrameAsset());
  }
  await page.waitForFunction(() => !!(window as unknown as { frameSavedBlob?: Blob }).frameSavedBlob);
  await idle(page);
  expect(await page.evaluate(async () => {
    const { deserialize } = await import('/src/model/serialization.ts');
    const loaded = await deserialize((window as unknown as { frameSavedBlob: Blob }).frameSavedBlob);
    const layer = loaded.document.layers.at(-1)!;
    return { transform: layer.transform, frame: !!layer.embed?.frame, dirty: window.photoStudio.session.dirty };
  })).toMatchObject({ transform: { x: 4, y: 3 }, frame: true, dirty: false });
});
