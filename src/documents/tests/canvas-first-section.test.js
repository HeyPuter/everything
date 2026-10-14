import { beforeAll, afterAll, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const types = ['nextPage', 'continuous', 'nextColumn', 'oddPage', 'evenPage'];
const source = () => unzipSync(readFileSync('public/fixtures/first-section.docx'));
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables).arrayBuffer()));
const layout = d => layoutDocument(d.paragraphs, text => ({ width: text.length * 8, ascent: 12, descent: 4 }), pageGeometry(d.pageSettings), d.numbering, d.tables);
function fixture(type, split = false) {
  const parts = source();
  const xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  const section = xml.getElementsByTagNameNS(W, 'sectPr')[0];
  section.getElementsByTagNameNS(W, 'type')[0].setAttributeNS(W, 'w:val', type);
  if (split) {
    const pPr = xml.createElementNS(W, 'w:pPr'); pPr.append(section.cloneNode(true));
    xml.getElementsByTagNameNS(W, 'p')[0].prepend(pPr);
    section.getElementsByTagNameNS(W, 'type')[0].setAttributeNS(W, 'w:val', 'nextPage');
  }
  parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  return parts;
}

it.each(types)('starts a single %s section on page one and preserves its type through edits, page setup and undo', async type => {
  const parts = fixture(type), pkg = await DocxPackage.open(zipSync(parts)), doc = model(pkg);
  expect(layout(doc).pages).toHaveLength(1); expect(layout(doc).lines[0].page).toBe(0);
  expect(await save(pkg, doc)).toEqual(parts);
  doc.select(0); doc.replace('Edited '); doc.setPageSettings({ left: 1800 });
  const edited = await save(pkg, doc), reopened = await DocxPackage.open(zipSync(edited));
  expect(reopened.pageSettings.left).toBe(1800);
  expect(model(reopened).text).toBe('Edited First section origin\nCafé and Unicode 😀');
  expect(strFromU8(edited['word/document.xml'])).toContain(`w:val="${type}"`);
  expect(layout(model(reopened)).pages).toHaveLength(1);
  for (const name of Object.keys(parts)) if (name !== 'word/document.xml') expect(edited[name]).toEqual(parts[name]);
  doc.undo(); doc.undo(); expect(await save(pkg, doc)).toEqual(parts);
});

it.each(types)('ignores first-section %s while preserving a later next-page transition and paragraph splitting', async type => {
  const parts = fixture(type, true), pkg = await DocxPackage.open(zipSync(parts)), doc = model(pkg);
  expect(layout(doc).pages).toHaveLength(2);
  doc.select(5); doc.insertParagraph();
  const edited = await save(pkg, doc), reopened = model(await DocxPackage.open(zipSync(edited)));
  expect(layout(reopened).pages).toHaveLength(2);
  expect(reopened.paragraphs.filter(p => p.sectionEnd)).toHaveLength(1);
  const xml = new DOMParser().parseFromString(strFromU8(edited['word/document.xml']), 'application/xml');
  expect([...xml.getElementsByTagNameNS(W, 'type')].map(n => n.getAttributeNS(W, 'val'))).toEqual([type, 'nextPage']);
  doc.undo(); expect(await save(pkg, doc)).toEqual(parts);
});

const laterSection = type => {
  const parts = fixture('nextPage', true);
  const xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  [...xml.getElementsByTagNameNS(W, 'type')].at(-1).setAttributeNS(W, 'w:val', type);
  parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  return parts;
};
it('still rejects a later nextColumn section before editing', async () => {
  await expect(DocxPackage.open(zipSync(laterSection('nextColumn')))).rejects.toThrow('next-column section breaks');
});
it.each(['evenPage', 'oddPage'])('opens a later %s section for editing and keeps its type', async type => {
  const parts = laterSection(type), pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.pageSettings.sectionType).toBe(type);
  expect(await save(pkg, model(pkg))).toEqual(parts);
});

it.each(['<w:type/>', '<w:type w:val=""/>', '<w:type w:val="bogus"/>', '<w:type w:val="continuous"/><w:type w:val="nextPage"/>'])('rejects malformed first-section markup %s', async markup => {
  const parts = source(); parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:type w:val="continuous"/>', markup));
  await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow('invalid section type');
});
