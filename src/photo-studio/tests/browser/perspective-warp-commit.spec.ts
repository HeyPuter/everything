import { expect, test } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, run, start } from './helpers';

for (const duplicate of [false, true]) test(`${duplicate ? 'Duplicate Image' : 'Save As'} waits for Perspective Warp to commit`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',ui:{showSaveFilePicker:async(blob)=>{
    window.warpSavedBlob=blob;return {path:'/warped.photo',name:'warped.photo'};
  }}};`);
  await openImage(page, 120, 100, '#ffffff', 'original.png');
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(80, 60), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 80, 60);
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
  await run(page, 'edit.perspective-warp');
  await canvasDrag(page, [[20, 20], [100, 80]]);
  await page.locator('#tool-options').getByRole('button', { name: 'Warp', exact: true }).click();
  await canvasDrag(page, [[100, 20], [85, 35]]);
  await page.evaluate(() => {
    const assets = window.photoStudio.assets;
    const add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishWarpAsset: resolve }));
      return add(...args);
    };
  });
  await start(page, duplicate ? 'image.duplicate' : 'file.save-as');
  if (duplicate) await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishWarpAsset?: () => void }).finishWarpAsset);
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => ({ busy: window.photoStudio.busy, copied: window.photoStudio.doc.name.endsWith(' copy'), saved: !!(window as unknown as { warpSavedBlob?: Blob }).warpSavedBlob }))).toEqual({ busy: true, copied: false, saved: false });
  } finally {
    await page.evaluate(() => (window as unknown as { finishWarpAsset(): void }).finishWarpAsset());
  }
  await idle(page);
  if (!duplicate) await page.waitForFunction(() => !!(window as unknown as { warpSavedBlob?: Blob }).warpSavedBlob);
  expect(await page.evaluate(async (duplicate) => {
    const e = window.photoStudio;
    const original = e.sessions.find((s) => s.doc.name === 'original')!;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const blob = duplicate ? await serialize(e.doc, e.assets) : (window as unknown as { warpSavedBlob: Blob }).warpSavedBlob;
    const saved = await deserialize(blob);
    return { originalMesh: !!original.doc.layers.at(-1)!.embed?.frame?.mesh, savedMesh: !!saved.document.layers.at(-1)!.embed?.frame?.mesh, sameFrame: JSON.stringify(saved.document.layers.at(-1)!.embed?.frame?.quad) === JSON.stringify(original.doc.layers.at(-1)!.embed?.frame?.quad) };
  }, duplicate)).toEqual({ originalMesh: true, savedMesh: true, sameFrame: true });
});
