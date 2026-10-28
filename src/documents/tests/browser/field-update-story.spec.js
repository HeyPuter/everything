import { test, expect } from '@playwright/test';

// F9 (Update Fields) pressed in a footer updates the document's fields and leaves the caret in the footer.
test('F9 in a footer keeps the footer open with the caret where it was', async ({ page }) => {
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/section-page-numbers.docx');
  await expect(input).toHaveValue(/^Roman start, page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  const state = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    return { path: e.session.path, range: [...e.model.range], body: e.session.body.text,
      story: e.session.path && e.pageStories.stories[e.session.path].paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n') };
  });
  const footer = await page.evaluate(() => {
    const e = window.__docs.current.view.engine;
    const path = e.storyLayout.lines.find(line => line.page === 0 && e.pageStories.stories[line.pageStory]?.kind === 'footer').pageStory;
    e.editStory(path, 0); e.model.select(2); e.focus();
    return path;
  });
  const before = await state();
  expect(before).toMatchObject({ path: footer, range: [2, 2] });
  // Keys typed straight after F9, while the update is still running, go into the footer, in order: Update
  // Fields does its work in the body without the footer closing in between.
  await page.keyboard.press('F9');
  await page.keyboard.insertText('X');
  await page.keyboard.insertText('Y');
  await expect.poll(async () => (await state()).story).toBe(`${before.story.slice(0, 2)}XY${before.story.slice(2)}`);
  // And once the update has finished, they are still there and the body is as it was.
  await page.waitForFunction(() => window.__docs.current.view.engine.fieldUpdateRunning === false);
  const after = await state();
  expect(after).toMatchObject({ path: footer, range: [4, 4], body: before.body });
  expect(after.story).toBe(`${before.story.slice(0, 2)}XY${before.story.slice(2)}`);
});
