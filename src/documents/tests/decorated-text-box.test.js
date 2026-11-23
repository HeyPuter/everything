import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// A text box holding a hyperlink, underlined, struck through, highlighted or shaded text opens editable
// (it opened read-only), shows that text as body text shows it, and is saved as it was.
// Fixture: tools/decorated_text_box_fixture.py.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const source = readFileSync('tests/fixtures/decorated-text-box/control.docx');
const drawingXml = xml => xml.match(/<w:drawing\b[\s\S]*?<\/w:drawing>/)[0].replace(/\s+xmlns(:\w+)?="[^"]*"/g, '').replace(/<w:hyperlink w:history="1" r:id="rLink">/, '<w:hyperlink r:id="rLink" w:history="1">');

it('opens editable with the text box\'s link and decorations read into its scene', async () => {
  const pkg = await DocxPackage.open(new Uint8Array(source));
  expect(pkg.readOnly).toBeFalsy();
  const image = pkg.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  const runs = pkg.assets[image.assetId].scene.text.paragraphs.flatMap(p => p.runs);
  const run = text => runs.find(r => r.text === text);
  expect(run('the site').link).toBeTruthy();
  expect(run('Single').underline).toBeTruthy();
  expect(run('wavy').underline).toBeTruthy();
  expect(run('Struck').strikethrough).toBe('single');
  expect(run('double').strikethrough).toBe('double');
  expect(run('Marked').highlight).toBe('yellow');
  expect(run('shaded').shading).toBe('C6E0B4');
  // Its text can't be edited here (the link would have to be rewritten), which the frame says.
  expect(pkg.drawingTextFrames(image)[0].reason).toMatch(/links/);
});

it('keeps the text box and its link exactly when the body around it is edited', async () => {
  const pkg = await DocxPackage.open(new Uint8Array(source));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(0); doc.replace('Edited: ');
  const out = unzipSync(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  const before = unzipSync(new Uint8Array(source));
  expect(drawingXml(strFromU8(out['word/document.xml']))).toBe(drawingXml(strFromU8(before['word/document.xml'])));
  expect(strFromU8(out['word/_rels/document.xml.rels'])).toContain('Target="https://example.com/"');
  expect(strFromU8(out['word/document.xml'])).toContain('Edited: Before the text box');
});
