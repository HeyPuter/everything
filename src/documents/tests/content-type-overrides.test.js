import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';
import { png } from './helpers/image-fixtures.js';

// The content types stream holds at most one Override per part name, and part names compare without
// regard to ASCII case (ECMA-376 Part 2, §9.1.1 part names and §10.1.2 content types). A package can
// keep an Override for a part it no longer contains; creating that part again must reuse the entry.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const LEFTOVERS = {
  '/docProps/core.xml': 'application/xml',
  '/word/settings.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  '/WORD/Numbering.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  '/word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  '/word/header1.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  '/word/footnotes.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  '/word/endnotes.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
  '/word/media/canvas-image1.png': 'image/png',
};
function leftoverPackage() {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Body text' }]));
  const entries = Object.entries(LEFTOVERS).map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`).join('');
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', `${entries}</Types>`));
  return zipSync(parts);
}
const overrides = parts => [...new DOMParser().parseFromString(strFromU8(parts['[Content_Types].xml']), 'application/xml').getElementsByTagNameNS('*', 'Override')]
  .map(n => [n.getAttribute('PartName'), n.getAttribute('ContentType')]);

it('reuses a leftover content type entry when it creates each kind of part', async () => {
  const pkg = await DocxPackage.open(leftoverPackage()), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  pkg.setCoreProperties({ title: 'Report' });
  doc.select(0); doc.toggleList('bullet');
  doc.select(0); doc.createParagraphStyle('Report body');
  doc.assets.picture = { bytes: png(2, 2), mime: 'image/png' };
  doc.select(doc.text.length); doc.insertImage('picture', { width: 9525, height: 9525 });
  pkg.addPageStory('header'); pkg.addFootnote(); pkg.addEndnote();
  const parts = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets, undefined, undefined, true).arrayBuffer()));
  const entries = overrides(parts), names = entries.map(([name]) => name.toLowerCase());
  expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  // Every created part has exactly one entry, with the content type it needs.
  for (const [path, type] of [
    ['docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['word/settings.xml', LEFTOVERS['/word/settings.xml']], ['word/numbering.xml', LEFTOVERS['/WORD/Numbering.xml']],
    ['word/styles.xml', LEFTOVERS['/word/styles.xml']], ['word/header1.xml', LEFTOVERS['/word/header1.xml']],
    ['word/footnotes.xml', LEFTOVERS['/word/footnotes.xml']], ['word/endnotes.xml', LEFTOVERS['/word/endnotes.xml']],
    ['word/media/canvas-image1.png', 'image/png'],
  ]) {
    expect(Object.hasOwn(parts, path), path).toBe(true);
    expect(entries.filter(([name]) => name.toLowerCase() === `/${path}`.toLowerCase()).map(([, t]) => t), path).toEqual([type]);
  }
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(reopened.coreProperties.title).toBe('Report');
});

// Each writer that can create a part declares it through the one entry the stream may hold for it: review
// settings, the saved view and mail merge create a settings part; a first comment creates the comments part.
it('reuses a leftover entry, in any case, whichever change creates the settings or comments part', async () => {
  const leftovers = {
    '/WORD/Settings.xml': 'application/xml',
    '/Word/Comments.xml': 'application/xml',
  };
  const source = () => {
    const parts = unzipSync(docxWithParagraphs([{ text: 'Body text' }]));
    const entries = Object.entries(leftovers).map(([name, type]) => `<Override PartName="${name}" ContentType="${type}"/>`).join('');
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', `${entries}</Types>`));
    return zipSync(parts);
  };
  const SETTINGS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
  const COMMENTS = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
  const changes = {
    'hide spelling errors': [pkg => { pkg.hideSpellingErrors = true; }, 'word/settings.xml', SETTINGS],
    'protection': [pkg => { pkg.reviewSettings = { ...pkg.reviewSettings, protection: { edit: 'readOnly', enforcement: true } }; }, 'word/settings.xml', SETTINGS],
    'web layout view': [pkg => { pkg.documentView = 'web'; }, 'word/settings.xml', SETTINGS],
    'mail merge': [pkg => { pkg.mailMerge = { type: 'formLetters', preview: false, activeRecord: 1, list: null, mapping: {}, email: { format: 'html' } }; }, 'word/settings.xml', SETTINGS],
    'a comment': [(pkg, doc) => { doc.select(0, 4); doc.addComment('Check this', 'Reviewer'); }, 'word/comments.xml', COMMENTS],
  };
  for (const [name, [change, path, type]] of Object.entries(changes)) {
    const pkg = await DocxPackage.open(source());
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments });
    change(pkg, doc);
    const parts = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets, undefined, doc.comments).arrayBuffer()));
    expect(Object.hasOwn(parts, path), name).toBe(true);
    const entries = overrides(parts), names = entries.map(([partName]) => partName.toLowerCase());
    expect(names.filter((partName, i) => names.indexOf(partName) !== i), name).toEqual([]);
    expect(entries.filter(([partName]) => partName.toLowerCase() === `/${path}`).map(([, t]) => t), name).toEqual([type]);
  }
});

it('reuses a leftover entry when a first source creates the bibliography part', async () => {
  const { writeBibliographyPart } = await import('../src/engine/bibliography-fields.js');
  const parts = unzipSync(docxWithParagraphs([{ text: 'Body text' }]));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/CustomXml/ItemProps1.xml" ContentType="application/xml"/></Types>'));
  expect(writeBibliographyPart(parts, { style: '', styleName: '', sources: [] })).toBe('customXml/item1.xml');
  const entries = overrides(parts).filter(([name]) => name.toLowerCase() === '/customxml/itemprops1.xml');
  expect(entries.map(([, type]) => type)).toEqual(['application/vnd.openxmlformats-officedocument.customXmlProperties+xml']);
});
