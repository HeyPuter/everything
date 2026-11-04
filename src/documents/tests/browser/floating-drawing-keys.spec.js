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

test('text pasted, or a date inserted, with a shape selected goes after its anchor and keeps the shape', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await drawShape(page, 'Rectangle', [300, 120], [460, 220]);
  const before = await state(page), anchor = before.text.indexOf('￼');
  await page.evaluate(() => navigator.clipboard.writeText('pasted'));
  await selectDrawing(page);
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(async () => (await state(page)).text).toBe(before.text.slice(0, anchor + 1) + 'pasted' + before.text.slice(anchor + 1));
  expect((await state(page)).drawings).toBe(1);
  await selectDrawing(page);
  await page.keyboard.press('Alt+Shift+D');
  await expect.poll(async () => (await state(page)).text.length).toBeGreaterThan(before.text.length + 'pasted'.length);
  const after = await state(page);
  expect(after.drawings).toBe(1);
  expect(after.text.slice(0, anchor + 1)).toBe(before.text.slice(0, anchor + 1));
  expect(errors).toEqual([]);
});

test('an input method composing with a shape selected writes after its anchor and keeps the shape', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await drawShape(page, 'Rectangle', [300, 120], [460, 220]);
  const before = await state(page), anchor = before.text.indexOf('￼');
  await selectDrawing(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '火', selectionStart: 1, selectionEnd: 1 });
  expect(await state(page)).toMatchObject({ drawings: 1, text: before.text.slice(0, anchor + 1) + '火' + before.text.slice(anchor + 1) });
  // Over a drawing's character the browser commits each update and starts again: the drawing stays all along.
  await cdp.send('Input.imeSetComposition', { text: '山', selectionStart: 1, selectionEnd: 1 });
  await page.evaluate(() => window.__docs.current.view.engine.finishComposition());
  const after = await state(page);
  expect(after.drawings).toBe(1);
  expect(after.text).toMatch(new RegExp(`^${before.text.slice(0, anchor + 1).replace(/[.|]/g, '\\$&')}火?山`));
  expect(after.text.endsWith(before.text.slice(anchor + 1))).toBe(true);
  // One undo takes the composed text back and leaves the shape.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state(page)).text).toBe(before.text);
  expect(errors).toEqual([]);
});

test('an emoji or other text inserted without keys into a selected text box goes into its text', async ({ page }) => {
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
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.insertText', { text: '😀' });
  await expect(dialog.getByTestId('drawing-text-input')).toHaveValue('Boxed😀');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await state(page)).toMatchObject({ text: before.text, drawings: 1 });
  expect(errors).toEqual([]);
});
