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

test('holding a selection drag at the bottom edge keeps scrolling and extending the selection', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill(Array.from({ length: 200 }, (_, i) => `Paragraph number ${i}`).join('\n'));
  const state = () => page.evaluate(() => { const e = window.__docs.current.view.engine; return { scroll: e.host.scrollTop, end: e.model.range[1] }; });
  const host = await page.evaluate(() => { const h = window.__docs.current.view.engine.host; h.scrollTop = 0; return h.getBoundingClientRect().toJSON(); });
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 150, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, host.bottom - 5, { steps: 4 });
  const start = await state();
  // The pointer stays still; the view keeps scrolling and the selection follows the text under it.
  await expect.poll(async () => (await state()).scroll, { timeout: 5000 }).toBeGreaterThan(start.scroll + 400);
  expect((await state()).end).toBeGreaterThan(start.end);
  await page.mouse.up();
  const released = await state();
  await page.waitForTimeout(300);
  expect((await state()).scroll).toBe(released.scroll);
  expect(await input(page).evaluate(el => el.selectionEnd)).toBe(released.end);
});

test('a double or triple press then drag extends by whole words or paragraphs', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('hello world again and more\nSecond paragraph here\nThird one');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const at = await page.evaluate(() => {
    const e = window.__docs.current.view.engine, lines = e.selectionLayout.lines;
    const point = (line, offset) => ({ x: line.stops.find(s => s.offset === offset).x * e.zoom, y: (line.y + line.height / 2) * e.zoom });
    return { hel: point(lines[0], 2), aga: point(lines[0], 14), sec: point(lines[1], 30) };
  });
  const press = async (point, count) => {
    await page.mouse.move(box.x + point.x, box.y + point.y);
    for (let n = 1; n <= count; n++) { await page.mouse.down({ clickCount: n }); if (n < count) await page.mouse.up({ clickCount: n }); }
  };
  await press(at.hel, 2);
  expect(await selected(page)).toBe('hello');
  await page.mouse.move(box.x + at.aga.x, box.y + at.aga.y, { steps: 5 });
  await page.mouse.up({ clickCount: 2 });
  expect(await selected(page)).toBe('hello world again');
  await page.waitForTimeout(600);
  // Three presses take the paragraph; dragging into the next takes all of it too.
  await press(at.hel, 3);
  await page.mouse.move(box.x + at.sec.x, box.y + at.sec.y, { steps: 5 });
  await page.mouse.up({ clickCount: 3 });
  expect(await selected(page)).toBe('hello world again and more\nSecond paragraph here');
});

test('quick presses in one place count as a double press only when nothing came between them', async ({ page }) => {
  await page.goto('/mock.html#/new');
  const bold = page.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toBeEnabled();
  await input(page).fill(Array.from({ length: 60 }, (_, n) => `Line number ${n} of the text`).join('\n'));
  const host = page.locator('.canvas-host');
  await host.evaluate(el => { el.scrollTop = 0; });
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  const spot = { x: box.x + 100, y: box.y + 200 };
  const caret = () => input(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
  // A press on the toolbar between two presses on the page ends the run, as it does natively.
  await page.mouse.click(spot.x, spot.y);
  const [at] = await caret();
  await bold.click();
  await page.mouse.click(spot.x, spot.y);
  expect(await caret()).toEqual([at, at]);
  await page.waitForTimeout(600);
  // So does a scroll that puts other text under the pointer.
  await page.mouse.click(spot.x, spot.y);
  await host.evaluate(el => { el.scrollTop += 120; });
  await page.mouse.click(spot.x, spot.y);
  const [moved, end] = await caret();
  expect(moved).toBe(end);
  expect(moved).toBeGreaterThan(at);
  await page.waitForTimeout(600);
  // Two quick presses in place on the same text still take the word.
  await page.mouse.click(spot.x, spot.y);
  await page.mouse.click(spot.x, spot.y);
  expect(await selected(page)).toMatch(/^\S+$/u);
});
