// Batch processing keeps going after a file fails and reports the failures.
import { test, expect } from '@playwright/test';
import { boot } from './helpers';

test('a file that fails is reported with the processed ones, and the rest still run', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const e = window.photoStudio;
    const c = new OffscreenCanvas(20, 10);
    c.getContext('2d')!.fillRect(0, 0, 20, 10);
    const good = await c.convertToBlob({ type: 'image/png' });
    const bad = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
    const { runProcessor, failedNote } = await import('/src/features/files/automate.ts');
    const inputs = [{ name: 'broken.png', blob: bad }, { name: 'fine.png', blob: good }];
    const files = await runProcessor(e, inputs, { resize: false, w: 0, h: 0, enlarge: false, format: 'png', quality: 90, srgb: true, steps: [] }, () => {}, () => false);
    return { names: files.map((f) => f.name), failed: files.failed, note: failedNote(files.failed) };
  });
  expect(r.names).toEqual(['fine.png']);
  expect(r.failed).toHaveLength(1);
  expect(r.note).toMatch(/^1 file failed\. broken\.png: /);
});
