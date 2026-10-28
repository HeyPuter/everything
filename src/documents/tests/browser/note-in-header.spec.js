import { test, expect } from '@playwright/test';

// Footnotes and endnotes belong to the text: the shortcut pressed in a footer says so rather than putting a
// note at wherever the caret was last left in the text.
test('the footnote shortcut in a footer explains instead of inserting a note elsewhere', async ({ page }) => {
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/section-page-numbers.docx');
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  const before = await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    const path = e.storyLayout.lines.find(line => line.page === 0 && e.pageStories.stories[line.pageStory]?.kind === 'footer').pageStory;
    e.model.select(5); e.editStory(path, 0); e.model.select(1); e.focus();
    return { path, body: e.session.body.text };
  });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+f' : 'Control+Alt+f');
  await expect(page.getByText('Footnotes and endnotes go in the text of the document', { exact: false })).toBeVisible();
  const after = await page.evaluate(() => { const e = window.__docs.current.view.engine; return { path: e.session.path, body: e.session.body.text }; });
  expect(after).toEqual(before);
});
