import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, tool } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');

async function prepare(page: Page) {
  await boot(page);
  await openImage(page, 300, 180, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 300, 180, '#ffffff', 'text.png');
  await tool(page, 'Horizontal Type Tool');
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Caveat';
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { finishRenderFont: resolve })).then(() => load.call(this));
    };
  });
  await canvasClick(page, 30, 70);
  await page.keyboard.type('Visible text');
  await page.keyboard.press('Escape');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return other;
}

test('a stalled font does not hold the canvas renderer indefinitely', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    void window.photoStudio.renderer.settle().then(() => Object.assign(window, { textRenderSettled: true }));
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { textRenderSettled?: boolean }).textRenderSettled), { timeout: 6000 }).toBe(true);
  expect(await page.evaluate(async () => {
    const e = window.photoStudio;
    const pixels = await e.renderer.documentPixels(e.doc, e.assets);
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128 && pixels[i + 3] > 128) ink++;
    return ink;
  })).toBeGreaterThan(20);
});

test('discarding text with a stalled font completes document closing', async ({ page }) => {
  const other = await prepare(page);
  await page.locator('.document-tab.focused .tab-close').click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Don’t Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.session.id), { timeout: 6000 }).toBe(other);
});

async function settled(page: Page) {
  await page.evaluate(() => {
    Object.assign(window, { textRenderSettled: false });
    void window.photoStudio.renderer.settle().then(() => Object.assign(window, { textRenderSettled: true }));
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { textRenderSettled?: boolean }).textRenderSettled), { timeout: 6000 }).toBe(true);
}

async function finishFont(page: Page) {
  await page.evaluate(async () => {
    (window as unknown as { finishRenderFont(): void }).finishRenderFont();
    const { ensureFont } = await import('/src/imaging/text/fonts.ts');
    await ensureFont('Caveat');
  });
  await idle(page);
}

for (const styled of [false, true]) test(`late fonts redraw committed ${styled ? 'styled' : 'plain'} text and refresh cached pixels`, async ({ page }) => {
  await prepare(page);
  if (styled) await page.evaluate(async () => {
    const { defaultDropShadow } = await import('/src/imaging/effects/types.ts');
    window.photoStudio.command('Text shadow', (d) => { d.layers.at(-1)!.style = { dropShadow: [defaultDropShadow()] }; });
  });
  await settled(page);
  await idle(page);
  const before = await page.locator('#canvas').screenshot();
  await page.evaluate(() => {
    Object.assign(window, { fontFrames: 0 });
    window.photoStudio.renderer.frameListeners.add(() => (window as unknown as { fontFrames: number }).fontFrames++);
  });
  await finishFont(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { fontFrames: number }).fontFrames), { timeout: 6000 }).toBeGreaterThan(0);
  expect(await page.locator('#canvas').screenshot()).not.toEqual(before);
  // Cached text and its effects must match a freshly rendered copy with new IDs.
  expect(await page.evaluate(async () => {
    const e = window.photoStudio;
    const cached = await e.renderer.documentPixels(e.doc, e.assets);
    const fresh = await e.renderer.documentPixels({ ...e.doc, layers: e.doc.layers.map((l) => ({ ...l, id: crypto.randomUUID() })) }, e.assets);
    return cached.every((n, i) => n === fresh[i]);
  })).toBe(true);
});

test('subsequent text renders do not repeat the stalled download wait', async ({ page }) => {
  await prepare(page);
  await settled(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.command('Move text', (d) => { d.layers.at(-1)!.textData!.origin.x += 10; });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    Object.assign(window, { secondRenderSettled: false });
    void e.renderer.settle().then(() => Object.assign(window, { secondRenderSettled: true }));
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { secondRenderSettled?: boolean }).secondRenderSettled), { timeout: 1500 }).toBe(true);
});

test('a late font refreshes text in an inactive tiled document', async ({ page }) => {
  const other = await prepare(page);
  await settled(page);
  await run(page, 'window.tile-all');
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await idle(page);
  await page.evaluate(() => window.photoStudio.windows.ensureSnapshots());
  const preview = page.locator('canvas.view-preview');
  await expect(preview).toHaveCount(1);
  const before = await preview.evaluate((el: HTMLCanvasElement) => el.toDataURL());
  await finishFont(page);
  await expect.poll(async () => (await preview.evaluate((el: HTMLCanvasElement) => el.toDataURL())) !== before).toBe(true);
});

test('a late font refreshes cached animation thumbnails', async ({ page }) => {
  await prepare(page);
  await settled(page);
  await page.evaluate(async () => {
    const { createAnimation } = await import('/src/model/animation.ts');
    window.photoStudio.command('Animation', (d) => { d.animation = createAnimation(d); });
  });
  const thumbnail = () => page.evaluate(async () => {
    const { frameImage } = await import('/src/features/animation/render.ts');
    const e = window.photoStudio;
    return frameImage(e, e.doc, 0)?.url;
  });
  await expect.poll(thumbnail).toBeTruthy();
  const before = await thumbnail();
  await finishFont(page);
  await expect.poll(async () => { const after = await thumbnail(); return !!after && after !== before; }).toBe(true);
});
