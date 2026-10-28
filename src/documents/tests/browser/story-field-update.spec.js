import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';

// F9 in a header updates that header's DATE and FILENAME fields, and the update saves.
test('F9 in a header updates its date and file name fields', async ({ page }, info) => {
  const parts = unzipSync(readFileSync('public/fixtures/page-number-parts.docx'));
  const complex = (code, cached) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${code} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${cached}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  parts['word/header1.xml'] = strToU8(`<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t xml:space="preserve">Printed </w:t></w:r>${complex('DATE \\@ "yyyy-MM-dd"', '2000-01-01')}<w:r><w:t xml:space="preserve"> · </w:t></w:r>${complex('FILENAME', 'old.docx')}</w:p></w:hdr>`);
  const path = info.outputPath('header-fields.docx'); writeFileSync(path, zipSync(parts));
  await page.goto('/mock.html');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toBeVisible();
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect(input).toHaveValue(/^Body page 1/);
  await expect(input).toHaveJSProperty('readOnly', false);
  const fields = () => page.evaluate(() => window.__docs.current.view.engine.pageStories.stories['word/header1.xml'].paragraphs[0].runs.filter(r => r.field).map(r => r.field.cachedText));
  await page.evaluate(() => { const e = window.__docs.current.view.engine, line = e.storyLayout.lines.find(l => l.pageStory === 'word/header1.xml'); e.editStory('word/header1.xml', line.page); e.model.select(2); e.focus(); });
  expect(await fields()).toEqual(['2000-01-01', 'old.docx']);
  await page.keyboard.press('F9');
  const today = await page.evaluate(() => { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; });
  await expect.poll(fields).toEqual([today, expect.stringMatching(/\.docx$/)]);
  expect((await fields())[1]).not.toBe('old.docx');
  expect(await page.evaluate(() => [window.__docs.current.view.engine.session.path, window.__docs.current.view.engine.model.range])).toEqual(['word/header1.xml', [2, 2]]);
  const pending = page.waitForEvent('download');
  await downloadDocx(page);
  const saved = info.outputPath('saved.docx'); await (await pending).saveAs(saved);
  expect(strFromU8(unzipSync(readFileSync(saved))['word/header1.xml'])).toContain(`<w:t xml:space="preserve">${today}</w:t>`);
});
