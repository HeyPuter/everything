import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { strToU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { formatDatePicture, applyGeneralFormat, evaluateField, fieldInstruction, insertBodyField, documentProperties, setFieldContextProvider, cardinalText, DATE_PICTURES } from '../src/engine/field-results.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { insertCrossReference, referenceTargets } from '../src/engine/captions.js';
import { insertCitation } from '../src/engine/bibliography-fields.js';
import { insertFormula } from '../src/engine/table-formula.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { setFieldContextProvider(null); dom.window.close(); });
const when = new Date(2026, 9, 3, 14, 5, 9);
const blank = () => {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  return { pkg, doc: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
};

describe('date-time pictures (§17.16.4.1)', () => {
  it('formats months, days, years, hours and literals', () => {
    expect(formatDatePicture(when, 'M/d/yyyy')).toBe('10/3/2026');
    expect(formatDatePicture(when, 'dddd, MMMM d, yyyy')).toBe('Saturday, October 3, 2026');
    expect(formatDatePicture(when, 'dd-MMM-yy')).toBe('03-Oct-26');
    expect(formatDatePicture(when, 'h:mm am/pm')).toBe('2:05 pm');
    expect(formatDatePicture(when, 'HH:mm:ss')).toBe('14:05:09');
    expect(formatDatePicture(when, "'Week of' MMMM d")).toBe('Week of October 3');
    expect(formatDatePicture(when, 'h:mm AM/PM')).toBe('2:05 PM');
    for (const picture of DATE_PICTURES) expect(formatDatePicture(when, picture)).not.toMatch(/[Mdy]{2}/);
  });
});

describe('general formatting switch (§17.16.4.3)', () => {
  it('changes case and number forms', () => {
    expect(applyGeneralFormat('sam lee', 'Upper')).toBe('SAM LEE');
    expect(applyGeneralFormat('sam lee', 'Caps')).toBe('Sam Lee');
    expect(applyGeneralFormat('sam lee', 'FirstCap')).toBe('Sam lee');
    expect(applyGeneralFormat('14', 'ROMAN')).toBe('XIV');
    expect(applyGeneralFormat('3', 'Ordinal')).toBe('3rd');
    expect(applyGeneralFormat('42', 'CardText')).toBe('forty-two');
    expect(applyGeneralFormat('21', 'OrdText')).toBe('twenty-first');
    expect(cardinalText(1203)).toBe('one thousand two hundred three');
  });
});

describe('field evaluation', () => {
  const context = { now: when, properties: { author: 'Sam Lee', title: 'Annual Plan', company: 'Acme' }, fileName: 'plan.docx', user: { name: 'Ada Byron' }, pages: 4, text: 'One two three' };
  it('computes dates, document information and statistics', () => {
    expect(evaluateField(fieldInstruction({ name: 'DATE', picture: 'MMMM d, yyyy' }), context)).toBe('October 3, 2026');
    expect(evaluateField(' TIME \\@ "HH:mm" ', context)).toBe('14:05');
    expect(evaluateField(' AUTHOR \\* Upper \\* MERGEFORMAT ', context)).toBe('SAM LEE');
    expect(evaluateField(' DOCPROPERTY Company ', context)).toBe('Acme');
    expect(evaluateField(' DOCPROPERTY "Title" ', context)).toBe('Annual Plan');
    expect(evaluateField(' FILENAME ', context)).toBe('plan.docx');
    expect(evaluateField(' USERINITIALS ', context)).toBe('AB');
    expect(evaluateField(' NUMPAGES \\* roman ', context)).toBe('iv');
    expect(evaluateField(' NUMWORDS ', context)).toBe('3');
    expect(evaluateField(' SEQ Figure ', context)).toBe(null);
  });
  it('writes instructions with quoted arguments and switches', () => {
    expect(fieldInstruction({ name: 'DATE', picture: 'dddd, MMMM d, yyyy' })).toBe(' DATE \\@ "dddd, MMMM d, yyyy" \\* MERGEFORMAT ');
    expect(fieldInstruction({ name: 'DOCPROPERTY', argument: 'Company', format: 'Upper', preserve: false })).toBe(' DOCPROPERTY Company \\* Upper ');
  });
  it('reads core and extended properties', () => {
    const parts = { 'docProps/core.xml': strToU8('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator></cp:coreProperties>'), 'docProps/app.xml': strToU8('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>C</Company></Properties>') };
    expect(documentProperties(parts)).toMatchObject({ title: 'T', author: 'A', company: 'C' });
  });
});

it.each([['a field', '2026'], ['an empty field', '']])('inserts a field just before %s, beside it, and saves both', async (name, result) => {
  const { pkg, doc } = blank();
  doc.replace('Date:  end'); doc.select(6);
  insertBodyField(doc, fieldInstruction({ name: 'DATE' }), result);
  // The caret is where the DATE field's result starts: the new field goes before it, not across its start.
  doc.select(6);
  insertBodyField(doc, fieldInstruction({ name: 'AUTHOR' }), 'Sam Lee');
  const fields = d => bodyFieldRanges(d.paragraphs).map(r => [r.field.type, d.text.slice(r.start, r.end), r.parentId ?? null]);
  expect(doc.text).toBe(`Date: Sam Lee${result} end`);
  expect(fields(doc)).toEqual(result ? [['AUTHOR', 'Sam Lee', null], ['DATE', result, null]] : [['DATE', '', null], ['AUTHOR', 'Sam Lee', null]]);
  const reopened = await DocxPackage.open(new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer()));
  expect(fields(new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets))).toEqual(fields(doc));
});

const source = { tag: 'Lov20', type: 'Book', names: { Author: [{ last: 'Lovelace', first: 'Ada' }] }, fields: { Title: 'Notes on engines', Year: '2020', Publisher: 'Harbor Press' } };
it.each([
  ['a cross-reference', doc => { doc.select(doc.text.indexOf('Target'), doc.text.length); doc.addBookmark('Target'); doc.select(6); insertCrossReference(doc, referenceTargets(doc).bookmarks[0], { hyperlink: false }); }, 'REF', 'Target'],
  ['a citation', doc => { doc.select(6); insertCitation(doc, { tags: ['Lov20'] }, [source], 'apa'); }, 'CITATION', '(Lovelace, 2020)'],
  ['a formula', doc => { doc.select(6); insertFormula(doc, '=1+1'); }, '=', '2'],
])('inserts %s just before another field, beside it', (name, insert, type, result) => {
  const { pkg, doc } = blank();
  doc.replace('Date:  end\nTarget'); doc.select(6);
  insertBodyField(doc, fieldInstruction({ name: 'DATE' }), '2026');
  insert(doc);
  expect(bodyFieldRanges(doc.paragraphs).map(r => [r.field.type, doc.text.slice(r.start, r.end), r.parentId ?? null])).toEqual([[type, result, null], ['DATE', '2026', null]]);
});

it('inserts DATE and AUTHOR fields that save as fields, reopen editable and update in place', async () => {
  const { pkg, doc } = blank();
  doc.replace('Signed on  by .');
  doc.select(10);
  insertBodyField(doc, fieldInstruction({ name: 'DATE', picture: 'MMMM d, yyyy' }), 'October 3, 2026');
  doc.select(doc.text.indexOf(' by ') + 4);
  insertBodyField(doc, fieldInstruction({ name: 'AUTHOR' }), 'Sam Lee');
  expect(doc.text).toBe('Signed on October 3, 2026 by Sam Lee.');
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  expect(reopened.readOnly).toBeFalsy();
  const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
  expect(paragraphText(again.paragraphs[0])).toBe('Signed on October 3, 2026 by Sam Lee.');
  expect(bodyFieldRanges(again.paragraphs).map(r => r.field.type)).toEqual(['DATE', 'AUTHOR']);
  // Without document information only the clock fields refresh; with it, every inserted field does.
  setFieldContextProvider(null);
  updateSequenceFields(again);
  expect(again.text).toMatch(/^Signed on \w+ \d+, \d{4} by Sam Lee\.$/);
  setFieldContextProvider(() => ({ now: when, properties: { author: 'Ada Byron' } }));
  updateSequenceFields(again);
  expect(again.text).toBe('Signed on October 3, 2026 by Ada Byron.');
  setFieldContextProvider(null);
});
