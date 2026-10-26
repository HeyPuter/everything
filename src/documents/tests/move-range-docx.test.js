import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
async function fixture(body) {
  const parts = unzipSync(await bytes(createDocx().export()));
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`);
  return zipSync(parts);
}
const by = 'w:author="Jane" w:date="2024-05-01T10:00:00Z"';
const moved = (side, id, text) => `<w:p><w:pPr><w:rPr><w:${side} w:id="${id}" ${by}/></w:rPr></w:pPr><w:${side} w:id="${id + 1}" ${by}><w:r><w:${side === 'moveFrom' ? 'delText' : 't'}>${text}</w:${side === 'moveFrom' ? 'delText' : 't'}></w:r></w:${side}></w:p>`;
// A moved paragraph as desktop word processors record it: the named move range
// (§17.13.5.22–.27) sits between the paragraphs, around the moved ones.
const paragraphMove = '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>'
  + `<w:moveFromRangeStart w:id="0" ${by} w:name="move1"/>${moved('moveFrom', 1, 'First moved')}${moved('moveFrom', 3, 'Second moved')}<w:moveFromRangeEnd w:id="0"/>`
  + '<w:p><w:r><w:t>Middle</w:t></w:r></w:p>'
  + `<w:moveToRangeStart w:id="10" ${by} w:name="move1"/>${moved('moveTo', 11, 'First moved')}${moved('moveTo', 13, 'Second moved')}<w:moveToRangeEnd w:id="10"/>`
  + '<w:p><w:r><w:t>Last</w:t></w:r></w:p>';
// One range opened in a paragraph and closed in the next.
const spanningMove = `<w:p><w:r><w:t xml:space="preserve">Before </w:t></w:r><w:moveFromRangeStart w:id="0" ${by} w:name="move1"/><w:moveFrom w:id="1" ${by}><w:r><w:delText>one</w:delText></w:r></w:moveFrom></w:p>`
  + `<w:p><w:moveFrom w:id="2" ${by}><w:r><w:delText>two</w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="0"/><w:r><w:t xml:space="preserve"> after</w:t></w:r></w:p>`
  + `<w:p><w:moveToRangeStart w:id="5" ${by} w:name="move1"/><w:moveTo w:id="6" ${by}><w:r><w:t>one</w:t></w:r></w:moveTo></w:p>`
  + `<w:p><w:moveTo w:id="7" ${by}><w:r><w:t>two</w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="5"/></w:p>`
  + '<w:p><w:r><w:t>Last</w:t></w:r></w:p>';

const moves = paragraphs => paragraphs.flatMap(p => p.runs.filter(r => r.revision?.move).map(r => [r.revision.type, r.text, r.revision.moveName]));
// Every range start has its end, and names pair a source with a destination.
function ranges(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const result = {};
  for (const side of ['moveFrom', 'moveTo']) {
    const starts = [...doc.getElementsByTagNameNS(W, `${side}RangeStart`)], ends = [...doc.getElementsByTagNameNS(W, `${side}RangeEnd`)];
    expect(starts.map(n => n.getAttributeNS(W, 'id')).sort()).toEqual(ends.map(n => n.getAttributeNS(W, 'id')).sort());
    result[side] = starts.map(n => n.getAttributeNS(W, 'name'));
  }
  expect(result.moveFrom.sort()).toEqual(result.moveTo.sort());
  return result;
}

describe('tracked moves across paragraphs', () => {
  for (const [name, body, edit, expected] of [
    ['a move range around whole paragraphs', paragraphMove, 'Last', [['del', 'First moved', 'move1'], ['del', 'Second moved', 'move1'], ['ins', 'First moved', 'move1'], ['ins', 'Second moved', 'move1']]],
    ['a move range spanning two paragraphs', spanningMove, 'Before', [['del', 'one', 'move1'], ['del', 'two', 'move1'], ['ins', 'one', 'move1'], ['ins', 'two', 'move1']]],
  ]) it(`keeps ${name} paired when the text "${edit}" is edited`, async () => {
    const pkg = await DocxPackage.open(await fixture(body));
    expect(pkg.readOnly).toBeFalsy();
    expect(moves(pkg.paragraphs)).toEqual(expected);
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    model.select(model.text.indexOf(edit) + 1); model.replace('!');
    const saved = await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets));
    const names = ranges(strFromU8(unzipSync(saved)['word/document.xml']));
    expect(names.moveFrom.length).toBeGreaterThan(0);
    const reopened = await DocxPackage.open(saved);
    expect(reopened.readOnly).toBeFalsy();
    const pairs = moves(reopened.paragraphs);
    expect(pairs.map(([type, text]) => [type, text])).toEqual(expected.map(([type, text]) => [type, text]));
    // Each moved text keeps a name its counterpart shares.
    for (const [type, text, moveName] of pairs) {
      expect(moveName).not.toBe('');
      expect(pairs.some(([other, otherText, otherName]) => other !== type && otherText === text && otherName === moveName)).toBe(true);
    }
  });
  it('still saves an unedited document byte for byte', async () => {
    const input = await fixture(paragraphMove);
    const pkg = await DocxPackage.open(input);
    expect(unzipSync(await bytes(pkg.export()))).toEqual(unzipSync(input));
  });
});
