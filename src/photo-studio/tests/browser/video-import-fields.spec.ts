import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

test('a fractional-duration video can be imported with its default range', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { muxWebm } = await import('/src/imaging/codecs/webm.ts');
    const chunks: { data: Uint8Array; timestampMs: number; key: boolean }[] = [];
    const encoder = new VideoEncoder({
      output(chunk) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, timestampMs: chunk.timestamp / 1000, key: chunk.type === 'key' });
      },
      error(error) { throw error; },
    });
    encoder.configure({ codec: 'vp8', width: 16, height: 16, bitrate: 100_000, framerate: 30 });
    try {
      for (let i = 0; i < 2; i++) {
        const frame = new VideoFrame(new Uint8Array(16 * 16 * 4).fill(255), { format: 'RGBA', codedWidth: 16, codedHeight: 16, timestamp: Math.round(i * 1e6 / 30), duration: Math.round(1e6 / 30) });
        encoder.encode(frame, { keyFrame: true });
        frame.close();
      }
      await encoder.flush();
    } finally { encoder.close(); }
    const bytes = muxWebm(chunks, { width: 16, height: 16, codec: 'V_VP8', frameRate: 30 });
    void window.photoStudio.runCommand('file.import-video-frames', new File([bytes], 'short.webm', { type: 'video/webm' }));
  });
  const dialog = page.getByRole('dialog', { name: 'Video Frames to Layers' });
  await expect(dialog).toBeVisible();
  const to = dialog.locator('input[name="to"]');
  expect(await to.evaluate((input: HTMLInputElement) => ({ valid: input.validity.valid, overflow: input.validity.rangeOverflow, step: input.validity.stepMismatch }))).toEqual({ valid: true, overflow: false, step: false });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.session.fileName)).toBe('short.webm');
});
