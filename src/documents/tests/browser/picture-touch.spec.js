import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
const PNG = readFileSync('icon-128.png');

// With a picture selected, a finger elsewhere still scrolls (it used to move the caret there and bring up the
// keyboard), and a finger on the selected picture moves it, even straight down (the pages used to scroll instead).
// A finger that starts on a picture not yet selected may still scroll.
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(Array.from({ length: 80 }, (_, i) => `Paragraph ${i} of text around the picture.`).join('\n'));
    e.relayout(); e.model.select(30); e.syncInput();
  });
  await page.locator('#ribbon-tab-insert').tap();
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.input.blur(); e.host.scrollTop = 0; });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 1, radiusY: 1 }] });
  const drag = async (x, y, dy) => {
    await touch('touchStart', x, y);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', x, y + i * dy / 10); await page.waitForTimeout(16); }
    await touch('touchEnd');
  };
  return drag;
}
const state = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { range: [...e.model.range], picture: e.model.text.indexOf('￼'), selected: !!e.model.selectedImage, top: Math.round(e.host.scrollTop), focused: document.activeElement === e.input };
});

test('with a picture selected, a finger elsewhere scrolls and leaves the selection and keyboard alone', async ({ page }) => {
  const drag = await open(page);
  const before = await state(page);
  expect(before).toMatchObject({ selected: true, focused: false });
  const host = await page.locator('.canvas-host').boundingBox();
  await drag(host.x + host.width / 2, host.y + host.height - 40, -200);
  await expect.poll(async () => (await state(page)).top).toBeGreaterThan(50);
  expect(await state(page)).toMatchObject({ range: before.range, selected: true, focused: false });
});

test('a finger drags the selected picture straight down to another place in the text', async ({ page }) => {
  const drag = await open(page);
  const before = await state(page);
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  await drag(frame.x + frame.width / 2, frame.y + frame.height / 2, 150);
  await expect.poll(async () => (await state(page)).picture).toBeGreaterThan(before.picture + 20);
  expect((await state(page)).top).toBe(before.top);
});

test('a finger that starts on a picture not yet selected may scroll the pages', async ({ page }) => {
  const drag = await open(page);
  const frame = await page.locator('.canvas-image-frame').boundingBox();
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0); e.syncInput(); e.input.blur(); });
  await expect(page.locator('.canvas-image-frame')).toBeHidden();
  const before = await state(page);
  expect(before).toMatchObject({ selected: false, top: 0 });
  await drag(frame.x + frame.width / 2, frame.y + frame.height / 2, -200);
  await expect.poll(async () => (await state(page)).top).toBeGreaterThan(50);
  expect((await state(page)).picture).toBe(before.picture);
});
