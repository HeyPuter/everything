import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const selected = page => input(page).evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
const paragraph = 'This paragraph is long enough to wrap onto a second line of the page, so a triple click on that second line still selects all of it.';

test('a triple click selects the whole paragraph, including wrapped lines, and typing replaces only it', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill(`Title\n${paragraph}\nLast line`);
  const canvas = page.locator('canvas.canvas-page').first();
  // The second line of the long paragraph, below the 1in margin at 100% zoom.
  const second = { x: 300, y: 163 };
  await canvas.dblclick({ position: second });
  expect((await selected(page)).trim()).toMatch(/^\S+$/u);
  await canvas.click({ position: second, clickCount: 3 });
  expect(await selected(page)).toBe(paragraph);
  await page.keyboard.insertText('Replaced');
  await expect(input(page)).toHaveValue('Title\nReplaced\nLast line');
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue(`Title\n${paragraph}\nLast line`);
  // Shift keeps extending the existing selection rather than taking a paragraph.
  await canvas.click({ position: { x: 100, y: 108 } });
  await canvas.click({ position: second, clickCount: 3, modifiers: ['Shift'] });
  expect(await selected(page)).not.toBe(paragraph);
});

test('a double click on the right half of a word’s last letter selects that word, not the space after it', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('hello world again');
  const canvas = page.locator('canvas.canvas-page').first();
  // Page-space x of the stops around the o of "hello" and the w of "world", and the line's middle.
  const geometry = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, line = e.selectionLayout.lines[0], x = offset => line.stops.find(s => s.offset === offset).x * e.zoom;
    return { o: [x(4), x(5)], w: [x(6), x(7)], space: x(6), y: (line.y + line.height / 2) * e.zoom };
  });
  const at = async x => { await canvas.dblclick({ position: { x, y: geometry.y } }); const text = await selected(page); await page.waitForTimeout(600); return text; };
  // Just inside the right edge of the o, then just inside the left edge of the w.
  expect(await at(geometry.o[1] - 1)).toBe('hello');
  expect(await at(geometry.w[0] + 1)).toBe('world');
  // The space between them is itself.
  expect(await at(geometry.o[1] + 1)).toBe(' ');
  expect(await at(geometry.space - 1)).toBe(' ');
});
