// Closing a document with a video timeline frees what its footage and sound
// held: decoded video frames, open video decoders and decoded audio.
import { expect, test, type Page } from '@playwright/test';
import { encodeWav } from '../../src/imaging/codecs/wav';
import { boot, idle, openImage, run } from './helpers';

function toneWav(seconds = 2, rate = 48000) {
  const ch = Float32Array.from(
    { length: seconds * rate },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate),
  );
  return Buffer.from(encodeWav([ch], rate)).toString('base64');
}
/** A 1 s VP8 WebM as a video layer. */
async function addFootage(page: Page) {
  await page.evaluate(async () => {
    const { muxWebm } = await import('/src/imaging/codecs/webm.ts');
    const chunks: { data: Uint8Array; timestampMs: number; key: boolean }[] = [];
    const ve = new VideoEncoder({
      output: (c) => {
        const data = new Uint8Array(c.byteLength);
        c.copyTo(data);
        chunks.push({ data, timestampMs: c.timestamp / 1000, key: c.type === 'key' });
      },
      error: (err) => console.warn(err),
    });
    ve.configure({ codec: 'vp8', width: 32, height: 32, bitrate: 200_000, framerate: 10 });
    for (let k = 0; k < 10; k++) {
      const data = new Uint8ClampedArray(32 * 32 * 4).fill(25 * k);
      const frame = new VideoFrame(data, {
        format: 'RGBA',
        codedWidth: 32,
        codedHeight: 32,
        timestamp: k * 100_000,
        duration: 100_000,
      });
      ve.encode(frame, { keyFrame: k === 0 });
      frame.close();
    }
    await ve.flush();
    const bytes = muxWebm(chunks, { width: 32, height: 32, codec: 'V_VP8', frameRate: 10 });
    await window.photoStudio.runCommand(
      'layer.video-new-file',
      new File([bytes], 'clip.webm', { type: 'video/webm' }),
    );
  });
  await idle(page);
}
const stats = (page: Page) =>
  page.evaluate(async () => {
    const frames = await import('/src/features/animation/video-frames.ts');
    const audio = await import('/src/features/animation/audio-media.ts');
    return { ...frames.cacheStats(), ...audio.audioCacheStats() };
  });

test('closing a document frees its decoded frames, decoders and sound', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  await openImage(page, 64, 48, '#ffffff', 'keep.png');
  await openImage(page, 64, 48, '#ffffff', 'media.png');
  await run(page, 'timeline.create');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await window.photoStudio.runCommand(
      'timeline.audio-add',
      new File([bytes], 'tone.wav', { type: 'audio/wav' }),
    );
  }, toneWav());
  await idle(page);
  await addFootage(page);
  await run(page, 'timeline.go-to', 5);
  const before = await stats(page);
  expect(before.frames).toBeGreaterThan(0);
  expect(before.decoders).toBeGreaterThan(0);
  expect(before.sources).toBeGreaterThan(0);

  await page.evaluate(() => window.photoStudio.closeSession(window.photoStudio.session, true));
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.name)).toMatch(/keep/);
  expect(await stats(page)).toMatchObject({
    frames: 0,
    bytes: 0,
    decoders: 0,
    sources: 0,
    audioBytes: 0,
  });
});

test('closing a document frees the frame thumbnails of its animation', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#ffffff', 'keep.png');
  await openImage(page, 64, 48, '#336699', 'frames.png');
  await run(page, 'animation.create');
  await run(page, 'animation.new-frame');
  const count = () =>
    page.evaluate(async () =>
      (await import('/src/features/animation/render.ts')).frameImageCount(),
    );
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.evaluate(() => window.photoStudio.closeSession(window.photoStudio.session, true));
  await idle(page);
  expect(await count()).toBe(0);
});
