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
