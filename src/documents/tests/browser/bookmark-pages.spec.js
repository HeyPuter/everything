import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// The Bookmarks dialog names the page a bookmark is on as the page shows its number (ii in a section numbered
// from ii), and lists the document's bookmarks while a header or footer is open.
test('the Bookmarks dialog shows printed page numbers and lists the text\'s bookmarks from a footer', async ({ page }) => {
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/section-page-numbers-offset.docx');
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0, 5); e.addBookmark('Opening'); e.model.select(0); e.focus(); });
  const open = async () => { await onTab(page, 'insert'); await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Bookmarks', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); };
  const list = () => page.getByRole('listbox', { name: 'Document bookmarks', exact: true }).locator('option');
  await open();
  await expect(list()).toHaveText(['Opening · page ii']);
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
  // From the first page's footer the list (as Go To uses it) still holds the text's bookmarks, and going to one
  // leaves the footer for the text.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, line = e.storyLayout.lines.find(l => l.page === 0 && e.pageStories.stories[l.pageStory]?.kind === 'footer');
    e.editStory(line.pageStory, 0); e.focus();
  });
  expect(await page.evaluate(() => window.__docs.current.view.engine.bookmarks.map(b => `${b.name} · page ${b.page}`))).toEqual(['Opening · page ii']);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.goToBookmark(e.bookmarks[0].id); });
  await expect.poll(() => page.evaluate(() => { const e = window.__docs.current.view.engine; return [e.session.path, e.model.range[0]]; })).toEqual([null, 0]);
});
