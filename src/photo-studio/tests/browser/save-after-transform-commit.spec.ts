import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const duplicate of [false, true]) test(`${duplicate ? 'Duplicate Image' : 'Save As'} includes a transform whose Commit button was just clicked`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',ui:{showSaveFilePicker:async(blob)=>{
    window.committedSavedBlob=blob;return {path:'/committed.photo',name:'committed.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishCommittedAsset: resolve }));
      return add(...args);
    };
  });
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishCommittedAsset?: () => void }).finishCommittedAsset);
  expect(await page.evaluate(() => !!window.photoStudio.modal)).toBe(false);
  await start(page, duplicate ? 'image.duplicate' : 'file.save-as');
  if (duplicate) await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => ({ busy: window.photoStudio.busy, copied: window.photoStudio.doc.name.endsWith(' copy'), saved: !!(window as unknown as { committedSavedBlob?: Blob }).committedSavedBlob }))).toEqual({ busy: true, copied: false, saved: false });
  } finally {
    await page.evaluate(() => (window as unknown as { finishCommittedAsset(): void }).finishCommittedAsset());
  }
  await idle(page);
  if (!duplicate) await page.waitForFunction(() => !!(window as unknown as { committedSavedBlob?: Blob }).committedSavedBlob);
  expect(await page.evaluate(async (duplicate) => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const blob = duplicate ? await serialize(e.doc, e.assets) : (window as unknown as { committedSavedBlob: Blob }).committedSavedBlob;
    const saved = await deserialize(blob);
    return { frame: !!saved.document.layers.at(-1)!.embed?.frame, transform: saved.document.layers.at(-1)!.transform };
  }, duplicate)).toMatchObject({ frame: true, transform: { x: 4, y: 3 } });
});
