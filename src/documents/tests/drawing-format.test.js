import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureFragment } from '../src/engine/picture-insert.js';
import { materializeDrawing, readFormattedDrawing, drawingParts, drawingKind, xml, A } from '../src/engine/drawing-format.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const png = new Uint8Array(readFileSync('icon-128.png'));
const images = p => p.paragraphs.flatMap(q => q.runs.filter(r => r.image).map(r => r.image));
const modelOf = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const exportBytes = async (pkg, doc) => new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());
/** placeDrawing without decoding bitmaps: register the fragment's assets and replace the drawing in one transaction. */
function place(doc, image, fragment) {
  Object.assign(doc.assets, fragment.assets);
  doc.checkpoint();
  for (const p of doc.paragraphs) for (const run of p.runs) if (run.image === image) run.image = fragment.image;
  doc.didChange();
}
async function savedPicture() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = modelOf(pkg);
  doc.replace('Picture: ');
  const fragment = await pictureFragment(doc, pkg.parts, { png, width: 914400, height: 914400, id: 1, name: 'Picture 1' });
  Object.assign(doc.assets, fragment.assets);
  const { assetId, id, ...properties } = fragment.image;
  doc.insertImage(assetId, properties);
  const reopened = await DocxPackage.open(await exportBytes(pkg, doc));
  return { pkg: reopened, doc: modelOf(reopened) };
}

describe('drawing formatting through DrawingML', () => {
  it('rewrites a saved picture, keeps its media part and saves the new XML', async () => {
    const { pkg, doc } = await savedPicture();
    const image = images(doc)[0];
    expect(drawingKind(image)).toBe('picture');
    const { drawing, parts } = materializeDrawing(pkg, doc, image);
    expect([...parts.values()].every(part => part.existing)).toBe(true);
    const { blip, docPr } = drawingParts(drawing);
    blip.append(xml.make(drawing.ownerDocument, A, 'lum', { bright: 20000, contrast: -10000 }));
    docPr.setAttribute('descr', 'A brighter icon');
    const fragment = await readFormattedDrawing(pkg, doc, image, drawing, parts);
    expect(fragment.image.id).toBe(image.id);
    expect(fragment.image.alt).toBe('A brighter icon');
    expect(Object.values(fragment.assets).flatMap(asset => asset.packageParts || [])).toEqual([]);
    place(doc, image, fragment);
    const saved = unzipSync(await exportBytes(pkg, doc));
    const body = strFromU8(saved['word/document.xml']);
    expect(body).toMatch(/<a:lum bright="20000" contrast="-10000"\/>/);
    expect(Object.keys(saved).filter(path => path.startsWith('word/media/'))).toHaveLength(1);
    const reopened = await DocxPackage.open(await exportBytes(pkg, doc));
    expect(reopened.readOnly).toBeFalsy();
    expect(images(reopened)[0].alt).toBe('A brighter icon');
    // Undo restores the previous drawing exactly.
    doc.undo();
    expect(images(doc)[0]).toEqual(image);
  });

  it('materializes a picture inserted in this session with its pending changes', async () => {
    const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const doc = modelOf(pkg);
    doc.assets['canvas-image-1'] = { bytes: png, mime: 'image/png' };
    doc.insertImage('canvas-image-1', { width: 914400, height: 457200, alt: 'Plain' });
    doc.select(0, 1);
    doc.setImageProperties({ crop: { left: 10000, top: 0, right: 0, bottom: 0 }, rotation: 0, flipH: true });
    const image = images(doc)[0];
    const { drawing, parts } = materializeDrawing(pkg, doc, image);
    const [part] = [...parts.values()];
    expect(part.existing).toBe(false);
    expect(new XMLSerializer().serializeToString(drawing)).toMatch(/srcRect l="10000"/);
    const fragment = await readFormattedDrawing(pkg, doc, image, drawing, parts);
    expect(fragment.image.crop.left).toBe(10000);
    expect(fragment.image.flipH).toBe(true);
    // The new media part is written while the picture uses it.
    expect(Object.values(fragment.assets).flatMap(asset => asset.packageParts || [])).toHaveLength(1);
    place(doc, image, fragment);
    const saved = unzipSync(await exportBytes(pkg, doc));
    expect(Object.keys(saved).filter(path => path.startsWith('word/media/'))).toHaveLength(1);
    expect((await DocxPackage.open(await exportBytes(pkg, doc))).readOnly).toBeFalsy();
  });
});
