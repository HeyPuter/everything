import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { TEXT_BOX_DESIGNS, WORDART_STYLES, textBoxParams, wordArtParams, signatureLineParams, textShapeXml } from '../src/engine/text-designs.js';
import { readDrawingFragment } from '../src/engine/inserted-drawings.js';
import { shapeParams } from '../src/engine/authored-shapes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));

async function roundTrip(params) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.replace('Text beside the drawing.'); doc.select(0);
  const { image, assets } = await readDrawingFragment(textShapeXml(params), { sourceParts: pkg.parts, assetId: 'drawing:inserted-test' });
  Object.assign(doc.assets, assets);
  const { assetId, id, ...properties } = image;
  doc.insertImage(assetId, properties);
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  expect(reopened.readOnly).toBeFalsy();
  return { image, saved: images(reopened)[0], reopened };
}

it('every text box design inserts as an editable text shape and reopens as one', async () => {
  for (const design of TEXT_BOX_DESIGNS) {
    const { saved, reopened } = await roundTrip(textBoxParams(design, { id: 1, order: 1 }));
    expect(saved.anchor, design.id).toMatchObject({ horizontal: 'column', wrap: 'square' });
    const params = shapeParams(saved);
    expect(params?.text, design.id).toBeTruthy();
    expect(reopened.drawingTextFrames(saved, reopened.assets).length, design.id).toBe(1);
  }
});

it('every WordArt style keeps its text effects through saving', async () => {
  for (const style of WORDART_STYLES) {
    const { saved } = await roundTrip(wordArtParams(style, { id: 1, text: 'Hello' }));
    expect(saved.shell, style.id).toContain('Hello');
    if (style.run.outline) expect(saved.shell).toMatch(/textOutline/);
    if (style.run.shadow) expect(saved.shell).toMatch(/w14:shadow/);
  }
});

it('a signature line carries signer and title', async () => {
  const { saved } = await roundTrip(signatureLineParams({ id: 1, signer: 'Sam Lee', title: 'Director', date: true }));
  expect(saved.shell).toContain('Sam Lee');
  expect(saved.shell).toContain('Director');
  expect(saved.shell).toMatch(/X_{10}/);
});

it('draws the signature rule on one line of the box, also in a narrow table cell', () => {
  for (const width of [undefined, 2 * 914400, 1.2 * 914400]) {
    const params = signatureLineParams({ id: 1, signer: 'Sam Lee', ...(width ? { width } : {}) });
    expect(params.width).toBe(Math.round(Math.min(3 * 914400, width ?? Infinity)));
    const lowLines = (params.text.match(/X(_+)</) || [])[1].length;
    // Each 14 pt low line is at most 7.8 pt wide; the X and the rule stay within the box's insets.
    expect(10 + (lowLines + 1) * 7.8).toBeLessThanOrEqual((params.width - 2 * 45720) / 12700);
    expect(lowLines).toBeGreaterThanOrEqual(4);
  }
});

it('fits each text box design to a narrower text column or table cell', () => {
  for (const design of TEXT_BOX_DESIGNS) {
    expect(textBoxParams(design, { id: 1 }).width).toBe(Math.round(Math.min(design.width, 6.5) * 914400));
    const narrow = textBoxParams(design, { id: 1, textWidth: 1.5 * 914400 });
    expect(narrow.width).toBe(Math.round(Math.min(design.width, 1.5) * 914400));
    expect(narrow.anchor.x + narrow.width).toBeLessThanOrEqual(1.5 * 914400);
  }
});
