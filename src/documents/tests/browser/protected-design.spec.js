import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

test.describe.configure({ timeout: 90000 });
const ribbon = page => page.locator('.ribbon-card');
async function protect(page, mode) {
  await page.locator('#ribbon-tab-review').click();
  await page.locator('#ribbon-panel-review [aria-label="Restrict Editing"]').evaluate(b => b.click());
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: 'Allow only this type of editing in the document:' }).check();
  await pane.getByRole('combobox', { name: 'Type of editing allowed' }).selectOption(mode);
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  await page.getByRole('dialog', { name: 'Start Enforcing Protection' }).getByRole('button', { name: 'OK', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Stop Protection' })).toBeVisible();
  return pane;
}
async function themeOf(page, info) {
  const path = info.outputPath('saved.docx'), download = page.waitForEvent('download');
  await downloadDocx(page); await (await download).saveAs(path);
  return strFromU8(unzipSync(readFileSync(path))['word/theme/theme1.xml'] || new Uint8Array());
}

// The Design tab rewrites the package and reopens it, which went around Restrict Editing: under read-only protection,
// or with tracking locked, a theme, style set, watermark or page color still changed the document, and Undo could
// take back a design change made before protection began.
for (const mode of ['readOnly', 'trackedChanges']) test(`the design cannot be changed while the document is protected (${mode})`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Quarterly report\nThe body text of the report.');
  // A design change before protection: Undo must not take it back afterwards.
  await onTab(page, 'design');
  await ribbon(page).getByRole('button', { name: 'Themes' }).click();
  await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitemradio', { name: 'Harbor theme' }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.commands.packageHistory().undo)).toBe(true);
  const pane = await protect(page, mode);
  const before = await themeOf(page, info);
  expect(before).toContain('Harbor');
  await onTab(page, 'design');
  for (const name of ['Themes', 'Theme Colors', 'Theme Fonts', 'Theme Effects', 'Watermark']) await expect(ribbon(page).getByRole('button', { name, exact: true }).first(), name).toBeDisabled();
  // Commands reached another way (search, menus) are refused too.
  expect(await page.evaluate(() => window.__docs.current.view.commands.applyTheme('Office'))).toBe(false);
  await page.evaluate(() => window.__docs.current.view.commands.setWatermark({ kind: 'text', text: 'DRAFT', font: null, size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal', language: 'en-US' }));
  expect(await page.evaluate(() => window.__docs.current.view.commands.packageHistory())).toEqual({ undo: false, redo: false });
  await input.focus(); await input.press('ControlOrMeta+z');
  await page.waitForTimeout(500);
  expect(await themeOf(page, info)).toBe(before);
  // Stopping protection gives the design back.
  await page.locator('#ribbon-tab-review').click();
  await pane.getByRole('button', { name: 'Stop Protection' }).click();
  await page.getByRole('dialog', { name: 'Stop Protection' }).getByRole('button', { name: 'Stop Protection' }).click();
  await onTab(page, 'design');
  await expect(ribbon(page).getByRole('button', { name: 'Themes', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

// Insert Footnote reserved its note (creating the notes part, its relationship and content type) before the
// document refused the reference: the saved file of a read-only protected document gained a footnotes part.
test('Insert Footnote refused by protection leaves the file as it was', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Locked contract text.');
  await protect(page, 'readOnly');
  const parts = async name => { const path = info.outputPath(name), download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path); return unzipSync(readFileSync(path)); };
  const before = await parts('before.docx');
  await input.evaluate(el => { el.focus(); el.setSelectionRange(6, 6); el.dispatchEvent(new Event('select')); });
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(page.getByText(/protected/).first()).toBeVisible();
  const after = await parts('after.docx');
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const name of ['[Content_Types].xml', 'word/_rels/document.xml.rels', 'word/document.xml']) expect(strFromU8(after[name] || new Uint8Array()), name).toBe(strFromU8(before[name] || new Uint8Array()));
  expect(errors).toEqual([]);
});
