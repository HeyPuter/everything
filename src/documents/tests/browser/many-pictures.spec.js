import { test, expect } from '@playwright/test';

// Each picture the editor saves is a part of its own. A document saved with a couple of thousand pictures had more
// ZIP items than the 2,000 the editor opened, and could not be opened again ("DOCX expanded size exceeds the editor
// limit"). Opening it also looked through every content type entry and relationship for each picture.
test('a document saved with thousands of pictures opens again for editing', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/playground.html');
  const saved = await page.evaluate(async () => {
    const { createDocx } = await import('/src/engine/docx.js');
    const { TextDocument, paragraph } = await import('/src/engine/model.js');
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAPUlEQVR42u3PQQkAAAgEsMtnMLMawww+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELhbh+DEAtSaHCQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const pkg = createDocx([paragraph('Catalogue')]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    doc.assets.p0 = { bytes: png, mime: 'image/png' };
    doc.select(doc.text.length); doc.insertImage('p0', { width: 91440, height: 57150 });
    // The picture inserted once, then as many more times as a long catalogue holds, each a picture of its own
    // (inserting them one by one does the same, slowly), one to a paragraph.
    const count = 2500, [first] = doc.paragraphs, run = first.runs.find(r => r.image), paragraphs = [first];
    for (let i = 1; i < count; i++) {
      doc.assets[`p${i}`] = { bytes: png.slice(), mime: 'image/png' };
      paragraphs.push({ ...first, runs: [{ ...run, image: { ...run.image, assetId: `p${i}`, id: run.image.id + i, name: `Picture ${run.image.id + i}` } }] });
    }
    const blob = pkg.export(paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  const buffer = Buffer.from(saved);
  const items = await page.evaluate(async bytes => Object.keys((await import('/node_modules/.vite/deps/fflate.js')).unzipSync(new Uint8Array(bytes))).length, saved);
  expect(items).toBeGreaterThan(2500);
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'catalogue.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Catalogue/, { timeout: 30000 });
  await expect(input).toBeEditable();
  expect(await input.inputValue()).toHaveLength('Catalogue'.length + 2500 * 2 - 1);
});
