import { test, expect } from '@playwright/test';

// The left margin is the selection bar of desktop word processors, and selected text can be dragged elsewhere.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const range = page => input(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
async function sample(page) {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'Across pages', exact: true }).click();
  await expect(input(page)).toHaveValue(/Every page is another chance/);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
}
// The point on screen of a text position: where the caret, and the native field with it, goes there.
async function point(page, offset) {
  return page.evaluate(offset => {
    const input = document.querySelector('textarea.canvas-input');
    input.focus(); input.setSelectionRange(offset, offset); input.dispatchEvent(new Event('select', { bubbles: true }));
    const r = input.getBoundingClientRect();
    return { x: r.left + 1, y: r.top + r.height / 2 };
  }, offset);
}

test('a click in the left margin selects the line, two its paragraph and three or Cmd+click the whole document', async ({ page }) => {
  await sample(page);
  const text = await input(page).inputValue(), second = text.indexOf('Select words');
  const { y } = await point(page, second + 5), margin = (await page.locator('canvas.canvas-page').first().boundingBox()).x + 40;
  await page.mouse.click(margin, y);
  const [start, end] = await range(page);
  expect(start).toBe(second); expect(end).toBeGreaterThan(second + 40); expect(text.slice(start, end)).not.toContain('\n');
  await page.waitForTimeout(600);
  await page.mouse.dblclick(margin, y); expect(await range(page)).toEqual([second, text.length]);
  await page.waitForTimeout(600);
  await page.mouse.click(margin, y, { clickCount: 3 }); expect(await range(page)).toEqual([0, text.length]);
  await page.waitForTimeout(600);
  await page.mouse.click(margin + 70, y); expect((await range(page))[0]).toBeGreaterThan(second);
  await page.waitForTimeout(600);
  await page.keyboard.down('ControlOrMeta'); await page.mouse.click(margin, y); await page.keyboard.up('ControlOrMeta');
  expect(await range(page)).toEqual([0, text.length]);
  // A drag down the margin selects whole lines.
  await page.waitForTimeout(600);
  const below = await point(page, second + 300);
  await page.mouse.move(margin, y); await page.mouse.down(); await page.mouse.move(margin, below.y, { steps: 5 }); await page.mouse.up();
  const [from, to] = await range(page);
  expect(from).toBe(second); expect(to).toBeGreaterThan(second + 300);
});

test('selected text dragged elsewhere moves there as one undo step, copies with Option, and stays put dropped on itself', async ({ page }) => {
  await page.goto('/playground.html'); await page.getByRole('button', { name: 'New', exact: true }).click();
  await input(page).fill('alpha beta gamma delta');
  const drag = async (from, to, select, alt = false) => {
    await input(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, select);
    const start = await point(page, from), end = await point(page, to);
    await input(page).evaluate((el, [a, b]) => { el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, select);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(start.x + 2, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
    await page.waitForTimeout(600);
  };
  await drag(8, 22, [6, 10]);
  await expect(input(page)).toHaveValue('alpha gamma delta beta'); expect(await range(page)).toEqual([18, 22]);
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('alpha beta gamma delta'); expect(await range(page)).toEqual([6, 10]);
  await drag(8, 13, [6, 16]);
  await expect(input(page)).toHaveValue('alpha beta gamma delta'); expect(await range(page)).toEqual([6, 16]);
  await drag(8, 0, [6, 10], true);
  await expect(input(page)).toHaveValue('beta alpha beta gamma delta'); expect(await range(page)).toEqual([0, 4]);
  // A click inside the selection, without a drag, places the caret there.
  await input(page).evaluate(el => { el.setSelectionRange(6, 16); el.dispatchEvent(new Event('select', { bubbles: true })); });
  const inside = await point(page, 13);
  await input(page).evaluate(el => { el.setSelectionRange(6, 16); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.mouse.click(inside.x + 1, inside.y); expect(await range(page)).toEqual([13, 13]);
});

test('dragged text held past the bottom of the view scrolls the pages, and drops in the text scrolled in', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await sample(page);
  const text = await input(page).inputValue(), word = text.indexOf('small');
  await input(page).evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at + 5); el.dispatchEvent(new Event('select', { bubbles: true })); }, word);
  const start = await point(page, word + 2);
  await input(page).evaluate((el, at) => { el.setSelectionRange(at, at + 5); el.dispatchEvent(new Event('select', { bubbles: true })); }, word);
  const host = page.locator('.canvas-host'), bottom = await host.evaluate(el => el.getBoundingClientRect().bottom);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x, start.y + 40, { steps: 3 }); await page.mouse.move(start.x, bottom + 30, { steps: 4 });
  await expect.poll(() => host.evaluate(el => el.scrollTop), { timeout: 5000 }).toBeGreaterThan(300);
  await page.mouse.move(start.x, bottom - 60, { steps: 2 });
  await page.mouse.up();
  const value = await input(page).inputValue(), moved = value.indexOf('small');
  // Moved, not copied: only the spacing around the word may differ (a word dropped inside another gets a space on
  // each side, and where it lands depends on the fonts' widths).
  const bare = s => s.replace('small', '').replace(/\s+/g, '');
  expect(value.split('small').length).toBe(text.split('small').length);
  expect(bare(value)).toBe(bare(text));
  expect(moved).toBeGreaterThan(word + 300);
  expect(await range(page)).toEqual([moved, moved + 5]);
});
