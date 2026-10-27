import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';

// A document's reviewers get their change colors in the order they appear. Those colors are part of
// every measured paragraph. They were given only after the document was first laid out, so the first
// keystroke measured the whole document again (and the changes' colors switched as it did); typing
// beside a tracked change also joined every paragraph's runs, with the same effect.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const change = (kind, author, id, text) => kind === 'ins'
  ? `<w:ins w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z">${run(text)}</w:ins>`
  : `<w:del w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
function reviewedDocx(count) {
  const body = Array.from({ length: count }, (_, i) => `<w:p>${run(`Paragraph ${i} starts here `)}${run('and goes on in a second run ')}${
    i % 5 === 2 ? change(i % 2 ? 'ins' : 'del', `Reviewer ${i % 3}`, 100 + i, 'with a tracked change ') : ''}${run('before it ends.')}</w:p>`).join('');
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]))));
}

for (const [where, paragraph, offset] of [['away from', 0, 3], ['beside', 2, 28]]) test(`the first keystroke ${where} a tracked change measures only its paragraph again`, async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  // Count the measured paragraphs that each layout cannot take from the cache.
  await page.evaluate(async () => {
    const { ParagraphMeasureCache } = await import('/src/engine/paragraph-measure-cache.js');
    const measure = ParagraphMeasureCache.prototype.measure;
    window.misses = 0;
    ParagraphMeasureCache.prototype.measure = function (key, ...rest) { if (!this.entries.has(key)) window.misses++; return measure.call(this, key, ...rest); };
  });
  const input = page.getByRole('textbox', { name: 'Document text', exact: true }), prior = await input.elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'reviewed.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: reviewedDocx(120) });
  await expect.poll(() => prior.evaluate(e => e.isConnected)).toBe(false);
  await expect(input).toHaveJSProperty('readOnly', false);
  await page.waitForTimeout(800);
  const at = await input.evaluate((el, [paragraph, offset]) => el.value.split('\n').slice(0, paragraph).reduce((n, line) => n + line.length + 1, 0) + offset, [paragraph, offset]);
  await input.evaluate((el, at) => { el.focus(); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select')); }, at);
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.misses = 0; });
  await page.keyboard.type('x');
  await expect(input).toHaveValue(/x/);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.misses)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
