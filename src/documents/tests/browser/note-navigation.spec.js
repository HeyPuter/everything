import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const engineState = page => page.evaluate(() => { const e = window.__docs.current.view.engine; return { path: e.session.path, at: e.model.range[0], text: e.session.body.text }; });

// From inside a footnote, Next Footnote goes on to the following note's reference (and Previous to the one before),
// as it does from that note's reference in the text.
test('Next and Previous Footnote move on from the note being edited', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('One. Two. Three.');
  await onTab(page, 'references');
  const ribbon = page.locator('#ribbon-panel-references');
  for (const [i, word] of ['One.', 'Two.', 'Three.'].entries()) {
    await page.evaluate(word => { const e = window.__docs.current.view.engine; e.editStory(null); const m = e.model; m.select(m.text.indexOf(word) + word.length); e.focus(); }, word);
    await ribbon.getByRole('button', { name: 'Insert Footnote', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
    await page.keyboard.type(`Note ${i + 1}`);
  }
  const text = (await engineState(page)).text, refs = [...text].flatMap((ch, i) => ch === '￼' ? [i] : []);
  expect(refs).toHaveLength(3);
  // Edit the second note, then go to the next footnote.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, path = Object.keys(e.pageStories.stories).find(p => e.pageStories.stories[p].noteId === '2');
    e.editStory(path, 0); e.model.select(e.model.text.length); e.focus();
  });
  await expect.poll(async () => (await engineState(page)).path).toMatch(/#2$/);
  const go = async name => { await ribbon.getByRole('button', { name: 'Next Footnote', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
  await go('Next Footnote');
  await expect.poll(() => engineState(page)).toMatchObject({ path: null, at: refs[2] + 1 });
  // And from the second note again, Previous Footnote goes to the first.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, path = Object.keys(e.pageStories.stories).find(p => e.pageStories.stories[p].noteId === '2');
    e.editStory(path, 0); e.model.select(0); e.focus();
  });
  await go('Previous Footnote');
  await expect.poll(() => engineState(page)).toMatchObject({ path: null, at: refs[0] + 1 });
});
