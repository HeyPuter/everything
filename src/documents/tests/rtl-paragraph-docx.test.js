import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText, paragraphFormat } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { copyFragment, fragmentHtml, htmlFragment, pasteFragment } from '../src/engine/clipboard-fragment.js';

// The fixture is written directly as WordprocessingML by tools/rtl_paragraph_fixture.py.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fixture = () => readFileSync('public/fixtures/rtl-paragraphs.docx');
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; globalThis.document = dom.window.document; globalThis.Node = dom.window.Node; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; delete globalThis.document; delete globalThis.Node; });

const open = async bytes => {
  const pkg = await DocxPackage.open(bytes);
  return { pkg, doc: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
};
const find = (doc, text) => doc.paragraphs.find(p => paragraphText(p).startsWith(text));
const selectIn = (doc, text) => { const at = doc.text.indexOf(text); if (at < 0) throw new Error(`Missing ${text}`); doc.select(at); };
const save = async (pkg, doc) => unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering).arrayBuffer()));
const bodyParagraphs = parts => [...new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml').getElementsByTagNameNS(W, 'p')];
const flag = (p, name) => { const node = [...(p.getElementsByTagNameNS(W, 'pPr')[0]?.children || [])].find(n => n.localName === name); return node ? node.getAttributeNS(W, 'val') ?? '' : null; };
const textOf = p => [...p.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('');
const measure = (text, style) => ({ width: [...text].length * 8 + [...text].filter(c => c === ' ').length * (style.justificationSpacing || 0), ascent: 12, descent: 4 });

// ECMA-376 Part 1 §17.3.1.6 bidi (paragraph), §17.6.1 bidi (section), §17.7.2 style inheritance.
it('opens right-to-left paragraphs, styles and a right-to-left section for editing', async () => {
  const { pkg, doc } = await open(fixture());
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.previewIssues).toBeUndefined();
  const direction = text => paragraphFormat(find(doc, text), doc.numbering).bidi;
  expect(direction('Left to right paragraph')).toBe(false);
  expect(direction('שלום')).toBe(true);
  expect(direction('Trailing side')).toBe(true);
  expect(direction('First item')).toBe(true);
  // The direction comes from the paragraph style, and an explicit off value overrides it.
  expect(direction('Styled direction')).toBe(true);
  expect(direction('Explicit left to right')).toBe(false);
  expect(direction('Cell text')).toBe(true);
});

it('lays the independent fixture out from the right margin', async () => {
  const { pkg } = await open(fixture());
  const geometry = pageGeometry(pkg.pageSettings), result = layoutDocument(pkg.paragraphs, measure, geometry, pkg.numbering, pkg.tables);
  const left = geometry.left, right = geometry.width - geometry.right;
  const lineOf = text => { const p = pkg.paragraphs.find(q => paragraphText(q).startsWith(text)); return result.lines.find(l => l.paragraphId === p.id); };
  const extent = line => [Math.min(...line.fragments.map(f => f.x)), Math.max(...line.fragments.map(f => f.x + f.width))];
  expect(extent(lineOf('Left to right paragraph'))[0]).toBeCloseTo(left, 6);
  expect(extent(lineOf('שלום'))[1]).toBeCloseTo(right, 6);
  // w:jc right is the trailing edge of a right-to-left paragraph: the left margin.
  expect(extent(lineOf('Trailing side'))[0]).toBeCloseTo(left, 6);
  const centered = extent(lineOf('Centered'));
  expect((centered[0] + centered[1]) / 2).toBeCloseTo((left + right) / 2, 6);
  // w:ind left=1440 hanging=720: the label starts 0.5in from the right margin and the text after its tab 1in.
  const hanging = lineOf('Label');
  const label = hanging.fragments.find(f => f.text === 'Label'), text = hanging.fragments.find(f => f.text.includes('hanging'));
  expect(label.x + label.width).toBeCloseTo(right - 48, 6);
  expect(text.x + text.width).toBeCloseTo(right - 96, 6);
  // The list label hangs to the right of its text: w:ind left=720 hanging=360 from the right margin.
  const item = lineOf('First item');
  expect(item.marker.text).toBe('1.');
  expect(item.marker.labelDirection).toBe('rtl');
  expect(item.marker.x + item.marker.width).toBeCloseTo(right - 24, 6);
  expect(extent(item)[1]).toBeCloseTo(right - 48, 6);
  expect(extent(lineOf('Styled direction'))[1]).toBeCloseTo(right, 6);
  expect(extent(lineOf('Explicit left to right'))[0]).toBeCloseTo(left, 6);
  // In the cell the paragraph starts at the cell's right edge, inside the 4680-twip column.
  const cell = lineOf('Cell text');
  expect(extent(cell)[1]).toBeGreaterThan(left + 200);
  expect(extent(cell)[1]).toBeLessThan(left + 312 + 1e-6);
  expect(extent(cell)[0]).toBeGreaterThan(left + 150);
});

it('saves a direction change as w:bidi in schema order, keeps untouched parts, and reopens it', async () => {
  const source = unzipSync(fixture());
  const { pkg, doc } = await open(fixture());
  selectIn(doc, 'Left to right paragraph'); expect(doc.setParagraphDirection(true)).toBe(true);
  selectIn(doc, 'Trailing side'); expect(doc.setParagraphDirection(false)).toBe(true);
  // A direction that is already in force is not a change.
  expect(doc.setParagraphDirection(false)).toBe(false);
  selectIn(doc, 'Centered'); doc.replace('Z');
  const saved = await save(pkg, doc), paragraphs = bodyParagraphs(saved);
  const first = paragraphs.find(p => textOf(p) === 'Left to right paragraph'), trailing = paragraphs.find(p => textOf(p) === 'Trailing side');
  expect(flag(first, 'bidi')).toBe('1');
  expect(flag(trailing, 'bidi')).toBe('0');
  // CT_PPrBase order: ... bidi, adjustRightInd, snapToGrid, spacing, ind, contextualSpacing, mirrorIndents, ..., jc.
  expect([...trailing.getElementsByTagNameNS(W, 'pPr')[0].children].map(n => n.localName)).toEqual(['bidi', 'jc']);
  expect(flag(trailing, 'jc')).toBe('right');
  // Untouched paragraphs keep their own markup, and the section stays right-to-left.
  expect(flag(paragraphs.find(p => textOf(p).startsWith('Label')), 'bidi')).toBe('');
  expect(strFromU8(saved['word/document.xml'])).toMatch(/<w:bidi\/><\/w:sectPr>/);
  for (const name of Object.keys(source)) if (name !== 'word/document.xml') expect(saved[name], name).toEqual(source[name]);
  const reopened = await open(zipSync(saved));
  expect(reopened.pkg.readOnly).not.toBe(true);
  expect(paragraphFormat(find(reopened.doc, 'Left to right paragraph'), reopened.doc.numbering).bidi).toBe(true);
  expect(paragraphFormat(find(reopened.doc, 'Trailing side'), reopened.doc.numbering).bidi).toBe(false);
  expect(paragraphFormat(find(reopened.doc, 'ZCentered'), reopened.doc.numbering)).toMatchObject({ bidi: true, alignment: 'center' });
});

it('undoes and redoes a direction change as one step', async () => {
  const { doc } = await open(fixture());
  selectIn(doc, 'Left to right paragraph'); doc.setParagraphDirection(true);
  expect(doc.paragraphFormatting.bidi).toBe(true);
  doc.undo(); expect(doc.paragraphFormatting.bidi).toBe(false);
  doc.redo(); expect(doc.paragraphFormatting.bidi).toBe(true);
});

it('aligns to a physical side, storing the reading-relative value in each paragraph', async () => {
  const { pkg, doc } = await open(fixture());
  // One selection across a left-to-right and a right-to-left paragraph.
  const from = doc.text.indexOf('Left to right paragraph'), to = doc.text.indexOf('mixed');
  doc.select(from, to);
  expect(doc.paragraphFormatting.bidi).toBe(null);
  // Both read from their own start: the same stored value, on opposite sides of the page.
  expect(doc.paragraphFormatting.alignment).toBe('left');
  expect(doc.paragraphFormatting.alignmentSide).toBe(null);
  expect(doc.setParagraphAlignment('right')).toBe(true);
  expect(doc.paragraphFormatting.alignmentSide).toBe('right');
  expect(paragraphFormat(find(doc, 'Left to right paragraph'), doc.numbering).alignment).toBe('right');
  expect(paragraphFormat(find(doc, 'שלום'), doc.numbering).alignment).toBe('left');
  expect(doc.setParagraphAlignment('right')).toBe(false);
  doc.undo();
  expect(doc.paragraphFormatting.alignmentSide).toBe(null);
  doc.redo();
  expect(doc.setParagraphAlignment('left')).toBe(true);
  const saved = bodyParagraphs(await save(pkg, doc));
  expect(flag(saved.find(p => textOf(p) === 'Left to right paragraph'), 'jc')).toBe('left');
  expect(flag(saved.find(p => textOf(p).includes('mixed')), 'jc')).toBe('right');
  // Centered and justified text are the same either way.
  doc.setParagraphAlignment('center');
  expect(doc.paragraphFormatting).toMatchObject({ alignment: 'center', alignmentSide: 'center' });
  expect(() => doc.setParagraphAlignment('start')).toThrow();
});

it('carries the direction to a new paragraph and through copy and paste', async () => {
  const { doc } = await open(fixture());
  const at = doc.text.indexOf('Trailing side');
  doc.select(at + 'Trailing'.length); doc.replace('\n');
  expect(paragraphFormat(find(doc, ' side'), doc.numbering)).toMatchObject({ bidi: true, alignment: 'right' });
  // Copy the whole right-to-left paragraph with its mark and paste it over a left-to-right one.
  const start = doc.text.indexOf('Centered');
  doc.select(start, start + 'Centered'.length + 1);
  const fragment = copyFragment(doc);
  expect(fragment.paragraphs[0]).toMatchObject({ bidi: true, alignment: 'center' });
  const html = fragmentHtml(fragment);
  expect(html).toContain('<p dir="rtl" style="white-space:pre-wrap;text-align:center">');
  const last = doc.text.indexOf('Last paragraph');
  doc.select(last, last);
  pasteFragment(doc, htmlFragment(html));
  expect(paragraphFormat(find(doc, 'Centered'), doc.numbering).bidi).toBe(true);
  const pasted = doc.paragraphs.filter(p => paragraphText(p) === 'Centered');
  expect(pasted).toHaveLength(2);
  for (const p of pasted) expect(paragraphFormat(p, doc.numbering)).toMatchObject({ bidi: true, alignment: 'center' });
  // A left-to-right fragment leaves the direction unsaid; HTML from elsewhere states it with dir.
  doc.select(0, 5);
  expect(copyFragment(doc).paragraphs[0].bidi).toBeUndefined();
  const foreign = htmlFragment('<p dir="rtl">אבג</p><p dir="rtl" style="text-align:left">דהו</p><p>plain</p>', { copied: false });
  expect(foreign.paragraphs.map(p => [p.bidi, p.alignment])).toEqual([[true, null], [true, 'right'], [undefined, null]]);
});

// §17.3.2.30 rtl: text typed in a right-to-left paragraph is saved with the direction of its letters, so
// the reference application orders it as this editor shows it.
it('marks text typed in a right-to-left paragraph with its run direction and saves w:rtl', async () => {
  const { pkg, doc } = await open(fixture());
  const runsOf = text => find(doc, text).runs.map(r => [r.text, !!r.rtl]);
  // After the ordinary (left-to-right) run "Trailing side": a space, a Hebrew word and a period, key by key.
  const at = doc.text.indexOf('Trailing side') + 'Trailing side'.length;
  doc.select(at);
  for (const key of [' ', 'ש', 'ל', 'ו', 'ם', '.']) doc.replace(key);
  expect(runsOf('Trailing side')).toEqual([['Trailing side', false], [' שלום.', true]]);
  // Going on in Latin: the word is an ordinary run again, and the space before it stays with the Hebrew.
  for (const key of [' ', 'o', 'k']) doc.replace(key);
  expect(runsOf('Trailing side')).toEqual([['Trailing side', false], [' שלום. ', true], ['ok', false]]);
  // A second Latin word: the space between two Latin words belongs to them.
  for (const key of [' ', 'g', 'o']) doc.replace(key);
  expect(runsOf('Trailing side')).toEqual([['Trailing side', false], [' שלום. ', true], ['ok go', false]]);
  // Deleting the Hebrew sentence leaves Latin on both sides of its spaces: they are ordinary again.
  const from = doc.text.indexOf('שלום.');
  doc.select(from, from + 'שלום.'.length); doc.replace('');
  // (They keep an explicit "not right-to-left", so they stay a run of their own.)
  expect(runsOf('Trailing side')).toEqual([['Trailing side', false], ['  ok go', false]]);
  doc.undo();
  expect(runsOf('Trailing side')).toEqual([['Trailing side', false], [' שלום. ', true], ['ok go', false]]);
  // Splitting a paragraph changes no run: the imported sentence keeps the directions it was written with.
  const imported = () => doc.paragraphs.find(q => paragraphText(q).includes('mixed 123.')).runs.map(r => [r.text, !!r.rtl]);
  const before = imported();
  doc.select(doc.text.indexOf('mixed 123.') + 'mixed 123.'.length); doc.replace('\n');
  expect(imported()).toEqual(before);
  doc.undo();
  // A left-to-right paragraph is not touched: Hebrew typed there stays in its ordinary run.
  doc.select(0); doc.replace('אב ');
  expect(runsOf('אב Left to right')).toEqual([['אב Left to right paragraph', false]]);
  const saved = await save(pkg, doc), paragraph = bodyParagraphs(saved).find(p => textOf(p).startsWith('Trailing side'));
  // null: no w:rtl; '0': stated off (text typed after right-to-left text); otherwise on.
  const runs = [...paragraph.getElementsByTagNameNS(W, 'r')].map(r => { const node = r.getElementsByTagNameNS(W, 'rtl')[0]; return [textOf(r), node ? node.getAttributeNS(W, 'val') ?? '' : null]; });
  expect(runs[0]).toEqual(['Trailing side', null]);
  expect(runs[1][0]).toBe(' שלום. '); expect(['', '1']).toContain(runs[1][1]);
  expect(runs[2]).toEqual(['ok go', '0']);
  const reopened = await open(zipSync(saved));
  expect(find(reopened.doc, 'Trailing side').runs.map(r => [r.text, !!r.rtl])).toEqual([['Trailing side', false], [' שלום. ', true], ['ok go', false]]);
});

it('gives text typed before the paragraph was turned its direction, once, with the paragraph', async () => {
  const { doc } = await open(fixture());
  doc.select(0, 'Left to right paragraph'.length); doc.replace('שלום עולם (abc).');
  const p = () => find(doc, 'שלום');
  expect(p().runs.map(r => [r.text, !!r.rtl])).toEqual([['שלום עולם (abc).', false]]);
  doc.setParagraphDirection(true);
  expect(p().runs.map(r => [r.text, !!r.rtl])).toEqual([['שלום עולם (', true], ['abc', false], [').', true]]);
  doc.undo();
  expect(p().runs.map(r => [r.text, !!r.rtl])).toEqual([['שלום עולם (abc).', false]]);
  expect(paragraphFormat(p(), doc.numbering).bidi).toBe(false);
  doc.redo();
  // Back to left-to-right and right-to-left again: the runs already state their direction and are kept.
  doc.setParagraphDirection(false);
  expect(p().runs.map(r => !!r.rtl)).toEqual([true, false, true]);
  // An imported right-to-left paragraph's runs are never rewritten by the command.
  selectIn(doc, 'Styled direction'); doc.setParagraphDirection(false); doc.setParagraphDirection(true);
  expect(find(doc, 'Styled direction').runs.map(r => [r.text, !!r.rtl])).toEqual([['Styled direction', false]]);
});

it('keeps right-to-left sections with columns or line numbers read-only, untouched', async () => {
  for (const extra of ['<w:cols w:num="2" w:space="720"/>', '<w:lnNumType w:countBy="1"/>']) {
    const parts = unzipSync(fixture());
    // CT_SectPr order: pgSz, pgMar, ..., lnNumType, pgNumType, cols, ..., bidi.
    parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:bidi/></w:sectPr>', `${extra}<w:bidi/></w:sectPr>`));
    await expect(DocxPackage.open(zipSync(parts))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
    const preview = await DocxPackage.open(zipSync(parts), { bestEffort: true });
    expect(preview.readOnly).toBe(true);
    expect(preview.previewIssues).toContain('right-to-left section columns or line numbers');
    expect(preview.parts).toEqual(parts);
  }
  // The same columns without the right-to-left section stay editable.
  const parts = unzipSync(fixture());
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:bidi/></w:sectPr>', '<w:cols w:num="2" w:space="720"/></w:sectPr>'));
  expect((await DocxPackage.open(zipSync(parts), { bestEffort: true })).readOnly).not.toBe(true);
});
