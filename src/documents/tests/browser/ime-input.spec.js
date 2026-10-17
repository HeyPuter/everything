import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const state = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { text: e.model.text, range: [...e.model.range], composing: !!e.composition, focused: document.activeElement === e.input };
});

test('a click during IME composition commits it, places the caret and keeps the keyboard in the document', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Hello world');
  await input(page).press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  expect(await state(page)).toMatchObject({ text: 'Hello world你', composing: true });
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const at = await page.evaluate(() => { const e = window.__docs.current.view.engine, line = e.selectionLayout.lines[0]; return { x: line.stops.find(s => s.offset === 2).x * e.zoom, y: (line.y + line.height / 2) * e.zoom }; });
  await page.mouse.click(box.x + at.x, box.y + at.y);
  expect(await state(page)).toEqual({ text: 'Hello world你', range: [2, 2], composing: false, focused: true });
  await page.keyboard.type('Z');
  await expect(input(page)).toHaveValue('HeZllo world你');
  // The composed text and the typing after it are separate undo steps.
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Hello world你');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Hello world');
});
