import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A shape keeps its rotation in its own transform (a:xfrm rot), not on the picture frame. Its selection
// frame turns with it, as a picture's does, and its handles resize it along its own sides.
const input = page => page.getByRole('textbox', { name: 'Document text' });
async function drawShape(page, name, from, to) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + from[0], box.y + from[1]); await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
}
const shape = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, image = e.model.selectedImage;
  const f = e.selectionLayout.floatingObjects.find(f => f.image === image);
  return { width: Math.round(image.width / 9525), height: Math.round(image.height / 9525), rotation: Number((/<a:xfrm[^>]* rot="(\d+)"/.exec(image.shell) || [])[1] || 0), x: f.x, y: f.y };
});
const overlay = page => page.evaluate(() => { const o = document.querySelector('.canvas-image-frame'); return { width: o.offsetWidth, height: o.offsetHeight, transform: o.style.transform }; });

test('a rotated shape’s frame turns with it and its handles resize it along its own sides', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shape sits on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 200], [500, 260]);
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate Right 90°' }).click();
  await expect.poll(async () => (await shape(page)).rotation).toBe(5400000);
  const before = await shape(page);
  expect([before.width, before.height]).toEqual([200, 60]);
  // The frame stands upright over the turned shape (200 × 60, turned a quarter).
  expect(await overlay(page)).toEqual({ width: 200, height: 60, transform: 'rotate(90deg)' });
  // Turned a quarter, the shape's right side ("e") is at the bottom: dragging it down 50 px lengthens the
  // shape by 50 px, and its top (the other end) stays where it was on the page.
  const handle = await page.locator('.canvas-image-frame [data-handle="e"]').boundingBox();
  const canvas = await page.locator('canvas.canvas-page').first().boundingBox();
  expect(Math.abs(handle.y + handle.height / 2 - canvas.y - (before.y + before.height / 2 + before.width / 2))).toBeLessThan(3);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 50, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => (await shape(page)).width).toBe(250);
  const after = await shape(page);
  expect(after.height).toBe(60);
  const top = s => s.y + s.height / 2 - s.width / 2, left = s => s.x + s.width / 2 - s.height / 2;
  expect(top(after)).toBeCloseTo(top(before), 1);
  expect(left(after)).toBeCloseTo(left(before), 1);
  expect(await overlay(page)).toEqual({ width: 250, height: 60, transform: 'rotate(90deg)' });
  expect(errors).toEqual([]);
});

test('arrow keys on a shape’s side handle move that side only, as dragging it does', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shape sits on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 200], [500, 260]);
  const before = await shape(page);
  expect([before.width, before.height]).toEqual([200, 60]);
  // Shift+Right on the right handle: 10 px wider, no taller, the left side where it was.
  await page.locator('.canvas-image-frame [data-handle="e"]').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await shape(page)).width).toBe(210);
  let now = await shape(page);
  expect(now.height).toBe(60);
  expect(now.x).toBeCloseTo(before.x, 1);
  // Shift+Up on the top handle: 10 px taller upwards, the bottom where it was.
  await page.locator('.canvas-image-frame [data-handle="n"]').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(async () => (await shape(page)).height).toBe(70);
  now = await shape(page);
  expect(now.width).toBe(210);
  expect(now.y + now.height).toBeCloseTo(before.y + before.height, 1);
  expect(errors).toEqual([]);
});

test('a rotated shape is selected where it shows, not where its unrotated outline would be', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text.`); await page.keyboard.press('Enter'); }
  // 200 × 60 px around (600, 330), turned a quarter: it shows 60 wide and 200 tall, from y = 230 to 430.
  await drawShape(page, 'Rectangle', [500, 300], [700, 360]);
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate Right 90°' }).click();
  await expect.poll(async () => (await shape(page)).rotation).toBe(5400000);
  const canvas = await page.locator('canvas.canvas-page').first().boundingBox();
  const selected = () => page.evaluate(() => window.__docs.current.view.engine.model.selectedImage?.name ?? null);
  const click = async (x, y) => { await page.mouse.click(canvas.x + 150, canvas.y + 640); await expect.poll(selected).toBe(null); await page.mouse.click(canvas.x + x, canvas.y + y); };
  await click(600, 250);
  await expect.poll(selected).toBe('Rectangle 1');
  await click(600, 415);
  await expect.poll(selected).toBe('Rectangle 1');
  // Beside it, inside the outline it had before it turned: the text, not the shape.
  await click(520, 330);
  await page.waitForTimeout(200);
  expect(await selected()).toBe(null);
  expect(errors).toEqual([]);
});

test('Align Left and Align Top line up a rotated shape’s visible edges with the margins', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [400, 300], [600, 360]);
  await onTab(page, 'shapeFormat');
  const panel = page.locator('#ribbon-panel-shapeFormat');
  await panel.getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate Right 90°' }).click();
  await expect.poll(async () => (await shape(page)).rotation).toBe(5400000);
  const margins = await page.evaluate(() => { const p = window.__docs.current.view.engine.layout.pages[0]; return { left: p.left, top: p.top }; });
  for (const name of ['Align Left', 'Align Top']) {
    await panel.getByRole('button', { name: 'Align', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  // Turned a quarter, the 200 × 60 shape shows 60 wide and 200 tall about its center.
  await expect.poll(async () => { const s = await shape(page); return Math.round(s.x + s.width / 2 - s.height / 2); }).toBe(Math.round(margins.left));
  const s = await shape(page);
  expect(s.y + s.height / 2 - s.width / 2).toBeCloseTo(margins.top, 0);
  expect(errors).toEqual([]);
});
