import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const caretWord = page => input(page).evaluate(el => el.value.slice(el.selectionStart).match(/^\S*/)[0]);
async function caretIn(page, text) { await input(page).evaluate((el, text) => { const at = el.value.indexOf(text); el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text); }

// Go To offered only pages, lines, bookmarks, headings, tables and graphics; Word's also goes to sections, comments
// (by reviewer), footnotes, endnotes, fields (by name) and equations.
test('Go To goes to comments by reviewer, footnotes, fields by name and sections', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha one\nBravo two\nCharlie three\nDelta four');
  await page.evaluate(async () => {
    const { insertBodyField } = await import('/src/engine/field-results.js');
    const e = window.__docs.current.view.engine, m = e.model, at = t => m.text.indexOf(t);
    e.execute(() => {
      m.addComment({ author: 'Ada', text: 'One', range: [at('one'), at('one') + 3] });
      m.addComment({ author: 'Bo', text: 'Two', range: [at('two'), at('two') + 3] });
      m.addComment({ author: 'Ada', text: 'Three', range: [at('three'), at('three') + 5] });
      m.select(at('Bravo')); insertBodyField(m, ' AUTHOR ', 'Me ');
      m.select(at('Delta')); insertBodyField(m, ' DATE \\@ "yyyy" ', '2026 ');
      m.select(at('Charlie')); m.insertSectionBreak('nextPage');
      m.select(0);
      return true;
    });
  });
  await page.evaluate(() => window.__docs.current.view.commands.insertFootnote());
  await page.keyboard.type('A note.');
  await page.keyboard.press('Escape');
  await caretIn(page, 'Alpha');
  const dialog = page.getByRole('dialog', { name: 'Go To' });
  await input(page).press('F5');
  const what = dialog.getByLabel('Go to what');
  await expect(what.locator('option')).toHaveText(['Page', 'Section', 'Line', 'Bookmark', 'Comment', 'Footnote', 'Endnote', 'Field', 'Table', 'Graphic', 'Equation', 'Heading']);
  // Comments: Next and Previous through any reviewer's, or one reviewer's.
  await what.selectOption('comment');
  const reviewer = dialog.getByLabel('Enter reviewer’s name');
  await expect(reviewer.locator('option')).toHaveText(['Any reviewer', 'Ada', 'Bo']);
  await expect(dialog.getByLabel('Enter comment number')).toBeHidden();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  expect(await caretWord(page)).toBe('one');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  expect(await caretWord(page)).toBe('two');
  await reviewer.selectOption({ label: 'Ada' });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  expect(await caretWord(page)).toBe('three');
  await dialog.getByRole('button', { name: 'Previous', exact: true }).click();
  expect(await caretWord(page)).toBe('one');
  // Fields by name.
  await what.selectOption('field');
  await expect(dialog.getByLabel('Enter field name').locator('option')).toHaveText(['Any field', 'AUTHOR', 'DATE']);
  await dialog.getByLabel('Enter field name').selectOption('=DATE');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  expect(await caretWord(page)).toBe('2026');
  // Footnotes and sections by number, and + or − a number.
  await what.selectOption('footnote');
  await dialog.getByLabel('Enter footnote number').fill('1');
  await dialog.getByLabel('Enter footnote number').press('Enter');
  await expect(dialog).toBeHidden();
  expect(await input(page).evaluate(el => el.value[el.selectionStart])).toBe('￼');
  await input(page).press('F5');
  await what.selectOption('section');
  await dialog.getByLabel('Enter section number').fill('+1');
  await dialog.getByLabel('Enter section number').press('Enter');
  await expect(dialog).toBeHidden();
  expect(await caretWord(page)).toBe('Charlie');
  await input(page).press('F5');
  await what.selectOption('endnote');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('There is no next endnote.');
  expect(errors).toEqual([]);
});
