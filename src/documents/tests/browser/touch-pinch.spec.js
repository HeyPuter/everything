import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 740 } });

// One finger scrolls the pages up and down, and a sideways drag selects; two fingers pinch the zoom and carry the
// pages in any direction, which is how a page zoomed wider than a phone is moved sideways.
async function open(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeAttached();
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine)).toBe(true);
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    e.model.replace(Array.from({ length: 80 }, (_, i) => `Paragraph number ${i} of the long document`).join('\n'));
    e.relayout(); e.model.select(0); e.syncInput(); e.input.blur(); e.host.scrollTop = 0;
  });
  const cdp = await page.context().newCDPSession(page);
  const fingers = async (type, points) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await page.waitForTimeout(16);
  };
  return fingers;
}
const state = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { zoom: e.zoom, left: e.host.scrollLeft, top: e.host.scrollTop, range: [...e.model.range], focused: document.activeElement === e.input };
});

test('pinching out zooms in about the fingers without selecting or bringing up the keyboard', async ({ page }) => {
  const fingers = await open(page);
  const before = await state(page);
  expect(before.zoom).toBeLessThan(0.5); // Fit width on a phone
  await fingers('touchStart', [[180, 400]]);
  await fingers('touchStart', [[180, 400], [180, 440]]);
  for (let i = 1; i <= 10; i++) await fingers('touchMove', [[180 - i * 3, 400 - i * 3], [180 + i * 3, 440 + i * 3]]);
  await fingers('touchEnd', []);
  const after = await state(page);
  expect(after.zoom).toBeGreaterThan(before.zoom * 1.5);
  expect(after).toMatchObject({ range: [0, 0], focused: false });
  await expect(page.getByRole('combobox', { name: 'Zoom' })).not.toHaveValue('fit');
  // Pinching in zooms back out.
  await fingers('touchStart', [[120, 360], [240, 520]]);
  for (let i = 1; i <= 10; i++) await fingers('touchMove', [[120 + i * 5, 360 + i * 7], [240 - i * 5, 520 - i * 7]]);
  await fingers('touchEnd', []);
  expect((await state(page)).zoom).toBeLessThan(after.zoom * 0.6);
});

test('two fingers move a zoomed page sideways, where one finger would select', async ({ page }) => {
  const fingers = await open(page);
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
  await page.evaluate(() => window.__docs.current.view.engine.input.blur());
  const before = await state(page);
  expect(before.left).toBeGreaterThan(100);
  await fingers('touchStart', [[150, 400], [210, 400]]);
  for (let i = 1; i <= 10; i++) await fingers('touchMove', [[150 + i * 10, 400], [210 + i * 10, 400]]);
  await fingers('touchEnd', []);
  const after = await state(page);
  expect(before.left - after.left).toBeGreaterThan(80);
  expect(after).toMatchObject({ zoom: 1, range: before.range, focused: false });
  // A tap afterwards still places the caret.
  await page.touchscreen.tap(180, 400);
  await expect.poll(async () => (await state(page)).focused).toBe(true);
  expect((await state(page)).range[0]).toBeGreaterThan(0);
});
