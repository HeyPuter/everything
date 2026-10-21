import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
async function select(page, start, end) {
  await text(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [start, end]);
}

test('the status bar word count follows typing, selection, undo and same-length edits', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const count = page.locator('.ed-statusbar .ed-word-count');
  await text(page).fill('one two three');
  await expect(count).toHaveText('3 words');
  await select(page, 0, 7);
  await expect(count).toHaveText('2 of 3 words');
  await select(page, 4, 13);
  await expect(count).toHaveText('2 of 3 words');
  await select(page, 0, 3);
  await expect(count).toHaveText('1 of 3 words');
  await select(page, 13, 13);
  await expect(count).toHaveText('3 words');
  // A space typed over a letter keeps the length but adds a word, inside and outside a selection.
  await select(page, 1, 2);
  await page.keyboard.type(' ');
  await expect(count).toHaveText('4 words');
  await select(page, 0, 13);
  await expect(count).toHaveText('4 of 4 words');
  await select(page, 13, 13);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  // Undo selects the letter it brings back.
  await expect(count).toHaveText('1 of 3 words');
  await select(page, 13, 13);
  await expect(count).toHaveText('3 words');
  await page.keyboard.type(' four');
  await expect(count).toHaveText('4 words');
  await page.keyboard.press('Shift+Home');
  await expect(count).toHaveText('4 of 4 words');
});
