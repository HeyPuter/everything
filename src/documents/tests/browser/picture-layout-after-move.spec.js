import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { onTab } from './helpers/editor-tools.js';

// A formatted picture keeps the drawing XML it was given, and later moves, turns and flips are made on
// the model. The Layout dialog, Rotate and Flip read the picture as it is now, so OK in Layout leaves a
// moved picture where it was put, and Rotate turns from the picture's present angle.
const PNG = readFileSync('icon-128.png');
const input = page => page.getByRole('textbox', { name: 'Document text' });
const picture = page => page.evaluate(() => {
  const i = window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  return { x: i.anchor?.x, y: i.anchor?.y, wrap: i.anchor?.wrap, rotation: i.rotation || 0, flipH: !!i.flipH };
});

test('Layout, Rotate and Flip start from where a floating picture was moved and how it was turned', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await page.keyboard.type('Pictures sit beside this paragraph of text. '.repeat(8));
  await input(page).press('ControlOrMeta+Home');
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  const panel = page.locator('#ribbon-panel-picture');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Wrap Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'In Front of Text' }).click();
  await expect.poll(async () => (await picture(page)).wrap).toBe('none');
  const start = await picture(page);

  // Arrow keys move the selected picture 1 px a press.
  for (let i = 0; i < 20; i++) await input(page).press('ArrowRight');
  for (let i = 0; i < 10; i++) await input(page).press('ArrowDown');
  const moved = await picture(page);
  expect(moved.x - start.x).toBe(20 * 9525);
  expect(moved.y - start.y).toBe(10 * 9525);
  await panel.getByRole('button', { name: 'Size and Position…', exact: true }).click();
  const layout = page.getByRole('dialog', { name: 'Layout' });
  await expect(layout.getByLabel('Horizontal absolute position (in)')).toHaveValue(String(Math.round(moved.x / 914400 * 100) / 100));
  await layout.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(layout).toBeHidden();
  expect(await picture(page)).toMatchObject({ x: moved.x, y: moved.y });

  // Turned on the model (as the rotation handle does), then Rotate Right 90° and Flip Horizontal.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.execute(() => e.model.setImageProperties({ rotation: 30 * 60000 })); });
  await panel.getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rotate Right 90°' }).click();
  await expect.poll(async () => (await picture(page)).rotation).toBe(120 * 60000);
  expect(await picture(page)).toMatchObject({ x: moved.x, y: moved.y });
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.execute(() => e.model.setImageProperties({ flipH: true })); });
  await panel.getByRole('button', { name: 'Rotate', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Flip Horizontal' }).click();
  await expect.poll(async () => (await picture(page)).flipH).toBe(false);
  expect(errors).toEqual([]);
});
