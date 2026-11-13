import { expect, test, type Page } from '@playwright/test';
import { boot, compositePixel, idle, menu, openImage, run } from './helpers';

/** A document with a light background and three colored squares as layers. */
async function squares(page: Page) {
  await openImage(page, 120, 80, '#f0f0f0', 'squares.png');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const square = (rgb: number[]) => {
      const data = new Uint8ClampedArray(20 * 20 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
      return { width: 20, height: 20, data };
    };
    const colors = [[220, 0, 0], [0, 200, 0], [0, 0, 220]];
    e.command('Squares', (d) => colors.forEach((c, i) => d.layers.push(newPixelLayer(`Square ${i + 1}`, d, gridFromImage(e.assets.tiles, square(c), 10 + i * 35, 30)))));
  });
  await idle(page);
}
const animation = (page: Page) => page.evaluate(() => window.photoStudio.doc.animation);

test.describe('frame animation', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await page.evaluate(() => localStorage.removeItem('photo-studio-bottom-dock'));
  });

  test('makes frames from layers, plays them and exports an animated GIF', async ({ page }) => {
    await squares(page);
    await menu(page, 'Window', 'Timeline');
    const timeline = page.locator('.panel-body[aria-label="Timeline"]');
    await expect(timeline).toBeVisible();
    await expect(timeline.getByRole('button', { name: 'Make Frames From Layers' })).toBeVisible();
    await run(page, 'animation.frames-from-layers');
    expect((await animation(page))!.frames).toHaveLength(4);
    const frames = timeline.getByRole('option');
    await expect(frames).toHaveCount(4);
    await expect(frames.first()).toHaveAttribute('aria-selected', 'true');
    // Thumbnails render in the background.
    await expect(timeline.locator('.frame-thumb img')).toHaveCount(4, { timeout: 60_000 });

    // Selecting frame 3 shows only its layer (green square).
    await frames.nth(2).click();
    await idle(page);
    expect((await animation(page))!.current).toBe(2);
    expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.visible))).toEqual([false, false, true, false]);
    expect((await compositePixel(page, 55, 40)).slice(0, 3)).toEqual([0, 200, 0]);
    expect((await compositePixel(page, 20, 40))[3]).toBe(0);

    // Delay menu on the frame applies to the selected frames.
    await frames.nth(2).locator('.frame-delay').click();
    await page.locator('.context-menu').getByRole('menuitemcheckbox', { name: '0.5 s' }).click();
    await idle(page);
    expect((await animation(page))!.frames.map((f) => f.delay)).toEqual([100, 100, 500, 100]);

    // Select all frames with Shift-click, then play and stop.
    await frames.nth(0).click();
    await frames.nth(3).click({ modifiers: ['Shift'] });
    await expect(timeline.getByRole('option', { selected: true })).toHaveCount(4);
    await timeline.getByRole('button', { name: 'Play' }).click();
    await expect(timeline.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.waitForFunction(() => document.querySelector('.frame-cell.current')?.getAttribute('data-frame') !== '3', null, { timeout: 10_000 });
    await timeline.getByRole('button', { name: 'Stop' }).click();
    await idle(page);
    await expect(timeline.getByRole('button', { name: 'Play' })).toBeVisible();

    // Export an animated GIF and decode it.
    await page.evaluate(() => void window.photoStudio.runCommand('file.export-animation'));
    const dialog = page.locator('dialog[open].animation-export-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('select[name="loop"]').selectOption('3');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('squares.gif');
    const bytes = [...(await import('node:fs')).readFileSync(await file.path())];
    const decoded = await page.evaluate(async (bytes) => {
      const { decodeGif } = await import('/src/imaging/codecs/gif.ts');
      const d = decodeGif(new Uint8Array(bytes));
      const px = (f: number, x: number, y: number) => Array.from(d.frames[f].rgba.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 4));
      return { n: d.frames.length, delays: d.frames.map((f) => f.delayMs), loop: d.loopCount, red: px(1, 20, 40), green: px(2, 55, 40) };
    }, bytes);
    expect(decoded).toEqual({ n: 4, delays: [100, 100, 500, 100], loop: 2, red: [220, 0, 0, 255], green: [0, 200, 0, 255] });
  });

  test('keeps per-frame positions through undo and saved projects', async ({ page }) => {
    await squares(page);
    await run(page, 'animation.create');
    await run(page, 'animation.new-frame');
    // Move the red square in frame 2 only.
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.selected = e.doc.layers[1].id;
      e.transform.nudge(30, 10);
    });
    await idle(page);
    await run(page, 'animation.first');
    expect(await page.evaluate(() => window.photoStudio.doc.layers[1].transform.x)).toBe(10);
    await run(page, 'animation.next');
    expect(await page.evaluate(() => window.photoStudio.doc.layers[1].transform.x)).toBe(40);
    // Going back to the frame shown before drops the coalesced selection step.
    expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toBe('Nudge layers');
    await run(page, 'animation.first');
    await run(page, 'edit.undo');
    expect((await animation(page))!.current).toBe(1);
    await run(page, 'edit.undo');
    expect((await animation(page))!.frames[1].layers[(await page.evaluate(() => window.photoStudio.doc.layers[1].id))].dx).toBe(0);
    await run(page, 'edit.redo');
    // Round trip through a .photo project.
    const reopened = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { serialize, deserialize } = await import('/src/model/serialization.ts');
      const { document } = await deserialize(await serialize(e.doc, e.assets));
      return document.animation;
    });
    expect(reopened).toEqual(await animation(page));
  });

  test('opens an animated GIF as a frame animation', async ({ page }) => {
    const gif = await page.evaluate(async () => {
      const { encodeGif } = await import('/src/imaging/codecs/gif.ts');
      const frame = (c: number[]) => ({ width: 8, height: 8, data: new Uint8ClampedArray(Array.from({ length: 64 }, () => [...c, 255]).flat()) });
      return Array.from(encodeGif([{ rgba: frame([255, 0, 0]), delayMs: 200 }, { rgba: frame([0, 0, 255]), delayMs: 300 }], { loop: 0 }));
    });
    await page.locator('#file-input').setInputFiles({ name: 'blink.gif', mimeType: 'image/gif', buffer: Buffer.from(gif) });
    const dialog = page.locator('#dialog[open]');
    await expect(dialog.locator('select[name="pages"]')).toHaveValue('animation');
    await dialog.getByRole('button', { name: 'Open' }).click();
    await page.waitForFunction(() => window.photoStudio.session.fileName === 'blink.gif' && !window.photoStudio.busy);
    await idle(page);
    const a = await animation(page);
    expect(a!.frames.map((f) => f.delay)).toEqual([200, 300]);
    expect(a!.loop).toBe(0);
    await expect(page.locator('.panel-body[aria-label="Timeline"] [role="option"]')).toHaveCount(2);
  });

  test('renders a WebM video and imports its frames as an animation', async ({ page }) => {
    test.skip(!(await page.evaluate(() => typeof VideoEncoder !== 'undefined')), 'WebCodecs video encoding is unavailable');
    await squares(page);
    await run(page, 'animation.frames-from-layers');
    await page.evaluate(() => void window.photoStudio.runCommand('file.render-video'));
    const dialog = page.locator('dialog[open].animation-export-dialog');
    await dialog.locator('select[name="fps"]').selectOption('25');
    await dialog.locator('select[name="codec"]').selectOption('vp8');
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Render' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('squares.webm');
    const bytes = (await import('node:fs')).readFileSync(await file.path());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    // 4 frames × 100 ms at 25 fps = 10 video frames; import every 2nd one.
    await page.evaluate(async (bytes) => {
      void window.photoStudio.runCommand('file.import-video-frames', new File([new Uint8Array(bytes)], 'squares.webm', { type: 'video/webm' }));
    }, [...bytes]);
    const imp = page.locator('dialog[open].animation-export-dialog');
    await expect(imp).toBeVisible({ timeout: 30_000 });
    await imp.locator('input[name="fps"]').fill('25');
    await imp.locator('select[name="step"]').selectOption('2');
    await imp.getByRole('button', { name: 'Import' }).click();
    await page.waitForFunction(() => window.photoStudio.session.fileName === 'squares.webm' && !window.photoStudio.busy, null, { timeout: 60_000 });
    await idle(page);
    const a = await animation(page);
    expect(a!.frames.length).toBe(5);
    expect(a!.frames.every((f) => f.delay === 80)).toBe(true);
  });
});
