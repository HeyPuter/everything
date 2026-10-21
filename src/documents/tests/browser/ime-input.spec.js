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

test('a toolbar command during IME composition commits it and applies instead of being dropped', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Hello world');
  await input(page).press('End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await cdp.send('Input.insertText', { text: '你' });
  await page.keyboard.type('x');
  await expect(input(page)).toHaveValue('Hello world你x');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, !!r.bold])))
    .toEqual([['Hello world你', false], ['x', true]]);
  // Undo from the toolbar during a composition commits it too, then takes back the last step.
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input(page)).toHaveValue('Hello world你x');
  expect(await state(page)).toMatchObject({ composing: false, focused: true });
});

test('with Track Changes on, text composed over a selection leaves the caret after it', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Hello world again');
  await input(page).press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(() => !!window.__docs.current.view.engine.model.trackChanges)).toBe(true);
  await input(page).evaluate(el => { el.setSelectionRange(6, 11); el.dispatchEvent(new Event('select')); });
  const cdp = await page.context().newCDPSession(page);
  for (const text of ['n', 'ni', '你好']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp.send('Input.insertText', { text: '你好' });
  // The replaced word stays, struck out, before the composed text; typing goes on after that text.
  await page.keyboard.type('X');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, r.revision?.type || null])))
    .toEqual([['Hello ', null], ['world', 'del'], ['你好', 'ins'], ['X', 'ins'], [' again', null]]);
  expect(await state(page)).toMatchObject({ text: 'Hello world你好X again', range: [14, 14], composing: false });
});
