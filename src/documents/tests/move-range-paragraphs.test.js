import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';

// Word records a move of whole paragraphs as one move range on each side (§17.13.5.22–.27): the range opens before
// the first moved paragraph's content and closes after the last's. Paragraphs inside such a range are written anew
// on every save, and their moves were written one range per paragraph (move1, move1_2), so two moved paragraphs
// became two moves in Word's Reviewing pane.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const A = 'w:author="Ann" w:date="2024-01-01T00:00:00Z"';
const moved = (side, id, text) => `<w:p><w:pPr><w:rPr><w:${side} w:id="${id}" ${A}/></w:rPr></w:pPr><w:${side} w:id="${id + 1}" ${A}><w:r><w:t>${text}</w:t></w:r></w:${side}></w:p>`;
const BODY = moved('moveTo', 10, 'First moved').replace('</w:pPr>', `</w:pPr><w:moveToRangeStart w:id="1" ${A} w:name="move1"/>`)
  + moved('moveTo', 12, 'Second moved').replace('</w:moveTo></w:p>', '</w:moveTo><w:moveToRangeEnd w:id="1"/></w:p>')
  + '<w:p><w:r><w:t>Stays</w:t></w:r></w:p>'
  + moved('moveFrom', 20, 'First moved').replace('</w:pPr>', `</w:pPr><w:moveFromRangeStart w:id="2" ${A} w:name="move1"/>`)
  + moved('moveFrom', 22, 'Second moved').replace('</w:moveFrom></w:p>', '</w:moveFrom><w:moveFromRangeEnd w:id="2"/></w:p>');

async function savedAfterEdit(body = BODY) {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Edit me' }]));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:sectPr/>', `${body}<w:sectPr/>`));
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).toBeFalsy();
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(7); doc.replace(' now');
  return new DOMParser().parseFromString(strFromU8(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()))['word/document.xml']), 'application/xml');
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const all = (xml, name) => [...xml.getElementsByTagNameNS(W, name)];
const text = node => [...node.getElementsByTagNameNS(W, 't'), ...node.getElementsByTagNameNS(W, 'delText')].map(t => t.textContent).join('');

it('saves a move of two paragraphs as one move range on each side', async () => {
  const xml = await savedAfterEdit();
  for (const side of ['moveTo', 'moveFrom']) {
    const starts = all(xml, `${side}RangeStart`), ends = all(xml, `${side}RangeEnd`);
    expect(starts.map(s => s.getAttributeNS(W, 'name'))).toEqual(['move1']);
    expect(ends.map(e => e.getAttributeNS(W, 'id'))).toEqual([starts[0].getAttributeNS(W, 'id')]);
    // The range opens in the first moved paragraph and closes in the second, around both paragraphs' moved text.
    expect(text(starts[0].parentNode)).toBe('First moved');
    expect(text(ends[0].parentNode)).toBe('Second moved');
  }
  const reopened = await DocxPackage.open(zipSync({ ...unzipSync(docxWithParagraphs([{ text: 'x' }])), 'word/document.xml': strToU8(new XMLSerializer().serializeToString(xml)) }));
  expect(reopened.readOnly).toBeFalsy();
  const names = new Set(reopened.paragraphs.flatMap(p => p.runs.map(r => r.revision?.moveName).filter(Boolean)));
  expect([...names]).toEqual(['move1']);
});

it('keeps two moves apart', async () => {
  const separate = moved('moveTo', 30, 'Alone').replace('</w:pPr>', `</w:pPr><w:moveToRangeStart w:id="3" ${A} w:name="move2"/>`).replace('</w:moveTo></w:p>', '</w:moveTo><w:moveToRangeEnd w:id="3"/></w:p>')
    + moved('moveFrom', 40, 'Alone').replace('</w:pPr>', `</w:pPr><w:moveFromRangeStart w:id="4" ${A} w:name="move2"/>`).replace('</w:moveFrom></w:p>', '</w:moveFrom><w:moveFromRangeEnd w:id="4"/></w:p>');
  const xml = await savedAfterEdit(BODY + separate);
  for (const side of ['moveTo', 'moveFrom']) expect(all(xml, `${side}RangeStart`).map(s => s.getAttributeNS(W, 'name'))).toEqual(['move1', 'move2']);
});
