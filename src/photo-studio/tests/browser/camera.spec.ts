import { test, expect, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, compositePixel, idle, openImage, start } from './helpers';

// A fake camera: Chrome's fake capture device playing a Y4M clip whose frame
// is red on the left half and blue on the right (the permission is granted
// by the fake UI flag, so no prompt appears).
function y4m(width = 320, height = 240) {
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`);
  const y = Buffer.alloc(width * height),
    u = Buffer.alloc((width / 2) * (height / 2)),
    v = Buffer.alloc((width / 2) * (height / 2));
  // Full-range BT.601: red (76, 85, 255), blue (29, 255, 107).
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) y[j * width + i] = i < width / 2 ? 76 : 29;
  for (let j = 0; j < height / 2; j++)
    for (let i = 0; i < width / 2; i++) {
      u[j * (width / 2) + i] = i < width / 4 ? 85 : 255;
      v[j * (width / 2) + i] = i < width / 4 ? 255 : 107;
    }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, u, v]);
  return Buffer.concat([header, frame, frame]);
}
const clip = join(tmpdir(), `photo-studio-camera-${process.pid}.y4m`);
writeFileSync(clip, y4m());
test.use({
  launchOptions: {
    ...(process.env.PW_CHROME_PATH ? { executablePath: process.env.PW_CHROME_PATH } : { channel: 'chrome' }),
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${clip}`],
  },
});
const near = (px: number[], rgb: [number, number, number]) => px.slice(0, 3).every((v, i) => Math.abs(v - rgb[i]) < 40) && px[3] === 255;

async function capture(page: Page, opts: { mirror: boolean; burst: string; target: 'document' | 'layer'; countdown?: string }) {
  await start(page, 'file.import-device');
  const dialog = page.locator('dialog.camera-dialog');
  await expect(dialog).toBeVisible();
  const button = dialog.getByRole('button', { name: 'Capture' });
  await expect(button).toBeEnabled();
  await expect(dialog.locator('.camera-size')).toHaveText('Captures 320 × 240 px.');
  expect(await dialog.locator('select[name="device"] option').count()).toBeGreaterThanOrEqual(2);
  await dialog.locator('input[name="mirror"]').setChecked(opts.mirror);
  await dialog.locator('select[name="burst"]').selectOption(opts.burst);
  await dialog.locator('select[name="countdown"]').selectOption(opts.countdown ?? '0');
  await dialog.locator(`input[name="target"][value="${opts.target}"]`).check();
  await button.click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await idle(page);
}

test.describe('Images from Device', () => {
  test('captures a mirrored shot into a new document and a burst as layers of the current one', async ({ page }) => {
    await boot(page);
    await capture(page, { mirror: true, burst: '1', target: 'document', countdown: '3' });
    const doc = await page.evaluate(() => ({ w: window.photoStudio.doc.width, h: window.photoStudio.doc.height, layers: window.photoStudio.doc.layers.length, name: window.photoStudio.session.fileName }));
    expect(doc).toMatchObject({ w: 320, h: 240, layers: 1 });
    expect(doc.name).toMatch(/^Camera .*\.png$/);
    // Mirrored: blue on the left.
    expect(near(await compositePixel(page, 20, 120), [0, 0, 255])).toBe(true);
    expect(near(await compositePixel(page, 300, 120), [255, 0, 0])).toBe(true);
    // Recorded as captured in the provenance record.
    await page.evaluate(() => window.photoStudio.dock.show('provenance'));
    await expect(page.locator('.panel-body[aria-label="Provenance"] .prov-summary')).toContainText('camera capture');

    // A burst of three, unmirrored, into a new document: one layer per shot.
    await capture(page, { mirror: false, burst: '3', target: 'document' });
    expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual(['Shot 1', 'Shot 2', 'Shot 3']);
    expect(near(await compositePixel(page, 20, 120), [255, 0, 0])).toBe(true);

    // Into the current document as embedded objects.
    await openImage(page, 640, 480, '#ffffff', 'base.png');
    await capture(page, { mirror: false, burst: '3', target: 'layer' });
    const layers = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.kind, !!l.embed]));
    expect(layers).toEqual([['pixel', false], ['image', true], ['image', true], ['image', true]]);
    expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Capture Burst');
    expect(await page.evaluate(() => window.photoStudio.selectedLayers.length)).toBe(3);
  });

  test('explains a refused camera and closes cleanly', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')), enumerateDevices: async () => [] },
      });
    });
    await boot(page);
    await start(page, 'file.import-device');
    const dialog = page.locator('dialog.camera-dialog');
    await expect(dialog.locator('.camera-status')).toContainText('not allowed');
    await expect(dialog.getByRole('button', { name: 'Capture' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await idle(page);
  });
});
