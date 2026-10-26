import { test, expect } from '@playwright/test';

// Issue #85: Ctrl+Arrow and Ctrl+Shift+Arrow step through Thai text written without spaces one
// dictionary word at a time, like Ctrl+Delete, Ctrl+Backspace and double-click already do.
const thai = 'ฉันไปโรงเรียนทุกวันเพราะอยากเรียนรู้';
const stops = [3, 5, 13, 16, 19, 24, 28, 33, 36];

test('Ctrl+Arrow and Ctrl+Shift+Arrow step through Thai words typed in the editor', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await page.keyboard.insertText(thai);
  await expect(input).toHaveValue(thai);
  const selection = () => input.evaluate(e => [e.selectionStart, e.selectionEnd]);

  await input.press('Control+Home');
  const right = [];
  for (let i = 0; i < stops.length; i++) { await input.press('Control+ArrowRight'); right.push((await selection())[0]); }
  expect(right).toEqual(stops);

  const left = [];
  for (let i = 0; i < stops.length; i++) { await input.press('Control+ArrowLeft'); left.push((await selection())[0]); }
  expect(left).toEqual([...stops.slice(0, -1).reverse(), 0]);

  await input.press('Control+Shift+ArrowRight');
  expect(await selection()).toEqual([0, 3]);
  await input.press('Control+Shift+ArrowRight');
  expect(await selection()).toEqual([0, 5]);

  // Typing over the selected words replaces exactly them, and undo brings them back.
  await page.keyboard.insertText('เขา');
  await expect(input).toHaveValue('เขา' + thai.slice(5));
  await input.press('Control+z');
  await expect(input).toHaveValue(thai);
});
