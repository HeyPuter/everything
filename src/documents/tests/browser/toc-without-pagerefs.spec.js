import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from 'fflate';

// LibreOffice writes a table of contents whose page numbers are plain text, not PAGEREF fields
// (TOC \f \o "1-9" \h in a Table of Contents docPartObj). "Update page numbers only" has nothing to refresh there.
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const heading = (text, id) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="${id}" w:name="__RefHeading___Toc${id}_1"/><w:r><w:t>${text}</w:t></w:r><w:bookmarkEnd w:id="${id}"/></w:p>`;
const entry = (text, id, first, last) => `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8640"/></w:tabs></w:pPr>${first ? '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\f \\o "1-9" \\h</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' : ''}<w:hyperlink w:anchor="__RefHeading___Toc${id}_1"><w:r><w:t>${text}</w:t><w:tab/><w:t>1</w:t></w:r></w:hyperlink>${last ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : ''}</w:p>`;

test('Update page numbers only explains why a table without page-number fields was not updated', async ({ page }, info) => {
  const parts = unzipSync(readFileSync('public/fixtures/toc-pageref.docx'));
  parts['word/document.xml'] = strToU8(`<w:document ${W}><w:body><w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique w:val="true"/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Table of Contents</w:t></w:r></w:p>${entry('Alpha', 1, true, false)}${entry('Beta', 2, false, true)}</w:sdtContent></w:sdt>${heading('Alpha', 1)}<w:p><w:r><w:t>Text</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>${heading('Beta', 2)}<w:p><w:r><w:t>More</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  const path = info.outputPath('plain-page-toc.docx'); writeFileSync(path, zipSync(parts));
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect(input).toHaveValue(/^Table of Contents\nAlpha\t1\nBeta\t1\n/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.locator('#ribbon-tab-references').click();
  const ribbon = page.locator('#ribbon-panel-references');
  await ribbon.getByRole('button', { name: 'Update Table', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Update Table of Contents' });
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  // The dialog stays open and says why, so the other choice is one click away.
  await expect(dialog.getByRole('alert')).toHaveText(/no page-number fields to update.*Update entire table/);
  await expect(input).toHaveValue(/^Table of Contents\nAlpha\t1\nBeta\t1\n/);
  await dialog.getByLabel('Update entire table (new entries and text)').check();
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(input).toHaveValue(/^Table of Contents\nAlpha\t1\nBeta\t2\n/);
});
