import { test, expect } from '@playwright/test';

// Outline view redraws the outline after every keystroke. It wrote every row's attributes and styles
// again each time, though typing changes one row: most of a keystroke's time in a long document. A
// row now keeps them while the values they show are the same, and the outline still matches one
// drawn afresh after typing, level changes, collapsing and undo.
test.use({ viewport: { width: 1440, height: 900 } });
const ribbon = page => page.locator('.ribbon-card');
const viewTab = async page => { await page.locator('#ribbon-tab-view').click(); return ribbon(page); };
const caretAt = (input, text) => input.evaluate((el, text) => { const n = el.value.indexOf(text); el.focus(); el.setSelectionRange(n, n); el.dispatchEvent(new Event('select')); }, text);
// The outline as drawn, without what follows focus and selection.
const drawnOutline = page => page.evaluate(() => {
  const list = document.querySelector('.outline-list').cloneNode(true);
  for (const node of list.querySelectorAll('*')) { node.classList.remove('is-current', 'is-selected'); node.removeAttribute('aria-selected'); }
  return list.innerHTML;
});

test('Outline view rewrites only the rows that change, and matches an outline drawn afresh', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  const sections = Array.from({ length: 12 }, (_, i) => `Section ${i}\n${Array.from({ length: 8 }, (_, j) => `Body ${i}.${j} has words to read.`).join('\n')}\nPart ${i}\nDetail ${i} under the part.`);
  await input.fill(sections.join('\n'));
  for (let i = 0; i < 12; i++) {
    await caretAt(input, `Section ${i}\n`); await input.press('Control+Alt+1');
    await caretAt(input, `Part ${i}\n`); await input.press('Control+Alt+2');
  }
  await (await viewTab(page)).getByRole('button', { name: 'Outline', exact: true }).click();
  // The page view's text box stays in the document, out of the accessibility tree, while the outline is shown.
  const text = page.locator('textarea.canvas-input');
  const rows = page.getByRole('tree', { name: 'Document outline' }).getByRole('treeitem');
  await expect(rows).toHaveCount(12 * 11);
  await page.evaluate(() => {
    window.writes = 0;
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (...args) { if (this.closest?.('.outline-list')) window.writes++; return set.apply(this, args); };
  });
  const body = page.locator('.outline-row', { hasText: 'Body 5.3 has' }).locator('.outline-text');
  await body.click();
  await page.keyboard.press('End');
  await page.evaluate(() => { window.writes = 0; });
  await page.keyboard.type(' More');
  await expect(text).toHaveValue(/Body 5\.3 has words to read\. More\n/);
  // A row's attributes are written again only when it changes: the typed row's labels, not all 132 rows'.
  expect(await page.evaluate(() => window.writes)).toBeLessThan(132);
  // Level changes, Enter, collapsing and undo still draw every row as a fresh outline would.
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.outline-row', { hasText: 'Body 5.3 has' })).toHaveClass(/is-heading/);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Split off');
  await page.locator('.outline-row', { hasText: 'Part 7' }).locator('.outline-symbol').dblclick();
  await expect(page.locator('.outline-row', { hasText: 'Detail 7 under' })).toHaveCount(0);
  await page.locator('.outline-row', { hasText: 'Section 2' }).locator('.outline-text').click();
  await page.keyboard.press('Tab');
  await expect(page.locator('.outline-row', { hasText: 'Section 2' })).toHaveAttribute('aria-level', '2');
  await page.locator('.outline-row', { hasText: 'Part 9' }).locator('.outline-text').click();
  await page.keyboard.press('End');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
  // An emptied heading shows its placeholder.
  await expect(page.locator('.outline-text[data-placeholder="Heading"]')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  const drawn = await drawnOutline(page);
  // Leaving the view and coming back draws the outline afresh.
  await (await viewTab(page)).getByRole('button', { name: 'Print Layout', exact: true }).click();
  await (await viewTab(page)).getByRole('button', { name: 'Outline', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Document outline' })).toBeVisible();
  expect(await drawnOutline(page)).toBe(drawn);
  expect(errors).toEqual([]);
});
