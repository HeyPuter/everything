import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { buildShape, EMU_PER_INCH } from '../src/engine/authored-shapes.js';
import { nextDrawingId } from '../src/engine/inserted-drawings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const save = async (pkg, doc) => new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
const ids = bytes => [...strFromU8(unzipSync(bytes)['word/document.xml']).matchAll(/<wp:docPr [^>]*?id="(\d+)"/g)].map(m => Number(m[1]));

it('numbers a new drawing past the pictures inside text boxes', async () => {
  const parts = unzipSync(readFileSync('tests/fixtures/textbox-pictures/control.docx'));
  // Outer drawings 1..8; the pictures inside the text boxes 9..16, as Word numbers them.
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(/(<wp:docPr [^>]*id=")(\d+)"/g, (m, a, n) => a + (n >= 200 ? n - 199 : n - 100 + 9) + '"'));
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).toBeFalsy();
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const id = nextDrawingId(doc);
  expect(id).toBe(17);
  const { image, asset } = buildShape({ id, name: `Rectangle ${id}`, preset: 'rect', width: EMU_PER_INCH, height: EMU_PER_INCH, fill: '4472C4', line: '2F528F', lineWidth: 12700,
    anchor: { horizontal: 'column', vertical: 'paragraph', x: 0, y: 0, wrap: 'none', behind: false, order: 99 }, assetId: 'drawing:canvas-shape-1' });
  doc.assets[image.assetId] = asset; doc.select(0);
  const { assetId, id: _id, ...props } = image;
  doc.insertImage(assetId, props);
  const saved = await save(pkg, doc), written = ids(saved);
  expect(new Set(written).size).toBe(written.length);
  expect((await DocxPackage.open(saved)).readOnly).toBeFalsy();
});

it('saves a drawing under the id the model gave it, not one left in its XML', async () => {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/textbox-pictures/control.docx'));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const run = doc.paragraphs.flatMap(p => p.runs).find(r => r.image?.shell);
  const fresh = nextDrawingId(doc);
  run.image = { ...run.image, id: fresh };
  expect(ids(await save(pkg, doc))).toContain(fresh);
});
