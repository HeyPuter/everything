import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

const SHOTS = process.env.REF_SHOTS || null;
const shot = async (page, name) => { if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const input = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('#ribbon-panel-references');
const engineText = page => page.evaluate(() => window.__docs.current.view.engine.session.body.text);

async function openEditor(page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
}
async function typeDocument(page) {
  // Headings through the editor model: the same paths the Styles gallery uses.
  await page.evaluate(() => {
    const engine = window.__docs.current.view.engine, m = engine.model;
    engine.execute(() => {
      m.replace('Introduction\nEngines compute numbers quickly.\nHistory\nThe analytical engine came first.\nConclusion\nMachines learn.');
      const style = name => m.paragraphStyles.find(s => s.name === name).id;
      for (const [text, name] of [['Introduction', 'Heading 1'], ['History', 'Heading 2'], ['Conclusion', 'Heading 1']]) { m.select(m.text.indexOf(text)); m.setParagraphStyle(style(name)); }
      m.select(0);
      return true;
    });
    engine.focus();
  });
}
async function download(page, info, name) {
  const pending = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath(name); await (await pending).saveAs(path);
  return unzipSync(readFileSync(path));
}

test('the References tab shows every group and its commands', async ({ page }) => {
  await openEditor(page);
  await onTab(page, 'references');
  for (const name of ['Table of Contents', 'Add Text', 'Update Table', 'Update Fields', 'Insert Footnote', 'Insert Endnote', 'Next Footnote', 'Show Notes', 'Footnote and Endnote Settings',
    'Smart Lookup', 'Insert Citation', 'Manage Sources', 'Bibliography', 'Insert Caption', 'Insert Table of Figures', 'Update Table of Figures', 'Cross-reference',
    'Mark Entry', 'Insert Index', 'Update Index', 'Mark Citation', 'Insert Table of Authorities', 'Update Table of Authorities']) {
    await expect(ribbon(page).getByRole('button', { name, exact: true, includeHidden: true }), name).toHaveCount(1);
  }
  await expect(ribbon(page).getByRole('combobox', { name: 'Citation style' })).toHaveValue('apa');
  await shot(page, 'references-ribbon-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, 'references-ribbon-390');
});

test('table of contents: gallery, custom options, add text, update and remove', async ({ page }, info) => {
  await openEditor(page);
  await typeDocument(page);
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Table of Contents', exact: true }).click();
  await shot(page, 'toc-gallery');
  await page.getByRole('menuitem', { name: /^Classic/ }).click();
  await expect.poll(() => engineText(page)).toMatch(/^Contents\nIntroduction\t1\nHistory\t1\nConclusion\t1\nIntroduction/);
  // Add Text: make a body paragraph a level-2 entry, then update the entire table.
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('Machines')); });
  await ribbon(page).getByRole('button', { name: 'Add Text', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Level 2', exact: true }).click();
  await ribbon(page).getByRole('button', { name: 'Update Table', exact: true }).click();
  await page.getByRole('dialog', { name: 'Update Table of Contents' }).getByLabel('Update entire table (new entries and text)').check();
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('Conclusion\t1\nMachines learn.\t1\nIntroduction');
  // Custom table: one level, no page numbers.
  await ribbon(page).getByRole('button', { name: 'Table of Contents', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Custom Table of Contents…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Table of Contents' });
  await dialog.getByLabel('Show levels').fill('1');
  await dialog.getByLabel('Show page numbers').uncheck();
  await shot(page, 'toc-custom-dialog');
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect.poll(() => engineText(page)).toMatch(/^Contents\nIntroduction\nConclusion\nIntroduction/);
  const parts = await download(page, info, 'toc.docx');
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:instrText[^>]*> TOC \\o "1-1" \\h \\z \\n \\u <\/w:instrText>/);
  await ribbon(page).getByRole('button', { name: 'Table of Contents', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove Table of Contents' }).click();
  await expect.poll(() => engineText(page)).toMatch(/^Introduction\nEngines/);
});
