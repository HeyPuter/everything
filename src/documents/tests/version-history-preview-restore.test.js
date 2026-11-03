// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';

// Restore from the preview of a version (its own Restore button) must bring the version's decoded pictures along,
// as Restore in the list does: a drawing only the version has was left without its picture until the document
// was decoded again.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
/** Independently written: one paragraph with a coloured shape numbered 1. */
const shape = (geometry, color) => `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="Drawing 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const docx = (text, drawing) => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"/>`,
  'word/document.xml': `<w:document ${NS}><w:body><w:p><w:r><w:t>${text}</w:t></w:r>${drawing}</w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
}).map(([k, v]) => [k, strToU8(v)])));

const VERSION = docx('Old', shape('ellipse', '0000FF'));
const v1 = { path: 'Documents/.versions/Plan/v1.docx', time: Date.now() };
// Each opening decodes the version's pictures afresh, as the engine's does; the preview releases its own when it closes.
vi.mock('../src/lib/engine-api.js', async () => {
  const { unportableContent, adoptVersionAssets } = await import('../src/engine/version-restore.js');
  class CanvasEditor {
    constructor(host, { images }) { this.images = images; this.layout = { pages: [{ width: 800 }] }; }
    setZoom() {}
    destroy() { for (const image of this.images.values()) image.close(); }
  }
  return { engineApi: () => ({ CanvasEditor, unportableContent, adoptVersionAssets,
    openCanvasDocument: async () => { const pkg = await DocxPackage.open(VERSION); return { pkg, images: new Map(Object.keys(pkg.assets).map(id => [id, { id, closed: false, close() { this.closed = true; } }])) }; } }) };
});
vi.mock('../src/lib/versions.js', () => ({ listVersions: async () => [v1], readVersionMeta: async () => ({}), writeVersionMeta: async () => ({}) }));
vi.mock('../src/lib/puter.js', async (importOriginal) => ({ ...await importOriginal(), readFile: async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }) }));
const { createVersionHistory } = await import('../src/views/version-history.js');
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

it('Restore in a version\'s preview brings the version\'s pictures, as Restore in the list does', async () => {
  // The document's own shape is also numbered 1, so the version's comes back under a new id.
  const current = await DocxPackage.open(docx('Current', shape('rect', 'FF0000')));
  const model = new TextDocument(current.paragraphs, current.pageSettings, current.numbering, current.styles, current.tables, current.assets);
  const session = new StorySession(model), errors = [];
  const engine = { session, images: new Map(Object.keys(current.assets).map(id => [id, { id, close() {} }])), get model() { return session.model; },
    finishComposition() {}, relayout() {}, paint() {}, focus() {}, undo() { session.undo(); }, execute(action) { session.run(() => action(session.model)); return true; } };
  const history = createVersionHistory({ editor: () => engine, pkg: () => current, doc: { path: 'Documents/Plan.docx' }, error: e => errors.push(e.message), live: () => ({}), restoreFile: vi.fn() });
  document.body.append(history.pane.el || history.pane.node || document.createElement('div'), history.previewNode);
  history.open();
  await vi.waitFor(() => expect(document.querySelector('.vh-item-main')).not.toBeNull());
  document.querySelector('.vh-item-main').click();
  await vi.waitFor(() => expect(history.previewNode.hidden).toBe(false));
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = document.querySelectorAll('.modal-panel').length;
  [...history.previewNode.querySelectorAll('button')].find(b => b.textContent === 'Restore').click();
  await vi.waitFor(() => expect(document.querySelectorAll('.modal-panel').length).toBeGreaterThan(before));
  [...[...document.querySelectorAll('.modal-panel')].at(-1).querySelectorAll('button')].find(b => b.textContent === 'Restore').click();
  await vi.waitFor(() => expect(engine.model.text).toBe('Old￼'));
  expect(errors).toEqual([]);
  const drawn = engine.model.paragraphs[0].runs.find(r => r.image).image.assetId;
  expect(JSON.stringify(engine.model.assets[drawn].scene)).toContain('0000FF');
  // Its picture is there to paint, and still open once the preview has closed.
  expect(engine.images.get(drawn)).toBeDefined();
  expect(engine.images.get(drawn).closed).toBe(false);
  history.destroy();
});
