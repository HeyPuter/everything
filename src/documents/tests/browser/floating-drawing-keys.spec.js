import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Keys with a floating shape or text box selected, as in Word: the drawing is not text that typing replaces.
// Typed text goes into a text box's text, Enter edits it, Tab moves to the next drawing. Each used to delete it.
const input = page => page.getByRole('textbox', { name: 'Document text' });
test.use({ viewport: { width: 1440, height: 900 } });
const state = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model, [a, b] = m.range;
  return { text: m.text.replace(/\n/g, '|'), drawings: m.paragraphs.flatMap(p => p.runs).filter(r => r.image).length, selected: b === a + 1 ? m.text.slice(0, a).split('￼').length - 1 : null };
});
async function start(page) {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 3; i++) { await page.keyboard.type(`Para ${i + 1}.`); await page.keyboard.press('Enter'); }
}
async function drawShape(page, name, from, to) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + from[0], box.y + from[1]); await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
}
const selectDrawing = (page, index = 0) => page.evaluate(index => {
  const e = window.__docs.current.view.engine; let at = -1;
  for (let i = 0; i <= index; i++) at = e.model.text.indexOf('￼', at + 1);
  e.model.select(at, at + 1); e.syncInput(); e.paint(); e.onSelection(); e.focus();
}, index);

test('typing, Space and Enter keep a selected shape, Tab goes from shape to shape, and Ctrl+Enter breaks the page after it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await drawShape(page, 'Rectangle', [300, 120], [460, 220]);
  await drawShape(page, 'Oval', [500, 300], [640, 380]);
  const before = await state(page);
  expect(before.drawings).toBe(2);
  await selectDrawing(page, 0);
  for (const key of ['a', 'Space', 'Enter', 'Shift+Enter']) {
    await page.keyboard.press(key);
    expect(await state(page), key).toEqual({ ...before, selected: 0 });
  }
  await page.keyboard.press('Tab');
  expect((await state(page)).selected).toBe(1);
  await page.keyboard.press('Tab');
  expect((await state(page)).selected).toBe(0);
  await page.keyboard.press('Shift+Tab');
  expect(await state(page)).toEqual({ ...before, selected: 1 });
  await selectDrawing(page, 0);
  await page.keyboard.press('ControlOrMeta+Enter');
  const after = await state(page);
  expect(after.drawings).toBe(2);
  expect(after.text.replace('\f', '')).toBe(before.text);
  expect(after.text.indexOf('\f')).toBe(before.text.indexOf('￼') + 1);
  expect(errors).toEqual([]);
});

test('text typed with a text box selected goes on after its text, in Edit Text, and Enter opens it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').first().press('ControlOrMeta+a');
  await page.keyboard.type('Boxed');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const before = await state(page);
  await selectDrawing(page);
  await page.keyboard.type('Z');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('drawing-text-input')).toBeFocused();
  await expect(dialog.getByTestId('drawing-text-input')).toHaveValue('BoxedZ');
  await page.keyboard.type('Q');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const shell = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).find(r => r.image).image.shell);
  expect(await shell()).toContain('BoxedZQ');
  expect((await state(page)).text).toBe(before.text);
  await selectDrawing(page);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('drawing-text-input')).toHaveValue('BoxedZQ');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(errors).toEqual([]);
});
