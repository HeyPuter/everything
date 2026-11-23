import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { setDropCap, dropCapState } from '../src/engine/drop-caps.js';
import { frameDimensions } from '../src/engine/paragraph-frames.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const BODY = 'Hello ' + 'word '.repeat(80);
const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });
const layout = d => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables);
const texts = d => d.paragraphs.map(paragraphText);
function fresh(text = BODY) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace(text); d.select(3);
  return { pkg, d };
}
const save = async (pkg, d) => new Uint8Array(await (await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets)).arrayBuffer());
// The cap's visible baseline includes its w:position lowering.
const capBaseline = line => line.baseline - (line.fragments[0].baselineShift || 0) * 4 / 3;

it('drop moves the first letter into a framed paragraph that survives export and reopens editable', async () => {
  const { pkg, d } = fresh();
  expect(dropCapState(d)).toMatchObject({ mode: 'none' });
  expect(setDropCap(d, { mode: 'drop', lines: 3, distance: 2 })).toBe(true);
  expect(texts(d)).toEqual(['H', BODY.slice(1)]);
  expect(d.paragraphs[0].frameProperties).toEqual({ dropCap: 'drop', lines: '3', wrap: 'around', vAnchor: 'text', hAnchor: 'text', hSpace: '40' });
  expect(d.paragraphs[0].format).toMatchObject({ lineRule: 'exact', spaceAfter: 0 });
  expect(d.paragraphs[0].runs[0].fontSize).toBeGreaterThan(36);
  expect(d.selection.focus).toBe(4); // The caret stays after "Hel".
  expect(dropCapState(d)).toEqual({ mode: 'drop', lines: 3, distance: 2, fontFamily: 'Noto Sans' });
  const bytes = await save(pkg, d), xml = new TextDecoder().decode(unzipSync(bytes)['word/document.xml']);
  expect(xml).toMatch(/<w:framePr w:dropCap="drop" w:lines="3"[^>]*\/>/);
  expect(xml).not.toContain('<w:ind');
  const again = await DocxPackage.open(bytes);
  expect(again.readOnly).toBeFalsy();
  expect(again.paragraphs[0].frameProperties).toMatchObject({ dropCap: 'drop', lines: '3', hSpace: '40' });
  expect(again.paragraphs.map(paragraphText)).toEqual(['H', BODY.slice(1)]);
});

it('none merges the letter back with the text paragraph formatting, in one undo step', async () => {
  const { pkg, d } = fresh();
  d.select(3); d.setParagraphFormat({ spaceAfter: 6 });
  setDropCap(d, { mode: 'drop', lines: 3 });
  d.select(8);
  expect(dropCapState(d).mode).toBe('drop');
  expect(setDropCap(d, { mode: 'none' })).toBe(true);
  expect(texts(d)).toEqual([BODY]);
  expect(d.paragraphs[0].runs).toHaveLength(1);
  expect(d.paragraphs[0].frameProperties).toBeUndefined();
  expect(d.paragraphs[0].format).toMatchObject({ lineRule: 'auto', spaceAfter: 6 });
  expect(d.selection.focus).toBe(7);
  const again = await DocxPackage.open(await save(pkg, d));
  expect(again.paragraphs.map(paragraphText)).toEqual([BODY]);
  expect(again.paragraphs[0].frameProperties).toBeUndefined();
  expect(setDropCap(d, { mode: 'none' })).toBe(false);
  d.undo(); expect(texts(d)).toEqual(['H', BODY.slice(1)]);
  d.undo(); expect(texts(d)).toEqual([BODY]);
});

it('changing an existing drop cap updates it in place and is one session undo step', () => {
  const { d } = fresh();
  const session = new StorySession(d);
  session.run(model => setDropCap(model, { mode: 'drop', lines: 3 }));
  const size = d.paragraphs[0].runs[0].fontSize;
  d.select(20);
  session.run(model => setDropCap(model, { mode: 'margin', lines: 2, distance: 3, fontFamily: 'Serif Test' }));
  expect(texts(d)).toEqual(['H', BODY.slice(1)]);
  expect(d.paragraphs[0].frameProperties).toEqual({ dropCap: 'margin', lines: '2', wrap: 'around', vAnchor: 'text', hAnchor: 'page', hSpace: '60' });
  expect(d.paragraphs[0].runs[0].fontSize).toBeLessThan(size);
  expect(d.paragraphs[0].runs[0].fontHAnsi).toBe('Serif Test');
  expect(dropCapState(d)).toEqual({ mode: 'margin', lines: 2, distance: 3, fontFamily: 'Serif Test' });
  session.undo(); expect(session.model.paragraphs[0].frameProperties.dropCap).toBe('drop');
  session.undo(); expect(session.model.paragraphs.map(paragraphText)).toEqual([BODY]);
});

it('rejects paragraphs that cannot take a drop cap without changing them', () => {
  const { d } = fresh('');
  expect(() => setDropCap(d, { mode: 'drop' })).toThrow('Type some text');
  const list = fresh(); list.d.toggleList('bullet');
  expect(() => setDropCap(list.d, { mode: 'drop' })).toThrow('list items');
  const space = fresh(' leading space'); space.d.select(3);
  expect(() => setDropCap(space.d, { mode: 'drop' })).toThrow('visible character');
  expect(texts(space.d)).toEqual([' leading space']);
  const table = fresh('Before'); table.d.select(6); table.d.insertTable(1, 1); table.d.replace('Cell');
  expect(() => setDropCap(table.d, { mode: 'drop' })).toThrow('table cells');
  expect(() => setDropCap(fresh().d, { mode: 'raised' })).toThrow();
  expect(() => setDropCap(fresh().d, { mode: 'drop', lines: 11 })).toThrow('1–10 lines');
});

it('drop indents the first lines of the following paragraph and aligns the cap baseline to line three', () => {
  const { d } = fresh();
  setDropCap(d, { mode: 'drop', lines: 3, distance: 2 });
  const placed = layout(d), page = pageGeometry(d.pageSettings), frame = placed.paragraphFrames[0];
  const body = placed.lines.filter(l => l.paragraphId === d.paragraphs[1].id), cap = placed.lines.find(l => l.frameId);
  expect(frame).toMatchObject({ dropCap: 'drop', left: page.left, top: body[0].y });
  expect(frame.bottom).toBe(body[2].y + body[2].height);
  for (const line of body.slice(0, 3)) expect(line.stops[0].x).toBeCloseTo(frame.right + 40 / 15, 6);
  expect(body[3].stops[0].x).toBe(page.left);
  expect(capBaseline(cap)).toBeCloseTo(body[2].baseline, 6);
  expect(cap.cellClip.bottom).toBeGreaterThanOrEqual(frame.bottom);
});

it('margin places the cap left of the column without indenting the text', () => {
  const { d } = fresh();
  setDropCap(d, { mode: 'margin', lines: 3, distance: 2 });
  const placed = layout(d), page = pageGeometry(d.pageSettings), frame = placed.paragraphFrames[0];
  const body = placed.lines.filter(l => l.paragraphId === d.paragraphs[1].id), cap = placed.lines.find(l => l.frameId);
  expect(frame.right).toBeCloseTo(page.left - 40 / 15, 6);
  expect(frame.wrap).toBe('none');
  for (const line of body.slice(0, 4)) expect(line.stops[0].x).toBe(page.left);
  expect(capBaseline(cap)).toBeCloseTo(body[2].baseline, 6);
});

// §17.3.1.6 bidi: a right-to-left paragraph leads from the right edge, where its cap stands. Measured from
// the left, the cap took the column's whole width and the text could never settle beside it.
it('drop and margin put a right-to-left paragraph\'s cap at the right edge of the column', async () => {
  const { pkg, d } = fresh('');
  d.setParagraphDirection(true); d.replace('שלום ' + 'עולם '.repeat(80)); d.select(3);
  setDropCap(d, { mode: 'drop', lines: 3, distance: 2 });
  const page = pageGeometry(d.pageSettings), right = page.width - page.right;
  const check = (placed, paragraphs) => {
    const frame = placed.paragraphFrames[0], body = placed.lines.filter(l => l.paragraphId === paragraphs[1].id);
    const cap = placed.lines.find(l => l.frameId), edge = line => Math.max(...line.stops.map(s => s.x));
    expect(frame.right).toBeCloseTo(right, 6);
    expect(frame.right - frame.left).toBeLessThan(40);
    for (const line of body.slice(0, 3)) expect(edge(line)).toBeCloseTo(frame.left - 40 / 15, 6);
    expect(edge(body[3])).toBeCloseTo(right, 6);
    expect(capBaseline(cap)).toBeCloseTo(body[2].baseline, 6);
    // The letter is drawn inside its frame.
    for (const stop of cap.stops) { expect(stop.x).toBeGreaterThanOrEqual(frame.left - 1e-6); expect(stop.x).toBeLessThanOrEqual(frame.right + 1e-6); }
  };
  check(layout(d), d.paragraphs);
  // Measurements are remembered by their geometry: the cap's frame measured again at its own width is not
  // read back at the column's.
  const cache = new ParagraphMeasureCache(), cached = Object.assign((text, style) => measure(text, style), { paragraphCache: () => cache });
  check(layoutDocument(d.paragraphs, cached, page, d.numbering, d.tables), d.paragraphs);
  // A right-to-left letter shows its complex-script size: the cap takes both.
  const letter = d.paragraphs[0].runs[0];
  expect(letter.rtl).toBe(true);
  expect(letter.fontSize).toBeGreaterThan(30); expect(letter.fontSizeCs).toBe(letter.fontSize);
  const reopened = await DocxPackage.open(await save(pkg, d));
  check(layoutDocument(reopened.paragraphs, measure, pageGeometry(reopened.pageSettings), reopened.numbering, reopened.tables), reopened.paragraphs);
  setDropCap(d, { mode: 'margin', lines: 3, distance: 2 });
  const placed = layout(d), frame = placed.paragraphFrames[0];
  expect(frame.left).toBeCloseTo(right + 40 / 15, 6);
  for (const line of placed.lines.filter(l => l.paragraphId === d.paragraphs[1].id).slice(0, 4)) expect(Math.max(...line.stops.map(s => s.x))).toBeCloseTo(right, 6);
});

it('a short paragraph extrapolates the cap height and lets the next paragraph wrap', () => {
  const { d } = fresh('Hi there');
  d.select(8); d.replace('\n' + 'word '.repeat(60)); d.select(3);
  setDropCap(d, { mode: 'drop', lines: 3 });
  const placed = layout(d), frame = placed.paragraphFrames[0];
  const first = placed.lines.find(l => l.paragraphId === d.paragraphs[1].id);
  const next = placed.lines.filter(l => l.paragraphId === d.paragraphs[2].id);
  expect(frame.bottom - frame.top).toBeCloseTo(3 * first.height, 6);
  expect(next[0].stops[0].x).toBeCloseTo(frame.right, 6);
});

it('validates drop-cap frame declarations', () => {
  expect(frameDimensions({ dropCap: 'drop', lines: '3', hAnchor: 'page', x: '500' })).toMatchObject({ dropCap: 'drop', lines: 3, vAnchor: 'text', x: 0 });
  expect(frameDimensions({ dropCap: 'margin' }).lines).toBe(1);
  expect(frameDimensions({ dropCap: 'none', w: '1440' }).dropCap).toBeUndefined();
  expect(() => frameDimensions({ dropCap: 'raised' })).toThrow('Drop-cap');
  expect(() => frameDimensions({ dropCap: 'drop', lines: '0' })).toThrow('Drop-cap');
  expect(() => frameDimensions({ dropCap: 'drop', lines: '2.5' })).toThrow('Drop-cap');
});

// Independently written WordprocessingML, in the form desktop word processors save drop caps.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const independentDocx = mode => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>` +
    `<w:p><w:pPr><w:keepNext/><w:framePr w:dropCap="${mode}" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="${mode === 'margin' ? 'page' : 'text'}"/>` +
    '<w:spacing w:after="0" w:line="864" w:lineRule="exact"/><w:textAlignment w:val="baseline"/></w:pPr>' +
    '<w:r><w:rPr><w:position w:val="-11"/><w:sz w:val="106"/></w:rPr><w:t>O</w:t></w:r></w:p>' +
    `<w:p><w:r><w:t xml:space="preserve">nce upon a time ${'there was text. '.repeat(30)}</w:t></w:r></w:p>` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'),
});
for (const mode of ['drop', 'margin']) it(`an independently written ${mode} cap opens editable, lays out and round-trips`, async () => {
  const bytes = independentDocx(mode), pkg = await DocxPackage.open(bytes);
  expect(pkg.readOnly).toBeFalsy();
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(dropCapState(d)).toMatchObject({ mode, lines: 3 });
  const placed = layout(d), page = pageGeometry(d.pageSettings), frame = placed.paragraphFrames[0];
  const body = placed.lines.filter(l => l.paragraphId === d.paragraphs[1].id), cap = placed.lines.find(l => l.frameId);
  expect(placed.frameApproximations).toBeUndefined();
  expect(capBaseline(cap)).toBeCloseTo(body[2].baseline, 6);
  if (mode === 'drop') {
    for (const line of body.slice(0, 3)) expect(line.stops[0].x).toBeCloseTo(frame.right, 6);
    expect(body[3].stops[0].x).toBe(page.left);
  } else {
    expect(frame.right).toBeCloseTo(page.left, 6);
    expect(body[0].stops[0].x).toBe(page.left);
  }
  expect(unzipSync(await save(pkg, d))).toEqual(unzipSync(bytes));
  d.select(6); d.replace('Edited ');
  const again = await DocxPackage.open(await save(pkg, d));
  expect(again.paragraphs[0].frameProperties).toEqual(pkg.paragraphs[0].frameProperties);
  expect(again.paragraphs[1].runs.map(r => r.text).join('')).toContain('Edited ');
  d.select(0); setDropCap(d, { mode: 'none' });
  expect(d.paragraphs).toHaveLength(1);
  expect(paragraphText(d.paragraphs[0]).startsWith('Once Edited upon')).toBe(true);
});
