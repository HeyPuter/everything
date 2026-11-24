import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, menuBarMenu, downloadDocx } from './helpers/editor-tools.js';

// A footnote holds no floating drawings, as in Word, which greys these commands out there. Shapes, text
// boxes, WordArt, signature lines, diagrams and charts chosen in a footnote went into the body (on whatever
// page the footnote's caret offset fell); they are now unavailable there and say why. Pictures go in line.
test('in a footnote, floating drawings are unavailable with a reason and a picture goes in line in the note', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Document text' });
  await body.fill('A claim that needs a source.');
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'Footnote text' });
  await expect(note).toBeFocused();
  await page.keyboard.type('See the figure ');
  await onTab(page, 'insert');
  const ribbon = page.locator('#ribbon-panel-insert');
  for (const name of ['Shapes', 'Text Box', 'WordArt', 'Signature Line', 'Diagram', 'Chart']) {
    const control = ribbon.getByRole('button', { name, exact: true });
    await expect(control, name).toBeDisabled();
    await expect(control, name).toHaveAttribute('title', /Not available in footnotes and endnotes/);
  }
  await expect(ribbon.getByRole('button', { name: 'Pictures', exact: true })).toBeEnabled();
  const menu = await menuBarMenu(page, 'Insert');
  for (const name of [/^Shapes…/, /^Text Box/, /^WordArt/, /^Signature Line…/, /^Diagram…/, /^Chart…/]) await expect(menu.getByRole('menuitem', { name })).toBeDisabled();
  await page.keyboard.press('Escape');
  // A picture goes in line in the footnote.
  await note.focus();
  await page.getByLabel('Insert picture file').setInputFiles('icon.png');
  await expect(page.locator('#ribbon-tab-picture')).toBeVisible();
  const download = page.waitForEvent('download'); await downloadDocx(page);
  const path = info.outputPath('note.docx'); await (await download).saveAs(path);
  const files = unzipSync(readFileSync(path));
  expect(strFromU8(files['word/document.xml'])).not.toContain('<w:drawing');
  expect(strFromU8(files['word/footnotes.xml'])).toMatch(/<w:drawing\b[^>]*>\s*<wp:inline/);
  // Back in the body, the commands are available again.
  await note.focus(); await note.press('Escape');
  await expect(body).toBeFocused();
  await expect(ribbon.getByRole('button', { name: 'Shapes', exact: true })).toBeEnabled();
  await expect(ribbon.getByRole('button', { name: 'Shapes', exact: true })).not.toHaveAttribute('title', /footnotes/);
  expect(errors).toEqual([]);
});
