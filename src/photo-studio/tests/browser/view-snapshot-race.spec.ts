import { expect, test } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, tool } from './helpers';

for (const refreshDuringCapture of [false, true]) test(`a delayed inactive snapshot keeps its document revision (${refreshDuringCapture ? 'refresh during capture' : 'refresh after capture'})`, async ({ page }) => {
  await boot(page);
  await openImage(page, 100, 100, '#ff0000', 'inactive.png');
  const inactive = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 100, 100, '#ffffff', 'active.png');
  await run(page, 'window.tile-all');
  const preview = page.locator('canvas.view-preview');
  const center = () => preview.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data));
  await expect.poll(center).toEqual([255, 0, 0, 255]);
  await page.evaluate(async (id) => {
    const e = window.photoStudio;
    await e.windows.ensureSnapshots();
    const s = e.sessions.find((s) => s.id === id)!;
    const { layer } = await import('/src/model/document.ts');
    const green = layer('solid', 'Green', 100, 100);
    green.color = '#00ff00';
    s.history.reset({ ...s.doc, layers: [green] });
    const draw = e.renderer.drawFrame;
    e.renderer.drawFrame = async function (...args) {
      e.renderer.drawFrame = draw;
      await new Promise<void>((resolve) => Object.assign(window, { releaseSnapshot: resolve }));
      return draw.apply(this, args);
    };
    void e.windows.ensureSnapshots().then(() => Object.assign(window, { firstSnapshotDone: true }));
  }, inactive);
  await page.waitForFunction(() => !!(window as unknown as { releaseSnapshot?: () => void }).releaseSnapshot);
  await page.evaluate(({ id, refreshDuringCapture }) => {
    const e = window.photoStudio;
    const s = e.sessions.find((s) => s.id === id)!;
    s.history.reset({ ...s.doc, layers: s.doc.layers.map((l) => ({ ...l, color: '#0000ff' })) });
    if (refreshDuringCapture) void e.windows.ensureSnapshots();
    (window as unknown as { releaseSnapshot(): void }).releaseSnapshot();
  }, { id: inactive, refreshDuringCapture });
  await page.waitForFunction(() => !!(window as unknown as { firstSnapshotDone?: boolean }).firstSnapshotDone);
  if (!refreshDuringCapture) await page.evaluate(() => window.photoStudio.windows.ensureSnapshots());
  await idle(page);
  await expect.poll(center, { timeout: 5000 }).toEqual([0, 0, 255, 255]);
});

test('a font arriving during an inactive render does not mark fallback pixels as current', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 180, '#ffffff', 'text.png');
  const text = await page.evaluate(() => window.photoStudio.session.id);
  await tool(page, 'Horizontal Type Tool');
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Caveat';
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseSnapshotFont: resolve })).then(() => load.call(this));
    };
  });
  await canvasClick(page, 30, 70);
  await page.keyboard.type('Late font');
  await page.keyboard.press('Escape');
  await idle(page);
  await openImage(page, 300, 180, '#ffffff', 'active.png');
  await run(page, 'window.tile-all');
  await page.evaluate(() => window.photoStudio.windows.ensureSnapshots());
  const preview = page.locator('canvas.view-preview');
  const before = await preview.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await page.evaluate(async (id) => {
    const e = window.photoStudio;
    const s = e.sessions.find((s) => s.id === id)!;
    s.history.reset({ ...s.doc });
    const textId = s.doc.layers.at(-1)!.id;
    const r = e.renderer as unknown as { drawLayer: (...args: unknown[]) => Promise<unknown> };
    const draw = r.drawLayer;
    r.drawLayer = async function (...args) {
      const result = await draw.apply(this, args);
      if ((args[0] as { id: string }).id === textId) {
        r.drawLayer = draw;
        // The fallback glyphs are already drawn; hold the rest of this frame.
        await new Promise<void>((resolve) => Object.assign(window, { releaseTextFrame: resolve }));
      }
      return result;
    };
    void e.windows.ensureSnapshots().then(() => Object.assign(window, { textSnapshotDone: true }));
  }, text);
  await page.waitForFunction(() => !!(window as unknown as { releaseTextFrame?: () => void }).releaseTextFrame);
  await page.evaluate(async () => {
    (window as unknown as { releaseSnapshotFont(): void }).releaseSnapshotFont();
    const { ensureFont } = await import('/src/imaging/text/fonts.ts');
    await ensureFont('Caveat');
    (window as unknown as { releaseTextFrame(): void }).releaseTextFrame();
  });
  await page.waitForFunction(() => !!(window as unknown as { textSnapshotDone?: boolean }).textSnapshotDone);
  await idle(page);
  await expect.poll(async () => (await preview.evaluate((c: HTMLCanvasElement) => c.toDataURL())) !== before, { timeout: 5000 }).toBe(true);
});

test('unchanged snapshots do no work and failed captures can be retried', async ({ page }) => {
  await boot(page);
  await openImage(page, 100, 100, '#ff0000', 'inactive.png');
  const inactive = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 100, 100, '#ffffff', 'active.png');
  await run(page, 'window.tile-all');
  expect(await page.evaluate(async (id) => {
    const e = window.photoStudio;
    await e.windows.ensureSnapshots();
    let calls = 0;
    const draw = e.renderer.drawFrame;
    e.renderer.drawFrame = async function (...args) {
      calls++;
      if (calls === 1) throw new Error('Snapshot fixture failure');
      return draw.apply(this, args);
    };
    for (let i = 0; i < 5; i++) await e.windows.ensureSnapshots();
    const unchanged = calls;
    const { layer } = await import('/src/model/document.ts');
    const blue = layer('solid', 'Blue', 100, 100);
    blue.color = '#0000ff';
    const s = e.sessions.find((s) => s.id === id)!;
    s.history.reset({ ...s.doc, layers: [blue] });
    await e.windows.ensureSnapshots();
    const failed = calls;
    await e.windows.ensureSnapshots();
    await e.windows.ensureSnapshots();
    e.renderer.drawFrame = draw;
    return { unchanged, failed, retried: calls };
  }, inactive)).toEqual({ unchanged: 0, failed: 1, retried: 2 });
  const preview = page.locator('canvas.view-preview');
  await expect.poll(() => preview.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data))).toEqual([0, 0, 255, 255]);
});
