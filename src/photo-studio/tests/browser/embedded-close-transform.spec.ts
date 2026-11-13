import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

for (const scenario of ['asset delay', 'source delay', 'failure']) test(`closing embedded contents saves its active nested transform (${scenario})`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ffffff', 'parent.png');
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(24, 18), g = c.getContext('2d')!;
    g.fillStyle = '#808080'; g.fillRect(0, 0, 24, 18);
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'contents.png', true);
  });
  const parent = await page.evaluate(() => window.photoStudio.session.id);
  await run(page, 'layer.embed-edit');
  const child = await page.evaluate(async ({ parent, scenario }) => {
    const e = window.photoStudio;
    Object.assign(window, { parentBeforeClose: e.sessions.find((s) => s.id === parent)!.doc });
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(e, await c.convertToBlob({ type: 'image/png' }), 'nested.png', true);
    const gate = new Promise<void>((resolve) => Object.assign(window, { finishEmbeddedClose: resolve }));
    if (scenario === 'source delay') {
      const { Renderer } = await import('/src/renderer/renderer.ts');
      const read = Renderer.prototype.layerPixels;
      Renderer.prototype.layerPixels = async function (...args) {
        if (args[0].id.startsWith('embedded-source:')) {
          Renderer.prototype.layerPixels = read;
          Object.assign(window, { embeddedCloseStarted: true });
          await gate;
        }
        return read.apply(this, args);
      };
    }
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 22, y: 3 }, { x: 18, y: 15 }, { x: 4, y: 15 }] })!;
    if (scenario !== 'source delay') await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      if (scenario !== 'source delay') {
        Object.assign(window, { embeddedCloseStarted: true });
        await gate;
      }
      if (scenario === 'failure') throw new Error('Frame asset could not be stored');
      return add(...args);
    };
    const close = e.closeSession.bind(e);
    e.closeSession = (...args) => {
      const result = close(...args);
      Object.assign(window, { embeddedClosing: result });
      return result;
    };
    return e.session.id;
  }, { parent, scenario });
  const saveClose = async () => {
    await page.locator('.document-tab.focused .tab-close').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Saving updates the embedded object');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  };
  const state = () => page.evaluate(({ parent, child }) => {
    const e = window.photoStudio;
    return { exists: e.sessions.some((s) => s.id === child), parentUnchanged: e.sessions.find((s) => s.id === parent)!.doc === (window as unknown as { parentBeforeClose: unknown }).parentBeforeClose, busy: e.busy };
  }, { parent, child });
  await saveClose();
  await page.waitForFunction(() => !!(window as unknown as { embeddedCloseStarted?: boolean }).embeddedCloseStarted);
  try {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect.soft(await state()).toEqual({ exists: true, parentUnchanged: true, busy: true });
  } finally {
    await page.evaluate(() => (window as unknown as { finishEmbeddedClose(): void }).finishEmbeddedClose());
  }
  await page.evaluate(() => (window as unknown as { embeddedClosing: Promise<boolean> }).embeddedClosing);
  await idle(page);
  if (scenario === 'failure') {
    await expect(page.locator('#status')).toHaveText('Frame asset could not be stored');
    expect(await state()).toEqual({ exists: true, parentUnchanged: true, busy: false });
    expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(true);
    await page.evaluate(async () => {
      const { startSession } = await import('/src/features/transform/session.ts');
      startSession(window.photoStudio, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 22, y: 3 }, { x: 18, y: 15 }, { x: 4, y: 15 }] });
    });
    await saveClose();
    await page.evaluate(() => (window as unknown as { embeddedClosing: Promise<boolean> }).embeddedClosing);
    await idle(page);
  }
  await page.waitForFunction((parent) => window.photoStudio.sessions.find((s) => s.id === parent)!.doc !== (window as unknown as { parentBeforeClose: unknown }).parentBeforeClose, parent);
  expect(await page.evaluate(async (parent) => {
    const s = window.photoStudio.sessions.find((s) => s.id === parent)!;
    const contents = s.doc.embeds![s.doc.layers.at(-1)!.embed!.contents];
    const { deserialize } = await import('/src/model/serialization.ts');
    const saved = await deserialize(s.assets.blob(contents.project!));
    return { frame: !!saved.document.layers.at(-1)!.embed?.frame, transform: saved.document.layers.at(-1)!.transform };
  }, parent)).toMatchObject({ frame: true, transform: { x: 4, y: 3 } });
  await expect.poll(() => page.evaluate((child) => window.photoStudio.sessions.some((s) => s.id === child), child)).toBe(false);
});
