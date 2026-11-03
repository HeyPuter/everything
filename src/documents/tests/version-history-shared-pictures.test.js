// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';

// Restoring a version of a shared document puts the version's body into the open document's package. Its
// pictures keep the relationship ids of the version's own file, which can name another picture, or nothing,
// in the document's.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const picture = (id, rel) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="p.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const RED = readFileSync('icon-128.png'), BLUE = readFileSync('icon.png');
/** Independently written: a paragraph of text and pictures, and the image parts they use. */
const shape = (geometry, color) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Drawing 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const docx = (text, pictures, media, drawings = '') => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}">${Object.keys(media).map((path, i) => `<Relationship Id="rPic${i + 1}" Type="${R}/image" Target="${path.slice(5)}"/>`).join('')}</Relationships>`,
  'word/document.xml': `<w:document ${NS}><w:body><w:p><w:r><w:t>${text}</w:t></w:r>${pictures.map((rel, i) => picture(i + 1, rel)).join('')}${drawings}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  ...media,
}).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));

let version;
vi.mock('../src/lib/engine-api.js', async () => {
  const { unportableContent, adoptVersionAssets } = await import('../src/engine/version-restore.js');
  return { engineApi: () => ({ openCanvasDocument: async () => ({ pkg: version, images: new Map() }), unportableContent, adoptVersionAssets }) };
});
vi.mock('../src/lib/puter.js', async (importOriginal) => ({ ...await importOriginal(), readFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) }));
const { createVersionHistory } = await import('../src/views/version-history.js');
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const read = blob => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(unzipSync(new Uint8Array(r.result))); r.onerror = reject; r.readAsArrayBuffer(blob); });

async function restore(current, versionBytes) {
  version = await DocxPackage.open(versionBytes);
  const model = new TextDocument(current.paragraphs, current.pageSettings, current.numbering, current.styles, current.tables, current.assets, { comments: current.comments });
  const session = new StorySession(model), errors = [];
  const engine = { session, images: new Map(), get model() { return session.model; }, finishComposition() {}, relayout() {}, paint() {}, focus() {}, undo() { session.undo(); },
    execute(action) { session.run(() => action(session.model)); return true; } };
  const history = createVersionHistory({ editor: () => engine, pkg: () => current, doc: { path: 'Documents/Plan.docx' }, error: e => errors.push(e.message), live: () => ({}), restoreFile: vi.fn() });
  const before = document.querySelectorAll('.modal-panel').length;
  const restoring = history.restore({ path: 'Documents/.versions/Plan/v1.docx', time: 1 });
  // The confirmation is the newest dialog (an earlier one can still be closing).
  await vi.waitFor(() => expect(document.querySelectorAll('.modal-panel').length).toBeGreaterThan(before));
  [...[...document.querySelectorAll('.modal-panel')].at(-1).querySelectorAll('button')].find(b => b.textContent === 'Restore').click();
  const restored = await restoring;
  history.destroy();
  const m = engine.model;
  return { restored, errors, engine, parts: await read(current.export(m.paragraphs, m.pageSettings, m.numbering, m.styles, m.tables, m.assets, undefined, m.comments)) };
}

it('refuses to restore a shared version whose pictures the document no longer has as they were', async () => {
  const current = await DocxPackage.open(docx('Current', ['rPic1'], { 'word/media/image1.png': RED }));
  // The version's first picture was another image under the same name, and its second is gone from the document.
  const { restored, errors, engine, parts } = await restore(current, docx('Old', ['rPic1', 'rPic2'], { 'word/media/image1.png': BLUE, 'word/media/image2.png': BLUE }));
  // It was restored with the document's red picture in place of the blue one, and a picture whose
  // relationship the saved file did not have.
  expect(restored).toBe(false);
  expect(errors).toEqual([expect.stringMatching(/cannot be restored while others edit with you/)]);
  expect(engine.model.text).toBe('Current￼');
  const rels = strFromU8(parts['word/_rels/document.xml.rels']);
  for (const [, id] of strFromU8(parts['word/document.xml']).matchAll(/r:embed="([^"]+)"/g)) expect(rels).toContain(`Id="${id}"`);
});

it('restores a shared version whose pictures are the document\'s own', async () => {
  const current = await DocxPackage.open(docx('Current', ['rPic1'], { 'word/media/image1.png': RED }));
  const { restored, errors, engine, parts } = await restore(current, docx('Old', ['rPic1', 'rPic1'], { 'word/media/image1.png': RED }));
  expect(errors).toEqual([]);
  expect(restored).toBe(true);
  expect(engine.model.text).toBe('Old￼￼');
  expect(strFromU8(parts['word/document.xml']).match(/r:embed="rPic1"/g)).toHaveLength(2);
  expect(Buffer.compare(Buffer.from(parts['word/media/image1.png']), RED)).toBe(0);
});

it('finds note references whose notes the document has changed', async () => {
  const { unportableContent } = await import('../src/engine/version-restore.js');
  // Bytes made as this environment's own (a package's parts are).
  const bytes = text => new Uint8Array([...strToU8(text)]);
  const rels = bytes(`<Relationships xmlns="${REL}"><Relationship Id="rNotes" Type="${R}/footnotes" Target="footnotes.xml"/></Relationships>`);
  const pkg = notes => ({ parts: { 'word/_rels/document.xml.rels': rels, 'word/footnotes.xml': bytes(`<w:footnotes xmlns:w="${W}">${notes}</w:footnotes>`) } });
  const body = [{ runs: [{ text: 'Cited', noteMark: { id: '1', kind: 'footnote' } }] }];
  expect(unportableContent({ ...pkg('<w:footnote w:id="1"/>'), paragraphs: body }, pkg('<w:footnote w:id="1"/>'))).toBeNull();
  expect(unportableContent({ ...pkg('<w:footnote w:id="1"/>'), paragraphs: body }, pkg('<w:footnote w:id="2"/>'))).toEqual({ relationships: [], notes: true });
  // Without note references, the notes do not matter.
  expect(unportableContent({ ...pkg('<w:footnote w:id="1"/>'), paragraphs: [{ runs: [{ text: 'Plain' }] }] }, pkg('<w:footnote w:id="2"/>'))).toBeNull();
});

it('keeps the document\'s own drawing when a restored version\'s drawing has the same number', async () => {
  // Both files number their shape 1: the document's is a red rectangle, the version's a blue ellipse.
  const current = await DocxPackage.open(docx('Current', [], {}, shape('rect', 'FF0000')));
  const own = JSON.stringify(current.assets['drawing:1']);
  const { restored, errors, engine } = await restore(current, docx('Old', [], {}, shape('ellipse', '0000FF')));
  expect(errors).toEqual([]);
  expect(restored).toBe(true);
  const drawn = () => engine.model.paragraphs[0].runs.find(r => r.image).image.assetId;
  expect(JSON.stringify(engine.model.assets[drawn()].scene)).toContain('0000FF');
  // Undoing the restore brings the document's shape back: it was drawn with the version's ellipse.
  engine.undo();
  expect(engine.model.text).toBe('Current\ufffc');
  expect(JSON.stringify(engine.model.assets[drawn()])).toBe(own);
});

