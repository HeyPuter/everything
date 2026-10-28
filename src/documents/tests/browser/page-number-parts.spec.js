import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A footer saved with Word's page-number building block (a block docPartObj control) opens for editing:
// typing in it, a new line and undo work, and the saved footer keeps the building block around its text.
test('edits a page-number building-block footer and saves it inside its wrapper', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/page-number-parts.docx');
  await expect(input).toHaveValue(/^Body page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  // Page 2 shows the Bottom of Page footer.
  await page.evaluate(() => { const e = window.__docs.current.view.engine, m = e.model; m.select(m.text.indexOf('Body page 2')); e.focus(); });
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Footer', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Footer', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.path)).toBe('word/footer1.xml');
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0); e.focus(); });
  await page.keyboard.insertText('Draft ');
  await page.keyboard.press('Enter');
  const story = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => p.runs.map(r => r.text).join('')));
  await expect.poll(story).toEqual(['Draft ', '\uFFFC', '']);
  // Both halves stay in the building block.
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.map(p => (p.blockControls || []).length))).toEqual([1, 1, 0]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(story).toEqual(['Draft \uFFFC', '']);
  const pending = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath('edited.docx'); await (await pending).saveAs(path);
  const footer = strFromU8(unzipSync(readFileSync(path))['word/footer1.xml']);
  expect(footer).toMatch(/<w:docPartGallery w:val="Page Numbers \(Bottom of Page\)"\/>.*<w:sdtContent><w:p[ >].*Draft .*PAGE.*<\/w:p><\/w:sdtContent><\/w:sdt><w:p[ >]/);
  expect(errors).toEqual([]);
});
