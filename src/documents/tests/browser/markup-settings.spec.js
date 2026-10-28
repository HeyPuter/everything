import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** A document with a tracked insertion and a tracked deletion; `view` is its settings' revisionView element. */
function trackedDocx(view = '') {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    'word/settings.xml': `<w:settings xmlns:w="${W}">${view}<w:defaultTabStop w:val="720"/></w:settings>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve"> removed</w:delText></w:r></w:del><w:r><w:t xml:space="preserve"> end.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}
async function open(page, name, buffer) {
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue('Keep added removed end.');
}
async function shown(page, name) {
  const tab = page.getByRole('tab', { name: 'Review' });
  if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Show Markup', exact: true }).click();
  const item = page.getByRole('menuitemcheckbox', { name, exact: true });
  const checked = await item.getAttribute('aria-checked');
  await page.keyboard.press('Escape');
  return checked === 'true';
}

test('a document opens with its own Show Markup choices, not those of the document opened before it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('textbox', { name: 'Document text' }).waitFor();
  await open(page, 'hidden.docx', trackedDocx('<w:revisionView w:insDel="0" w:formatting="0"/>'));
  expect(await shown(page, 'Insertions and Deletions')).toBe(false);
  expect(await shown(page, 'Formatting')).toBe(false);
  await open(page, 'shown.docx', trackedDocx());
  expect(await shown(page, 'Insertions and Deletions')).toBe(true);
  expect(await shown(page, 'Formatting')).toBe(true);
  // Its deletion is struck through on the page, so the balloons and bars list it.
  await expect(page.locator('#ribbon-panel-review').getByRole('button', { name: 'Accept options' })).toBeEnabled();
  expect(errors).toEqual([]);
});
