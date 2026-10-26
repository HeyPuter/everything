import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { setImageWrap, imageWrapMode, wrapUnavailable } from '../src/engine/image-wrap.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
// A 1×1 PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const imagesOf = doc => doc.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
async function save(pkg, doc) {
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, reopened: await DocxPackage.open(bytes) };
}
function pictureDocument() {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.replace('Text beside a picture.'); doc.select(5);
  doc.assets['canvas-image-1'] = { bytes: PNG, mime: 'image/png' };
  doc.insertImage('canvas-image-1', { width: 914400, height: 914400, alt: 'Dot' });
  return { pkg, doc };
}

it('floats a new picture with square, top-and-bottom, behind and in-front wrapping and returns it in line', async () => {
  const { pkg, doc } = pictureDocument();
  expect(imageWrapMode(doc.selectedImage)).toBe('inline');
  expect(setImageWrap(doc, 'square', { x: 457200, y: 12700 })).toBe(true);
  expect(doc.selectedImage.anchor).toMatchObject({ horizontal: 'column', vertical: 'paragraph', wrap: 'square', x: 457200, y: 12700 });
  let { reopened } = await save(pkg, doc);
  expect(imagesOf(reopened)[0].anchor).toMatchObject({ wrap: 'square', wrapText: 'bothSides', x: 457200, y: 12700, distances: { L: 114300, R: 114300, T: 0, B: 0 } });
  for (const [mode, expected] of [['topAndBottom', { wrap: 'topAndBottom' }], ['behind', { wrap: 'none', behind: true }], ['front', { wrap: 'none', behind: false }]]) {
    setImageWrap(doc, mode);
    ({ reopened } = await save(pkg, doc));
    const saved = imagesOf(reopened)[0];
    expect(saved.anchor, mode).toMatchObject({ ...expected, x: 457200, y: 12700 });
    expect(imageWrapMode(saved)).toBe(mode);
  }
  setImageWrap(doc, 'inline');
  ({ reopened } = await save(pkg, doc));
  expect(imagesOf(reopened)[0].anchor).toBeUndefined();
  expect(imagesOf(reopened)[0].alt).toBe('Dot');
});

it('rewrites an imported picture frame only when its wrapping changes', async () => {
  // Uses standard prefixes: jsdom's serializer drops a reused generated prefix (ns0) between siblings,
  // which browsers do not; tests/browser/picture-wrap.spec.js covers such a document in Chrome.
  const bytes = readFileSync('public/fixtures/inline-images.docx');
  const pkg = await DocxPackage.open(bytes);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const at = [...doc.text.matchAll(/\ufffc/g)].map(m => m.index).find(index => { doc.select(index, index + 1); return doc.selectedImage && !doc.selectedImage.anchor && !wrapUnavailable(doc.selectedImage, 'square'); });
  expect(at, 'an inline picture in the control').toBeGreaterThanOrEqual(0);
  doc.select(at, at + 1);
  const { id, alt, width, height } = doc.selectedImage;
  setImageWrap(doc, 'square', { x: 228600, y: 0 });
  let { reopened } = await save(pkg, doc);
  let saved = imagesOf(reopened).find(image => image.id === id);
  expect(saved).toMatchObject({ alt, width, height });
  expect(saved.anchor).toMatchObject({ wrap: 'square', horizontal: 'column', vertical: 'paragraph', x: 228600, y: 0 });
  setImageWrap(doc, 'inline');
  ({ reopened } = await save(pkg, doc));
  saved = imagesOf(reopened).find(image => image.id === id);
  expect(saved.anchor).toBeUndefined();
});

it('explains which drawings keep their wrapping', () => {
  expect(wrapUnavailable({ anchor: { relativeSize: {} } }, 'square')).toMatch(/relative/);
  expect(wrapUnavailable({ rotation: 5400000 }, 'square')).toMatch(/in front of or behind/);
  expect(wrapUnavailable({ rotation: 5400000 }, 'front')).toBe(null);
});

it('changes the wrapping of a shape stored as alternate content and keeps saving', async () => {
  // Word stores shapes, text boxes and groups as a DrawingML choice with a VML fallback.
  const pkg = await DocxPackage.open(new Uint8Array(readFileSync('public/fixtures/shape-locks.docx')));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  let offset = 0, found;
  for (const p of doc.paragraphs) { for (const r of p.runs) { if (!found && r.image?.retainedDrawing && r.image.shell.includes('AlternateContent')) found = { offset, image: r.image }; offset += r.text.length; } offset++; }
  expect(found).toBeTruthy();
  for (const mode of ['square', 'inline', 'front']) {
    doc.select(found.offset, found.offset + 1);
    expect(wrapUnavailable(doc.selectedImage, mode)).toBeNull();
    expect(setImageWrap(doc, mode)).toBe(true);
    const { bytes, reopened } = await save(pkg, doc);
    expect(reopened.readOnly).not.toBe(true);
    const image = imagesOf(reopened).find(i => i.id === found.image.id);
    expect(imageWrapMode(image)).toBe(mode);
    // The fallback stays with the choice, so the saved shape is still alternate content.
    expect(image.shell).toContain('AlternateContent');
    expect(bytes.length).toBeGreaterThan(0);
  }
});
