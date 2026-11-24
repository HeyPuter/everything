import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// The Footnote and Endnote dialog writes only the settings that were changed: Apply with nothing changed leaves
// settings.xml alone, and a footnote format change does not add endnote settings.
test('Footnote and Endnote Apply writes only changed note settings', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('A claim.');
  await onTab(page, 'references');
  const ribbon = page.locator('#ribbon-panel-references');
  const settings = async name => {
    const pending = page.waitForEvent('download');
    await downloadDocx(page);
    const path = info.outputPath(name); await (await pending).saveAs(path);
    return strFromU8(unzipSync(readFileSync(path))['word/settings.xml'] || new Uint8Array());
  };
  const before = await settings('before.docx');
  await ribbon.getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await settings('unchanged.docx')).toBe(before);
  await ribbon.getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  await dialog.getByLabel('Number format').selectOption('lowerRoman');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const changed = await settings('changed.docx');
  expect(changed).toContain('<w:footnotePr>');
  expect(changed).toContain('<w:numFmt w:val="lowerRoman"/>');
  expect(changed).not.toContain('endnotePr');
  expect(changed).not.toContain('numStart');
});

test('Footnote and endnote settings applied together are one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('A claim.');
  await onTab(page, 'references');
  const settings = () => page.evaluate(async () => {
    const blob = await window.__docs.current.view.commands.exportPackage();
    const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
    const part = unzipSync(new Uint8Array(await blob.arrayBuffer()))['word/settings.xml'];
    return part ? strFromU8(part) : '';
  });
  const steps = () => page.evaluate(() => window.__docs.current.view.engine.session.history.length);
  const before = await settings(), count = await steps();
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await dialog.getByLabel('Number format').selectOption('lowerRoman');
  await dialog.getByLabel('Endnotes').check();
  await dialog.getByLabel('Number format').selectOption('upperLetter');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const changed = await settings();
  expect(changed).toContain('<w:footnotePr>');
  expect(changed).toContain('<w:endnotePr>');
  expect(await steps()).toBe(count + 1);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+z');
  expect(await settings()).toBe(before);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+Shift+z');
  expect(await settings()).toBe(changed);
});

// A document numbering its footnotes 01, 02 (decimalZero), which the dialog does not list, showed a blank Number
// format; Insert then saved an empty format and the new note was not shown.
test('the Footnote and Endnote dialog keeps a number format it does not list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const type = (name, kind) => `<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`;
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${type('document.xml', 'document.main')}${type('footnotes.xml', 'footnotes')}${type('settings.xml', 'settings')}</Types>`),
    '_rels/.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rF" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="rS" Type="${R}/settings" Target="settings.xml"/></Relationships>`),
    'word/settings.xml': strToU8(`<w:settings xmlns:w="${W}"><w:footnotePr><w:numFmt w:val="decimalZero"/></w:footnotePr></w:settings>`),
    'word/footnotes.xml': strToU8(`<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note one</w:t></w:r></w:p></w:footnote></w:footnotes>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">A claim</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> and another.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  });
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'zero-padded-notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(bytes) });
  await expect(input).toHaveValue(/^A claim/);
  const notes = () => page.evaluate(() => window.__docs.current.view.engine.layout.footnoteAreas.flatMap(a => a.notes.map(n => n.display)));
  expect(await notes()).toEqual(['01']);
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.focus(); });
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await expect(dialog.getByLabel('Number format')).toHaveValue('decimalZero');
  await expect(dialog.getByLabel('Number format').locator('option:checked')).toHaveText('01, 02, 03, …');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect.poll(notes).toEqual(['01', '02']);
  expect(await page.evaluate(() => window.__docs.current.view.engine.pageStories.footnotes.format)).toBe('decimalZero');
});
