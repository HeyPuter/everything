import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
async function blank(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
}

test('undo removes typed text a word at a time and redo restores it', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('Quick brown fox, jumps.');
  const undo = () => input(page).press('ControlOrMeta+z');
  await undo(); await expect(input(page)).toHaveValue('Quick brown fox, ');
  await undo(); await expect(input(page)).toHaveValue('Quick brown ');
  await page.keyboard.press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue('Quick brown fox, ');
  await undo(); await undo(); await expect(input(page)).toHaveValue('Quick ');
  await undo(); await expect(input(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a caret move, another edit or a new paragraph starts a new undo step', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('Alpha');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight');
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Gamma');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('a');
  const undo = () => input(page).press('ControlOrMeta+z');
  await undo(); await expect(input(page)).toHaveValue('Alphabeta\nGamm');
  await undo(); await expect(input(page)).toHaveValue('Alphabeta\nGamma');
  await undo(); await expect(input(page)).toHaveValue('Alphabeta\n');
  await undo(); await expect(input(page)).toHaveValue('Alphabeta');
  await undo(); await expect(input(page)).toHaveValue('Alpha');
  // A selection replaced by typing comes back whole.
  await input(page).evaluate(el => { el.setSelectionRange(0, 5); el.dispatchEvent(new Event('select')); });
  await page.keyboard.type('Omega');
  await expect(input(page)).toHaveValue('Omega');
  await undo(); await expect(input(page)).toHaveValue('Alpha');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);
});

test('a run of Backspace or Delete presses undoes in one step', async ({ page }) => {
  await blank(page);
  await input(page).fill('Hello brave world');
  await input(page).press('End');
  for (let i = 0; i < 8; i++) await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('Hello bra');
  await input(page).press('Home');
  for (let i = 0; i < 3; i++) await input(page).press('Delete');
  await expect(input(page)).toHaveValue('lo bra');
  await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('Hello bra');
  await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('Hello brave world');
  await input(page).press('ControlOrMeta+Shift+z'); await expect(input(page)).toHaveValue('Hello bra');
});

test('in Text mode a run of Backspace or Delete presses also undoes in one step', async ({ page }) => {
  await blank(page);
  await page.getByRole('checkbox', { name: 'Text mode', exact: true }).check();
  await input(page).focus();
  await page.keyboard.type('Hello brave world');
  // The field handles the keys itself here; the document takes them from its input events.
  for (let i = 0; i < 8; i++) await input(page).press('Backspace');
  await expect(input(page)).toHaveValue('Hello bra');
  await input(page).evaluate(el => { el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  for (let i = 0; i < 3; i++) await input(page).press('Delete');
  await expect(input(page)).toHaveValue('lo bra');
  await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('Hello bra');
  await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('Hello brave world');
});

test('Cmd+Backspace and Cmd+Delete stop at the edge of the line as laid out, not of the paragraph', async ({ page }) => {
  await blank(page);
  const long = 'This paragraph is long enough to wrap onto a second line of the page, so deleting to the start of the line removes only its last visual line.';
  await input(page).fill(`Intro\n${long}`);
  const lines = () => page.evaluate(() => window.__docs.current.view.engine.selectionLayout.lines.map(l => [l.start, l.end]));
  const [, first, second] = await lines();
  expect(second[0]).toBeGreaterThan(first[0]);
  // The Mac's soft-line deletions, as the browser reports them.
  const softLine = (inputType, at) => input(page).evaluate((el, [inputType, at]) => {
    el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select'));
    const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }, [inputType, at]);
  const value = `Intro\n${long}`;
  expect(await softLine('deleteSoftLineBackward', value.length)).toBe(true);
  await expect(input(page)).toHaveValue(value.slice(0, second[0]));
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue(value);
  // Forward from inside the first wrapped line stops at that line's end.
  expect(await softLine('deleteSoftLineForward', first[0] + 5)).toBe(true);
  await expect(input(page)).toHaveValue(value.slice(0, first[0] + 5) + value.slice(first[1]));
  await input(page).press('ControlOrMeta+z');
  // At the start of a paragraph it joins the paragraph to the one before, as Backspace does.
  expect(await softLine('deleteSoftLineBackward', first[0])).toBe(true);
  await expect(input(page)).toHaveValue(`Intro${long}`);
});

test('deleting a word with the platform chord removes that word, not letters shifted onto the next', async ({ page }) => {
  await blank(page);
  await input(page).fill('one two three');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(8, 13); e.toggleBold(); e.model.select(8); e.syncInput(); });
  // The platform's delete-word chord, handled by the native field. "two " and "three" share the t, so
  // the change also reads as deleting "wo t".
  await input(page).press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');
  await expect(input(page)).toHaveValue('one three');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, !!r.bold]))).toEqual([['one ', false], ['three', true]]);
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([4, 4]);
});

test('a word deletion the document refuses, at the edge of a table, leaves the caret where it was', async ({ page }) => {
  await blank(page);
  await page.keyboard.type('Intro');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.insertTable(1, 2); e.focus(); });
  await page.keyboard.insertText('a'); await input(page).press('Tab'); await page.keyboard.insertText('b');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); });
  await page.keyboard.insertText('After');
  const value = await input(page).inputValue(), start = value.indexOf('After');
  await input(page).evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, start);
  // Backspace at the start of the paragraph after a table does nothing; neither does the delete-word chord the native field handles.
  await input(page).press(process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace');
  await expect(input(page)).toHaveValue(value);
  expect(await page.evaluate(() => [...window.__docs.current.view.engine.model.range])).toEqual([start, start]);
  // What is typed next goes where the caret is, not into the table.
  await page.keyboard.insertText('Then ');
  await expect(input(page)).toHaveValue(value.replace('After', 'Then After'));
});

test('with Track Changes on, word and line deletions leave the caret before what they struck out', async ({ page }) => {
  await blank(page);
  await input(page).fill('one two three\nfour five six');
  await input(page).press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(() => !!window.__docs.current.view.engine.model.trackChanges)).toBe(true);
  const state = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    return { range: [...e.model.range], deleted: e.model.paragraphs.map(p => p.runs.filter(r => r.revision?.type === 'del').map(r => r.text).join('')) };
  });
  await input(page).evaluate(el => { el.setSelectionRange(13, 13); el.dispatchEvent(new Event('select')); });
  // The platform's delete-word chord, handled by the native field.
  const deleteWord = process.platform === 'darwin' ? 'Alt+Backspace' : 'Control+Backspace';
  await input(page).press(deleteWord);
  expect(await state()).toEqual({ range: [8, 8], deleted: ['three', ''] });
  // A second press goes on to the word before, rather than striking the same one again.
  await input(page).press(deleteWord);
  expect(await state()).toEqual({ range: [4, 4], deleted: ['two three', ''] });
  // Cmd+Backspace (the Mac's soft-line deletion) likewise.
  await input(page).evaluate(el => {
    el.setSelectionRange(27, 27); el.dispatchEvent(new Event('select'));
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteSoftLineBackward', bubbles: true, cancelable: true }));
  });
  expect(await state()).toEqual({ range: [14, 14], deleted: ['two three', 'four five six'] });
});

test('after Undo or a right-click moves the caret, Up and Down keep to its new column', async ({ page }) => {
  await blank(page);
  await input(page).fill('First line of text here\nSecond line of text here\nThird line of text here');
  const place = at => input(page).evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, at);
  const caret = () => input(page).evaluate(el => el.selectionStart);
  await place(54); // Third line, after "Third"
  await page.keyboard.type('Z');
  await place(20);
  await page.keyboard.press('ArrowDown');
  expect(await caret()).toBeGreaterThan(40);
  // Undo puts the caret back after "Third"; Up goes to the same column of the line above, not the old one.
  await input(page).press('ControlOrMeta+z');
  expect(await caret()).toBe(54);
  await page.keyboard.press('ArrowUp');
  expect(Math.abs(await caret() - 29)).toBeLessThanOrEqual(1);
  // A right-click elsewhere moves the caret too.
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const at = await page.evaluate(() => { const e = window.__docs.current.view.engine, line = e.selectionLayout.lines[0]; return { x: line.stops.find(s => s.offset === 5).x * e.zoom, y: (line.y + line.height / 2) * e.zoom }; });
  await page.mouse.click(box.x + at.x, box.y + at.y, { button: 'right' });
  await page.keyboard.press('Escape');
  expect(await caret()).toBe(5);
  await page.keyboard.press('ArrowDown');
  expect(Math.abs(await caret() - 29)).toBeLessThanOrEqual(1);
});

test('Undo puts the caret back at the end of a wrapped line, not at the start of the next', async ({ page }) => {
  await blank(page);
  const long = 'This paragraph is long enough to wrap onto a second line of the page, so that the end of its first line is also where the second begins.';
  await input(page).fill(`Intro\n${long}`);
  const lines = await page.evaluate(() => window.__docs.current.view.engine.selectionLayout.lines.map(l => [l.start, l.end]));
  const [, first] = lines;
  await input(page).evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, first[0]);
  // End puts the caret at the end of the first line; typing there and undoing brings it back to that place.
  await input(page).press('End');
  expect(await input(page).evaluate(el => el.selectionStart)).toBe(first[1]);
  await page.keyboard.type('X');
  await input(page).press('ControlOrMeta+z');
  expect(await input(page).evaluate(el => el.selectionStart)).toBe(first[1]);
  expect(await page.evaluate(() => window.__docs.current.view.engine.caretAffinity)).toBe('backward');
  // Home goes to the start of that first line.
  await input(page).press('Home');
  expect(await input(page).evaluate(el => el.selectionStart)).toBe(first[0]);
  // Redo puts it back after the typed letter.
  await input(page).press('ControlOrMeta+Shift+z');
  expect(await input(page).inputValue()).toContain('X');
});
