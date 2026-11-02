import { test, expect } from '@playwright/test';
import { onTab, menuBarMenu } from './helpers/editor-tools.js';

// Simple Markup shows the document as if its changes were accepted: a footnote whose reference was deleted with
// Track Changes on leaves the page, and the notes after it are numbered without it. Both notes stayed, numbered 1, 2.
test('a footnote deleted with Track Changes on leaves the page in Simple Markup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('One. Two.');
  await onTab(page, 'references');
  const ribbon = page.locator('#ribbon-panel-references');
  for (const [i, word] of ['One.', 'Two.'].entries()) {
    await page.evaluate(word => { const e = window.__docs.current.view.engine; e.editStory(null); const m = e.model; m.select(m.text.indexOf(word) + word.length); e.focus(); }, word);
    await ribbon.getByRole('button', { name: 'Insert Footnote', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
    await page.keyboard.type(`Note ${i + 1}`);
  }
  const shown = () => page.evaluate(() => window.__docs.current.view.engine.layout.footnoteAreas.flatMap(a => a.notes.map(n => n.display)));
  await expect.poll(shown).toEqual(['1', '2']);
  // Back in the text, Track Changes on, delete the first reference.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.editStory(null); const m = e.model; const at = m.text.indexOf('￼'); m.select(at + 1); e.focus(); });
  await page.keyboard.press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.body.trackChanges)).toBe(true);
  await page.keyboard.press('Backspace');
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.body.revisions.map(r => r.type))).toEqual(['del']);
  await expect.poll(shown).toEqual(['1', '2']);
  await (await menuBarMenu(page, 'View')).getByRole('menuitem', { name: 'Markup', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Simple Markup', exact: true }).click();
  await expect.poll(shown).toEqual(['1']);
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.layout.footnoteAreas.flatMap(a => a.notes.map(n => n.path)))).toEqual(['word/footnotes.xml#2']);
  await (await menuBarMenu(page, 'View')).getByRole('menuitem', { name: 'Markup', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'All Markup', exact: true }).click();
  await expect.poll(shown).toEqual(['1', '2']);
});
