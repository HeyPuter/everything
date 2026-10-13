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
/** A group the window is too narrow for opens from its collapsed button. */
async function openGroup(page, id) {
  const collapsed = page.locator(`#ribbon-panel-references [data-group="${id}"] .ribbon-collapsed`);
  if (await collapsed.isVisible()) await collapsed.click();
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
    await expect(ribbon(page).locator('.ribbon-group-body').getByRole('button', { name, exact: true, includeHidden: true }), name).toHaveCount(1);
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

test('footnotes and endnotes: insert, navigate, settings, convert and save', async ({ page }, info) => {
  await openEditor(page);
  await page.keyboard.type('First claim. Second claim.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('.')); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
  await page.keyboard.type('A footnote.');
  await page.keyboard.press('Escape');
  await input(page).press('ControlOrMeta+End'); await input(page).press('ArrowLeft');
  await input(page).press(process.platform === 'darwin' ? 'Meta+Alt+e' : 'Control+Alt+d');
  await expect(page.getByRole('textbox', { name: 'Endnote text' })).toBeFocused();
  await page.keyboard.type('An endnote.');
  const layoutNotes = () => page.evaluate(() => { const l = window.__docs.current.view.engine.layout; return { foot: l.footnoteAreas?.flatMap(a => a.notes.map(n => n.display)), end: l.endnoteAreas?.flatMap(a => a.notes.map(n => n.display)) }; });
  expect(await layoutNotes()).toEqual({ foot: ['1'], end: ['i'] });
  await shot(page, 'notes-on-page');
  // Show Notes returns to the reference; Next Footnote moves between references.
  await ribbon(page).getByRole('button', { name: 'Show Notes', exact: true }).click();
  await expect(input(page)).toBeFocused();
  await ribbon(page).getByRole('button', { name: 'Next Footnote', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Next Footnote', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.model.range[0])).toBe(12);
  // Settings: symbols for footnotes, restart for endnotes; Apply keeps the dialog open.
  await ribbon(page).getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await expect(dialog.getByLabel('Numbering')).toHaveValue('continuous');
  await dialog.getByLabel('Number format').selectOption('chicago');
  await shot(page, 'notes-dialog');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(layoutNotes).toEqual({ foot: ['*'], end: ['i'] });
  await dialog.getByRole('button', { name: 'Convert…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Convert Notes' }).getByLabel('Swap footnotes and endnotes').check();
  await page.getByRole('dialog', { name: 'Convert Notes' }).getByRole('button', { name: 'Convert', exact: true }).click();
  await expect.poll(layoutNotes).toEqual({ foot: ['*'], end: ['i'] });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const parts = await download(page, info, 'notes.docx');
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml.indexOf('w:endnoteReference')).toBeLessThan(xml.indexOf('w:footnoteReference'));
  expect(strFromU8(parts['word/endnotes.xml'])).toContain('A footnote.');
  expect(strFromU8(parts['word/footnotes.xml'])).toContain('An endnote.');
  expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:footnotePr>.*<w:numFmt w:val="chicago"\/>/);
});

test('citations, sources and bibliography follow the chosen style', async ({ page }, info) => {
  await openEditor(page);
  await page.keyboard.type('Engines compute.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('.')); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Citation', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add New Source…' }).click();
  const source = page.getByRole('dialog', { name: 'Create Source' });
  await source.getByLabel('Type of source').selectOption('JournalArticle');
  await source.getByLabel('Author', { exact: true }).fill('Lovelace, Ada');
  await source.getByLabel('Title', { exact: true }).fill('Notes on engines');
  await source.getByLabel('Journal name').fill('Machine Review');
  await source.getByLabel('Year', { exact: true }).fill('2020');
  await source.getByLabel('Volume').fill('4');
  await source.getByLabel('Pages').fill('1-9');
  await expect(source.locator('.ref-source-entry')).toHaveText('Lovelace, A. (2020). Notes on engines. Machine Review, 4, 1–9.');
  await shot(page, 'source-dialog');
  await source.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(() => engineText(page)).toBe('Engines compute (Lovelace, 2020).'.replace(' (', '('));
  // A bibliography from the gallery, then a style change updates both.
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.length); m.replace('\n'); });
  await ribbon(page).getByRole('button', { name: 'Bibliography', exact: true }).click();
  await shot(page, 'bibliography-gallery');
  await page.getByRole('menuitem', { name: /^References:/ }).click();
  await expect.poll(() => engineText(page)).toContain('References\nLovelace, A. (2020). Notes on engines. Machine Review, 4, 1–9.');
  await ribbon(page).getByRole('combobox', { name: 'Citation style' }).selectOption('mla');
  await expect.poll(() => engineText(page)).toContain('Engines compute(Lovelace).\nReferences\nLovelace, Ada. “Notes on engines.” Machine Review, vol. 4, 2020, pp. 1–9.');
  // Manage Sources: the master list remembers the source.
  await ribbon(page).getByRole('button', { name: 'Manage Sources', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Source Manager' });
  await expect(manager.getByRole('listbox', { name: 'Master list' }).getByRole('option')).toHaveText(['Lovelace, Notes on engines (2020)']);
  await expect(manager.getByRole('listbox', { name: 'Current list' }).getByRole('option')).toHaveText(['✓ Lovelace, Notes on engines (2020)']);
  await manager.getByRole('listbox', { name: 'Current list' }).selectOption({ index: 0 });
  await expect(manager.locator('.ref-source-preview')).toContainText('Bibliography entry: Lovelace, Ada.');
  await shot(page, 'manage-sources');
  await manager.getByRole('button', { name: 'Done', exact: true }).click();
  const parts = await download(page, info, 'citations.docx');
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml).toMatch(/<w:instrText[^>]*> CITATION Lov20 \\l 1033 <\/w:instrText>/);
  expect(xml).toMatch(/<w:instrText[^>]*> BIBLIOGRAPHY \\l 1033 <\/w:instrText>/);
  const item = Object.keys(parts).find(n => /^customXml\/item\d+\.xml$/.test(n));
  expect(strFromU8(parts[item])).toContain('StyleName="MLA Ninth Edition"');
  expect(strFromU8(parts[item])).toContain('<b:Tag>Lov20</b:Tag><b:SourceType>JournalArticle</b:SourceType>');
});

test('captions, cross-references and a table of figures', async ({ page }, info) => {
  await openEditor(page);
  await page.keyboard.type('Chart one');
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Caption', exact: true }).click();
  const caption = page.getByRole('dialog', { name: 'Caption' });
  await caption.getByLabel('Caption text').fill('Revenue');
  await caption.getByLabel('Numbering').selectOption('ROMAN');
  await expect(caption.locator('.ref-caption-preview')).toHaveText('Figure I: Revenue');
  await shot(page, 'caption-dialog');
  await caption.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(() => engineText(page)).toBe('Chart one\nFigure I: Revenue');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Enter'); await page.keyboard.type('See ');
  await ribbon(page).getByRole('button', { name: 'Cross-reference', exact: true }).click();
  const xref = page.getByRole('dialog', { name: 'Cross-reference' });
  await xref.getByLabel('Reference type').selectOption('Figure');
  await xref.getByLabel('Insert reference to').selectOption('entire');
  await xref.getByLabel('Include above/below').check();
  await shot(page, 'xref-dialog');
  await xref.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toBe('Chart one\nFigure I: Revenue\nSee Figure I: Revenue above');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await ribbon(page).getByRole('button', { name: 'Insert Table of Figures', exact: true }).click();
  const figures = page.getByRole('dialog', { name: 'Table of Figures' });
  await expect(figures.getByLabel('Caption label')).toHaveValue('Figure');
  await figures.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('\nFigure I: Revenue\t1\n');
  await expect(ribbon(page).getByRole('button', { name: 'Update Table of Figures', exact: true })).toBeEnabled();
  const xml = strFromU8((await download(page, info, 'captions.docx'))['word/document.xml']);
  expect(xml).toMatch(/SEQ Figure \\\* ROMAN/);
  expect(xml).toMatch(/ REF _Ref\d+ \\h /);
  expect(xml).toMatch(/ REF _Ref\d+ \\p \\h /);
  expect(xml).toMatch(/ TOC \\c "Figure" \\h \\z /);
});

test('index entries, the index and a table of authorities', async ({ page }, info) => {
  await openEditor(page);
  await page.keyboard.type('Mercury is hot. Venus is cloudy. Mercury is small. Smith v. Jones, 1 U.S. 1 (1999), decided it.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(0, 7); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Mark Entry', exact: true }).click();
  const mark = page.getByRole('dialog', { name: 'Mark Index Entry' });
  await expect(mark.getByLabel('Main entry')).toHaveValue('Mercury');
  await mark.getByLabel('Subentry').fill('planet');
  await shot(page, 'mark-entry');
  await mark.getByRole('button', { name: 'Mark All', exact: true }).click();
  await expect(mark.getByText('2 entries marked.')).toBeVisible();
  // The panel stays open while other text is selected.
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model, at = m.text.indexOf('Venus'); m.select(at, at + 5); });
  // Coming back to the panel picks up the new selection.
  await mark.getByLabel('Subentry').focus();
  await expect(mark.getByLabel('Main entry')).toHaveValue('Venus');
  await expect(mark.getByLabel('Subentry')).toHaveValue('');
  await mark.getByLabel('Bold').check();
  await mark.getByRole('button', { name: 'Mark', exact: true }).click();
  await mark.getByRole('button', { name: 'Close Mark Index Entry' }).click();
  // Entries are hidden text: the document text is unchanged.
  expect(await engineText(page)).toBe('Mercury is hot. Venus is cloudy. Mercury is small. Smith v. Jones, 1 U.S. 1 (1999), decided it.');
  await input(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await ribbon(page).getByRole('button', { name: 'Insert Index', exact: true }).click();
  const index = page.getByRole('dialog', { name: 'Index' });
  await index.getByLabel('Formats').selectOption('letters');
  await index.getByLabel('Columns').fill('1');
  await shot(page, 'index-dialog');
  await index.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('\nM\nMercury\nplanet, 1\nV\nVenus, 1');
  // Table of authorities.
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model, t = 'Smith v. Jones, 1 U.S. 1 (1999)', at = m.text.indexOf(t); m.select(at, at + t.length); });
  await page.getByRole('tab', { name: 'References', exact: true }).click();
  await openGroup(page, 'authorities');
  await page.getByRole('button', { name: 'Mark Citation', exact: true }).click();
  const cite = page.getByRole('dialog', { name: 'Mark Citation' });
  await cite.getByLabel('Short citation').fill('Smith v. Jones');
  await cite.getByRole('button', { name: 'Mark', exact: true }).click();
  await expect(cite.getByText('1 citation marked.')).toBeVisible();
  await cite.getByRole('button', { name: 'Close Mark Citation' }).click();
  await input(page).press('ControlOrMeta+End'); await page.keyboard.press('Enter');
  await openGroup(page, 'authorities');
  await page.getByRole('button', { name: 'Insert Table of Authorities', exact: true }).click();
  const toa = page.getByRole('dialog', { name: 'Table of Authorities' });
  await toa.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(() => engineText(page)).toContain('\nCases\nSmith v. Jones, 1 U.S. 1 (1999)\t1');
  const xml = strFromU8((await download(page, info, 'index.docx'))['word/document.xml']);
  expect(xml).toMatch(/ XE "Mercury:planet" <\/w:instrText>/);
  expect(xml).toMatch(/ XE "Venus" \\b <\/w:instrText>/);
  expect(xml).toMatch(/ INDEX \\h "A" \\c "1" \\z "1033" <\/w:instrText>/);
  expect(xml).toMatch(/ TA \\l "Smith v\. Jones, 1 U\.S\. 1 \(1999\)" \\s "Smith v\. Jones" \\c 1 <\/w:instrText>/);
  expect(xml).toMatch(/ TOA \\h \\c "1" \\p <\/w:instrText>/);
});

test('Smart Lookup explains the selection, and the menus offer References commands', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.type('The aphelion of an orbit is far.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model, at = m.text.indexOf('aphelion'); m.select(at + 2); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Smart Lookup', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Smart Lookup' });
  await expect(pane.locator('.ref-lookup-term')).toHaveText('aphelion');
  await expect(pane.locator('.ref-lookup-definition')).toHaveText('aphelion is a sample term explained by the offline mock.');
  await expect(pane.getByRole('button', { name: 'aphelion history' })).toBeVisible();
  await shot(page, 'smart-lookup');
  await pane.getByRole('button', { name: 'Close Smart Lookup pane' }).click();
  await expect(pane).toBeHidden();
  // The document menu offers Smart Lookup for text.
  await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 160, y: 110 } });
  await expect(page.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name: 'Smart Lookup', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  // The menu-bar contract: Insert holds the References commands.
  const items = await page.evaluate(() => window.__docs.current.view.engine && null);
  expect(items).toBeNull();
});

test('the References tab fits a phone screen', async ({ page }) => {
  await openEditor(page, 390);
  await onTab(page, 'references');
  await shot(page, 'references-390');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Caption', exact: true }).click();
  const box = await page.getByRole('dialog', { name: 'Caption' }).boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  await shot(page, 'caption-390');
});
