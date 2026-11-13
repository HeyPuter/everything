import { expect, test } from '@playwright/test';
import { boot, idle, openImage, start } from './helpers';

for (const kind of ['free', 'pixel', 'embedded'] as const) test(`Duplicate Image includes a pending ${kind} transform`, async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  await page.evaluate(async (kind) => {
    const e = window.photoStudio;
    if (kind === 'free') {
      e.transform.begin();
      e.transform.nudge(4, 3);
      return;
    }
    if (kind === 'embedded') {
      const { openFile } = await import('/src/features/files/open.ts');
      const canvas = new OffscreenCanvas(16, 12);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#0000ff'; ctx.fillRect(0, 0, 16, 12);
      await openFile(e, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
    }
    const { startSession } = await import('/src/features/transform/session.ts');
    const s = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] })!;
    await new Promise<void>((resolve) => { const check = () => s.ready ? resolve() : setTimeout(check, 10); check(); });
  }, kind);
  await idle(page);
  await start(page, 'image.duplicate');
  await page.getByRole('dialog', { name: 'Duplicate Image' }).getByRole('button', { name: 'Duplicate', exact: true }).click();
  await idle(page);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const original = e.sessions.find((s) => s.doc.name === 'original')!;
    const originalLayer = original.doc.layers.at(-1)!;
    const copyLayer = e.doc.layers.at(-1)!;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const saved = await deserialize(await serialize(e.doc, e.assets));
    return { original: originalLayer.transform, copy: copyLayer.transform, saved: saved.document.layers.at(-1)!.transform, originalFrame: originalLayer.embed?.frame?.quad, copyFrame: copyLayer.embed?.frame?.quad };
  });
  expect(result.copy).toMatchObject({ x: 4, y: 3 });
  expect(result.copy).toEqual(result.original);
  expect(result.saved).toEqual(result.copy);
  if (kind === 'embedded') {
    expect(result.copyFrame).toBeDefined();
    expect(result.copyFrame).toEqual(result.originalFrame);
  }
});
