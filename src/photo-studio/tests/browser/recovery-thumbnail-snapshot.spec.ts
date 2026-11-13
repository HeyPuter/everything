import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

test('a recovery thumbnail shows the document actually stored during concurrent edits', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16, '#336699', 'picture.png');
  const snapshots = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { recoveryTick } = await import('/src/features/versions/recovery.ts');
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    const { deserialize } = await import('/src/model/serialization.ts');
    e.command('Rename', (d) => { d.name = 'First'; });
    const first = recoveryTick(e);
    // The interval runs in the background while the document remains editable.
    e.command('Later edit', (d) => { d.name = 'Later'; d.layers[0].opacity = 0.5; });
    await first;
    const read = async () => {
      const record = (await new RecoveryStore().list()).find((r) => r.sessionId === e.session.id)!;
      const loaded = await deserialize(record.project);
      const bitmap = await createImageBitmap(record.thumb!);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const result = { name: record.name, savedName: loaded.document.name, opacity: loaded.document.layers[0].opacity, alpha: context.getImageData(8, 8, 1, 1).data[3] };
      loaded.assets.clear();
      return result;
    };
    const before = await read();
    await recoveryTick(e);
    return [before, await read()];
  });
  expect(snapshots).toEqual([
    { name: 'First', savedName: 'First', opacity: 1, alpha: 255 },
    { name: 'Later', savedName: 'Later', opacity: 0.5, alpha: 128 },
  ]);
});
