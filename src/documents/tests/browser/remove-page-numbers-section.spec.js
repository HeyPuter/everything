import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { onTab } from './helpers/editor-tools.js';

// Remove Page Numbers works on the section whose footer is being edited, not on the section where the caret
// was last left in the text.
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const footer = name => `<w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">${name} page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
const section = id => `<w:sectPr><w:footerReference w:type="default" r:id="${id}"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

test('Remove Page Numbers from a footer removes that section\'s page numbers', async ({ page }, info) => {
  const parts = unzipSync(readFileSync('public/fixtures/toc-pageref.docx'));
  const types = strFromU8(parts['[Content_Types].xml']);
  parts['[Content_Types].xml'] = strToU8(types.replace('</Types>', ['one', 'two'].map(n => `<Override PartName="/word/footer-${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`).join('') + '</Types>'));
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', ['one', 'two'].map(n => `<Relationship Id="f${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer-${n}.xml"/>`).join('') + '</Relationships>'));
  parts['word/footer-one.xml'] = strToU8(footer('First section'));
  parts['word/footer-two.xml'] = strToU8(footer('Second section'));
  parts['word/document.xml'] = strToU8(`<w:document ${W}><w:body><w:p><w:pPr>${section('fone')}</w:pPr><w:r><w:t>Section one</w:t></w:r></w:p><w:p><w:r><w:t>Section two</w:t></w:r></w:p>${section('ftwo')}</w:body></w:document>`);
  const path = info.outputPath('two-footers.docx'); writeFileSync(path, zipSync(parts));
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect(input).toHaveValue('Section one\nSection two');
  await expect(input).toHaveJSProperty('readOnly', false);
  const footers = () => page.evaluate(() => { const e = window.__docs.current.view.engine; return Object.fromEntries(Object.entries(e.pageStories.stories).map(([p, s]) => [p, s.paragraphs.map(q => q.runs.map(r => r.text).join('')).join('\n')])); });
  // The caret was last in the first section's text; the second section's footer is open.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine; e.model.select(2);
    const line = e.storyLayout.lines.find(l => e.pageStories.stories[l.pageStory]?.kind === 'footer' && l.pageStory.endsWith('footer-two.xml'));
    e.editStory(line.pageStory, line.page); e.focus();
  });
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Page Number', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove Page Numbers', exact: true }).click();
  await expect.poll(footers).toEqual({ 'word/footer-one.xml': 'First section page ￼', 'word/footer-two.xml': '' });
});
