import { test, expect } from '@playwright/test';

/** Run a command from the title bar's command search, as a keyboard user does. */
async function runCommand(page, name) {
  await page.evaluate(() => document.querySelector('.ed-search-input').focus());
  await page.keyboard.type(name);
  await expect(page.locator('.ed-search-option').first()).toContainText(name);
  await page.keyboard.press('Enter');
}

/** Whether the element is wholly inside the window and the editor's column. */
const inView = locator => locator.evaluate(node => {
  const box = node.getBoundingClientRect(), column = node.closest('.canvas-editor-content').getBoundingClientRect();
  return box.top >= Math.max(0, column.top) - 1 && box.bottom <= Math.min(innerHeight, column.bottom) + 1;
});

test('in a narrow window a pane opened under another one is scrolled up to the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto('/mock.html#/new');
  const text = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await text.fill('Heading text here\nBody paragraph');
  await runCommand(page, 'Smart Lookup');
  await expect(page.getByRole('complementary', { name: 'Smart Lookup' })).toBeVisible();
  // The panes stack under the page in one scrolling column; the Thesaurus comes after Smart Lookup.
  await runCommand(page, 'Thesaurus');
  const pane = page.getByRole('complementary', { name: 'Thesaurus pane' });
  await expect(pane).toBeVisible();
  const field = pane.getByRole('searchbox').or(pane.getByRole('textbox')).first();
  await expect(field).toBeFocused();
  await expect.poll(() => inView(field)).toBe(true);
  await expect.poll(() => inView(pane.getByRole('button', { name: 'Close Thesaurus pane' }))).toBe(true);
});

test('in a wide window opening a pane does not scroll anything', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/mock.html#/new');
  const text = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.locator('.canvas-workspace')).toBeVisible();
  await text.fill('Heading text here\nBody paragraph');
  await runCommand(page, 'Smart Lookup');
  await runCommand(page, 'Thesaurus');
  await expect(page.getByRole('complementary', { name: 'Thesaurus pane' })).toBeVisible();
  expect(await page.locator('.canvas-editor-content').evaluate(node => [node.scrollTop, node.scrollLeft])).toEqual([0, 0]);
});
