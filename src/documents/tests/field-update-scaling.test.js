import { it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraph, TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
afterEach(() => vi.restoreAllMocks());

const field = id => ({ id, type: 'PAGEREF', instruction: ' PAGEREF Target ', bookmark: 'Target', locked: false, dirty: false });
const withField = (text, id, start, end) => paragraph(text, { fieldMarkers: [{ type: 'start', field: field(id), offset: start, order: 0 }, { type: 'end', field: field(id), offset: end, order: 1 }] });
const ranges = paragraphs => bodyFieldRanges(paragraphs).map(r => [r.field.id, r.start, r.end]);

// Updating fields asks for every field's range after each result it replaces. Each time, the text of every
// paragraph with a field was split into graphemes again (to check the fields start and end between them),
// which made Update Fields and Update Table quadratic in long documents.
it('splits a paragraph with fields into graphemes once until its text changes', () => {
  // Accented text: plain ASCII is split without the segmenter (inlineSegments).
  const paragraphs = Array.from({ length: 20 }, (_, i) => withField(`Entrée ${i}\t12`, `f${i}`, 8 + String(i).length, 10 + String(i).length));
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  const first = ranges(paragraphs);
  expect(segment).toHaveBeenCalledTimes(20);
  // Asked again, and of copies of the paragraphs (an edit copies every paragraph to place its fields).
  expect(ranges(paragraphs)).toEqual(first);
  expect(ranges(paragraphs.map(p => ({ ...p })))).toEqual(first);
  expect(segment).toHaveBeenCalledTimes(20);
  // A changed result is split again: only that paragraph.
  paragraphs[3].runs = [{ ...paragraphs[3].runs[0], text: 'Entrée 3\t7' }];
  paragraphs[3].fieldMarkers[1].offset = 10;
  const [, start, end] = ranges(paragraphs)[3];
  expect(end - start).toBe(1);
  expect(segment).toHaveBeenCalledTimes(21);
});

it('still finds a field boundary inside a grapheme after the text changes in place', () => {
  const p = withField('ab', 'f', 1, 2);
  expect(ranges([p])).toEqual([['f', 1, 2]]);
  // The run's text is changed in place: "a" and a combining accent are one grapheme, which the field starts inside.
  p.runs[0].text = 'á';
  expect(() => bodyFieldRanges([p])).toThrow('Body field boundaries inside grapheme clusters are not supported.');
  p.runs.push({ ...p.runs[0], text: '' }); p.runs[0].text = 'ab';
  expect(ranges([p])).toEqual([['f', 1, 2]]);
});

// A document of `count` paragraphs, each with a stale page reference and a figure number, before a bookmark on page 2.
const source = readFileSync('tests/fixtures/field-refresh/absent.docx');
const entries = count => {
  const parts = unzipSync(source), rows = Array.from({ length: count }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">Entry ${i}: </w:t></w:r><w:fldSimple w:instr=" PAGEREF Target "><w:r><w:t>99</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve"> Figure </w:t></w:r><w:fldSimple w:instr=" SEQ Figure "><w:r><w:t>0</w:t></w:r></w:fldSimple></w:p>`).join('');
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:body>', `<w:body>${rows}`));
  return zipSync(parts);
};
const layoutOf = p => d => layoutDocument(d.paragraphs, (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 }), pageGeometry(d.pageSettings), d.numbering, d.tables, p.pageStories, { styles: d.styles });

it('updates twice as many fields with twice the work, not four times', async () => {
  const work = [];
  for (const count of [20, 40]) {
    const p = await DocxPackage.open(entries(count)), d = new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
    const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
    expect(updateSequenceFields(d, { onIssue: () => {} })).toBe(count);
    const sequences = segment.mock.calls.length; segment.mockClear();
    expect(refreshPageReferences(d, layoutOf(p), p.pageStories).changed).toBe(count + 3);
    work.push([sequences, segment.mock.calls.length]);
    vi.restoreAllMocks();
    const results = bodyFieldRanges(d.paragraphs).map(r => d.text.slice(r.start, r.end));
    expect(results.slice(0, 4)).toEqual(['2', '1', '2', '2']);
    expect(results.at(2 * count - 1)).toBe(String(count));
  }
  // Text split into characters: 1,600 and 5,580 times (sequences), 2,979 and 9,859 times (page references) before.
  const [[sequences20, references20], [sequences40, references40]] = work;
  expect(sequences40).toBeLessThanOrEqual(2.2 * sequences20);
  expect(references40).toBeLessThanOrEqual(2.2 * references20);
});
