import { test, expect } from '@playwright/test';

const engine = 'window.__docs.current.view.engine';
const input = page => page.locator('.canvas-input');

// While a header was being edited, Remove beside an editable region in the Restrict Editing pane acted on the
// header's text, which has no regions: nothing happened. It removes the body's region, as one step to undo.
test('Remove beside an editable region works while the header is edited', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Locked text. Open text.');
  await page.getByRole('textbox', { name: 'Document text' }).evaluate(el => { el.focus(); el.setSelectionRange(13, 23); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Restrict Editing' }).filter({ visible: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: 'Allow only this type of editing in the document:' }).check();
  await pane.getByRole('checkbox', { name: 'Everyone' }).check();
  const regions = pane.getByRole('list', { name: 'Editable regions' });
  await expect(regions.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  await page.keyboard.type('Head');
  await regions.getByRole('button', { name: 'Remove' }).click();
  await expect(regions).toHaveCount(0);
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.paragraphs.some(p => p.bookmarks?.some(m => m.perm)), engine)).toBe(false);
  // One undo brings the region back; the header keeps its typing.
  await input(page).press('ControlOrMeta+z');
  await expect(pane.getByRole('list', { name: 'Editable regions' }).getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(engine => Object.values(eval(engine).session.storyEdits).some(s => s.paragraphs.some(p => p.runs.some(r => r.text.includes('Head')))), engine)).toBe(true);
  expect(errors).toEqual([]);
});
