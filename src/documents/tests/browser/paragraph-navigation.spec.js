import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const first = 'First paragraph is long enough to wrap onto a second visual line when the page is at this zoom level and width of the text area here ok.';
const second = 'Second paragraph also has a good number of words so that it wraps across lines too in the field and continues for a while longer than one line.';
const text = `${first}\n${second}\nThird.`;
const secondStart = first.length + 1, secondEnd = secondStart + second.length;

async function at(page, position) {
  await input(page).evaluate((el, position) => { el.focus(); el.setSelectionRange(position, position); el.dispatchEvent(new Event('select')); }, position);
}
async function steps(page, key, count) {
  const stops = [];
  for (let i = 0; i < count; i++) { await input(page).press(key); stops.push(await input(page).evaluate(el => el.selectionStart)); }
  return stops;
}

test('vertical arrow chords move by paragraph and to the document ends', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill(text);
  // Cmd+Up/Down: document start and end, as on a Mac.
  await at(page, 60); expect(await steps(page, 'Meta+ArrowDown', 1)).toEqual([text.length]);
  expect(await steps(page, 'Meta+ArrowUp', 1)).toEqual([0]);
  // Option+Up/Down: this paragraph's start or end, then the neighbor's.
  await at(page, secondStart + 40); expect(await steps(page, 'Alt+ArrowUp', 3)).toEqual([secondStart, 0, 0]);
  await at(page, 60); expect(await steps(page, 'Alt+ArrowDown', 4)).toEqual([first.length, secondEnd, text.length, text.length]);
  // Ctrl+Up/Down: paragraph starts.
  await at(page, 60); expect(await steps(page, 'Control+ArrowDown', 3)).toEqual([secondStart, secondEnd + 1, text.length]);
  await at(page, secondStart + 40); expect(await steps(page, 'Control+ArrowUp', 2)).toEqual([secondStart, 0]);
  // Shift extends the selection the same way: Option+Shift on a Mac; elsewhere Alt+Shift moves paragraphs and Ctrl+Shift extends.
  const mac = process.platform === 'darwin';
  await at(page, 60); await input(page).press(mac ? 'Alt+Shift+ArrowDown' : 'Control+Shift+ArrowDown');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([60, mac ? first.length : secondStart]);
  await input(page).press('Meta+Shift+ArrowDown');
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([60, text.length]);
  // Plain arrows still move by line.
  await at(page, 10); await input(page).press('ArrowDown');
  const next = await input(page).evaluate(el => el.selectionStart);
  expect(next).toBeGreaterThan(10); expect(next).toBeLessThan(first.length);
});

test('PageDown and PageUp move the caret a screen at a time and keep it in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const lines = Array.from({ length: 120 }, (_, i) => `Line number ${i + 1}`), all = lines.join('\n');
  await input(page).fill(all); await input(page).press('ControlOrMeta+Home');
  const line = () => input(page).evaluate(el => el.value.slice(0, el.selectionStart).split('\n').length);
  const host = page.locator('.canvas-host'), scroll = () => host.evaluate(el => el.scrollTop);
  const before = await scroll();
  await input(page).press('PageDown');
  const down = await line(); expect(down).toBeGreaterThan(8);
  expect(await scroll()).toBeGreaterThan(before);
  await input(page).press('PageDown'); const further = await line(); expect(further).toBeGreaterThan(down);
  // A screen back up; a page gap crossed on the way down can shift it by a line or two.
  await input(page).press('PageUp'); const up = await line();
  expect(up).toBeLessThan(further); expect(Math.abs(up - down)).toBeLessThanOrEqual(3);
  // The caret stays on screen, so typing lands where the user is looking.
  const caret = await page.evaluate(() => { const e = window.__docs.current.view.engine; return e.canvases[e.selectionLayout.lines.find(l => l.start === e.model.selection.focus)?.page ?? 0].getBoundingClientRect().top; });
  expect(caret).toBeLessThan(720);
  for (let i = 0; i < 15; i++) await input(page).press('PageDown');
  expect(await input(page).evaluate(el => el.selectionStart)).toBe(all.length);
  await input(page).press('ControlOrMeta+Home'); await input(page).press('Shift+PageDown');
  expect(await input(page).evaluate(el => el.selectionStart)).toBe(0);
  expect(await input(page).evaluate(el => el.selectionEnd)).toBeGreaterThan(0);
});
