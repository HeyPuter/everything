import { test, expect } from '@playwright/test';

// Chrome's XMLSerializer repeats the parsed declaration's encoding label. Parts
// read from UTF-16 are written back as UTF-8 bytes, so every rewritten part must
// declare UTF-8: an XML processor rejects a UTF-8 entity labelled UTF-16.
test('rewritten UTF-16 package parts declare the UTF-8 they are saved in', async ({ page }) => {
  await page.goto('/playground.html');
  const parts = await page.evaluate(async () => {
    const { DocxPackage, createDocx } = await import('/src/engine/docx.js');
    const { TextDocument } = await import('/src/engine/model.js');
    const { unzipSync, zipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
    const utf16 = text => {
      text = '<?xml version="1.0" encoding="UTF-16" standalone="yes"?>' + text.replace(/^<\?xml[^>]*\?>/, '');
      const bytes = new Uint8Array(2 + text.length * 2); bytes[0] = 0xff; bytes[1] = 0xfe;
      for (let i = 0; i < text.length; i++) { bytes[2 + i * 2] = text.charCodeAt(i) & 255; bytes[3 + i * 2] = text.charCodeAt(i) >> 8; }
      return bytes;
    };
    const source = unzipSync(new Uint8Array(await createDocx().export().arrayBuffer()));
    for (const name of Object.keys(source)) source[name] = utf16(strFromU8(source[name]));
    const pkg = await DocxPackage.open(zipSync(source));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    doc.select(0); doc.replace('Café ');
    // Turning on Track Changes creates settings.xml, adding a relationship and a content type.
    const saved = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets, undefined, undefined, true).arrayBuffer()));
    const reopened = await DocxPackage.open(zipSync(saved));
    return { text: new TextDocument(reopened.paragraphs).text, parts: Object.fromEntries(Object.entries(saved).filter(([, bytes]) => bytes[0] !== 0xff).map(([name, bytes]) => [name, strFromU8(bytes).slice(0, 80)])) };
  });
  expect(parts.text.startsWith('Café ')).toBe(true);
  expect(Object.keys(parts.parts).sort()).toEqual(['[Content_Types].xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/settings.xml']);
  for (const [name, start] of Object.entries(parts.parts)) expect(start, name).not.toMatch(/encoding=["']UTF-16/i);
});
