import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const sharedIds of [false, true]) test(`an embedded transform commits to its original tab after switching to ${sharedIds ? 'a duplicate' : 'another image'}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ffffff', 'original.png');
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
  if (sharedIds) {
    await start(page, 'image.duplicate');
    await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
    await idle(page);
  } else await openImage(page, 32, 24, '#ff0000', 'other.png');
  const untouched = await page.evaluate(() => JSON.stringify(window.photoStudio.doc));
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.switchSession(e.sessions.find((s) => s.doc.name === 'original')!);
    const { startSession } = await import('/src/features/transform/session.ts');
    const s = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => s.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishFrameAsset: resolve }));
      return add(...args);
    };
    const apply = s.apply.bind(s);
    s.apply = (...args) => {
      const committed = Promise.resolve(apply(...args));
      Object.assign(window, { frameCommitted: committed });
      return committed;
    };
  });
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishFrameAsset?: () => void }).finishFrameAsset);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.switchSession(e.sessions.find((s) => s.doc.name !== 'original')!);
    const w = window as unknown as { finishFrameAsset(): void; frameCommitted: Promise<void> };
    w.finishFrameAsset();
    await w.frameCommitted;
  });
  expect(await page.evaluate(() => {
    const e = window.photoStudio;
    return { originalFrame: !!e.sessions.find((s) => s.doc.name === 'original')!.doc.layers.at(-1)!.embed?.frame, other: JSON.stringify(e.doc) };
  })).toEqual({ originalFrame: true, other: untouched });
  // The original keeps its own cached pixels and remains independently saveable.
  expect(await page.evaluate(async () => {
    const e = window.photoStudio, original = e.sessions.find((s) => s.doc.name === 'original')!;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const loaded = await deserialize(await serialize(original.doc, original.assets));
    return loaded.document.layers.at(-1)!.transform;
  })).toMatchObject({ x: 4, y: 3 });
});
