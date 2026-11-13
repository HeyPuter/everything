import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const duplicate of [false, true]) test(`${duplicate ? 'Duplicate Image' : 'Save As'} waits for the transform source to load`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',ui:{showSaveFilePicker:async(blob)=>{
    window.readySavedBlob=blob;return {path:'/ready.photo',name:'ready.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const canvas = new OffscreenCanvas(16, 12), ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 12);
    await openFile(e, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    const { Renderer } = await import('/src/renderer/renderer.ts');
    const read = Renderer.prototype.layerPixels;
    Renderer.prototype.layerPixels = async function (...args) {
      if (args[0].id.startsWith('embedded-source:')) {
        Renderer.prototype.layerPixels = read;
        await new Promise<void>((resolve) => Object.assign(window, { finishSourceRead: resolve }));
      }
      return read.apply(this, args);
    };
    const { startSession } = await import('/src/features/transform/session.ts');
    startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] });
  });
  await page.waitForFunction(() => !!(window as unknown as { finishSourceRead?: () => void }).finishSourceRead);
  await start(page, duplicate ? 'image.duplicate' : 'file.save-as');
  if (duplicate) await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => ({ busy: window.photoStudio.busy, copied: window.photoStudio.doc.name.endsWith(' copy'), saved: !!(window as unknown as { readySavedBlob?: Blob }).readySavedBlob }))).toEqual({ busy: true, copied: false, saved: false });
  } finally {
    await page.evaluate(() => (window as unknown as { finishSourceRead(): void }).finishSourceRead());
  }
  await idle(page);
  if (!duplicate) await page.waitForFunction(() => !!(window as unknown as { readySavedBlob?: Blob }).readySavedBlob);
  expect(await page.evaluate(async (duplicate) => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const blob = duplicate ? await serialize(e.doc, e.assets) : (window as unknown as { readySavedBlob: Blob }).readySavedBlob;
    const saved = await deserialize(blob);
    return { frame: !!saved.document.layers.at(-1)!.embed?.frame, transform: saved.document.layers.at(-1)!.transform, pending: !!e.modal };
  }, duplicate)).toMatchObject({ frame: true, transform: { x: 4, y: 3 }, pending: false });
});
