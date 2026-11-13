import { expect, test } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

for (const scenario of [
  { existingPath: false, failed: false, sourcePending: false },
  { existingPath: true, failed: false, sourcePending: false },
  { existingPath: false, failed: true, sourcePending: false },
  { existingPath: false, failed: false, sourcePending: true },
]) test(`Save before closing finishes an active transform (${scenario.failed ? 'failure and retry' : scenario.sourcePending ? 'source loading' : scenario.existingPath ? 'existing path' : 'first save'})`, async ({ page }) => {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path,blob)=>{
    window.activeCloseBlob=blob;return {path,name:'active.photo'};
  }},ui:{showSaveFilePicker:async(blob)=>{
    window.activeCloseBlob=blob;return {path:'/active.photo',name:'active.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  const original = await page.evaluate(async ({ existingPath, failed, sourcePending }) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    if (existingPath) e.session.storage.path = '/active.photo';
    const gate = new Promise<void>((resolve) => Object.assign(window, { finishCloseSave: resolve }));
    if (sourcePending) {
      const { Renderer } = await import('/src/renderer/renderer.ts');
      const read = Renderer.prototype.layerPixels;
      Renderer.prototype.layerPixels = async function (...args) {
        if (args[0].id.startsWith('embedded-source:')) {
          Renderer.prototype.layerPixels = read;
          Object.assign(window, { closeSaveStarted: true });
          await gate;
        }
        return read.apply(this, args);
      };
    }
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    if (!sourcePending) await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      if (!sourcePending) {
        Object.assign(window, { closeSaveStarted: true });
        await gate;
      }
      if (failed) throw new Error('Frame asset could not be stored');
      return add(...args);
    };
    return e.session.id;
  }, scenario);
  const saveClose = async () => {
    await page.locator('.document-tab.focused .tab-close').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Save changes');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  };
  await saveClose();
  await page.waitForFunction(() => !!(window as unknown as { closeSaveStarted?: boolean }).closeSaveStarted);
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate((id) => ({
      exists: window.photoStudio.sessions.some((s) => s.id === id),
      busy: window.photoStudio.busy,
      saved: !!(window as unknown as { activeCloseBlob?: Blob }).activeCloseBlob,
    }), original)).toEqual({ exists: true, busy: true, saved: false });
  } finally {
    await page.evaluate(() => (window as unknown as { finishCloseSave(): void }).finishCloseSave());
  }
  await idle(page);
  if (scenario.failed) {
    await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
    expect(await page.evaluate((id) => ({
      exists: window.photoStudio.sessions.some((s) => s.id === id),
      dirty: window.photoStudio.session.dirty,
      saved: !!(window as unknown as { activeCloseBlob?: Blob }).activeCloseBlob,
    }), original)).toEqual({ exists: true, dirty: true, saved: false });
    await page.evaluate(async () => {
      const { startSession } = await import('/src/features/transform/session.ts');
      startSession(window.photoStudio, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] });
    });
    await saveClose();
    await idle(page);
  }
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(false);
  expect(await page.evaluate(async () => {
    const { deserialize } = await import('/src/model/serialization.ts');
    const saved = await deserialize((window as unknown as { activeCloseBlob: Blob }).activeCloseBlob);
    return { frame: !!saved.document.layers.at(-1)!.embed?.frame, transform: saved.document.layers.at(-1)!.transform };
  })).toMatchObject({ frame: true, transform: { x: 4, y: 3 } });
});
