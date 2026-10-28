import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A link to a bookmark followed from a footnote goes to that bookmark in the text (notes and headers hold no
// bookmarks of their own), not to the start of the note.
test('a bookmark link in a footnote leads to the bookmark in the text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Claim here. Later the Target section.');
  await page.evaluate(() => { const e = window.__docs.current.view.engine, m = e.model, at = m.text.indexOf('Target'); m.select(at, at + 6); e.addBookmark('Target'); m.select(m.text.indexOf('.') + 1); e.focus(); });
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
  await page.keyboard.type('See ');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.setHyperlink({ anchor: 'Target' }, 'the target'); });
  const state = () => page.evaluate(() => { const e = window.__docs.current.view.engine; return { path: e.session.path, range: [...e.model.range], target: e.session.body.text.indexOf('Target') }; });
  expect((await state()).path).toMatch(/footnotes\.xml#/);
  await page.evaluate(() => { const e = window.__docs.current.view.engine, m = e.model; m.select(m.text.indexOf('the target') + 2); e.openHyperlink(); });
  await expect.poll(state).toMatchObject({ path: null });
  const after = await state();
  expect(after.range).toEqual([after.target, after.target]);
});
