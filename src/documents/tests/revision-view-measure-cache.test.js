import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { revisionView, registerRevisionAuthors } from '../src/engine/revisions.js';

// Measured paragraphs are remembered by what they show of the revision view (Display for Review, the
// Show Markup options, reviewers' colors and hidden text). They were remembered by the whole view, so
// a new reviewer or another Display for Review measured every paragraph of the document again, even
// those without any change. Each view must still lay out exactly as a fresh measurement does.

let dom;
const initialView = structuredClone(revisionView);
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
afterEach(() => { for (const key of Object.keys(revisionView)) delete revisionView[key]; Object.assign(revisionView, structuredClone(initialView)); });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const by = (author, id) => `w:id="${id}" w:author="${author}" w:date="2026-01-01T00:00:00Z"`;
const run = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const ins = (author, id, text) => `<w:ins ${by(author, id)}>${run(text)}</w:ins>`;
const del = (author, id, text) => `<w:del ${by(author, id)}><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
const plain = i => `<w:p>${run(`Plain paragraph ${i} has no change at all and wraps across the width of the page more than once.`)}</w:p>`;

/** Independently written: plain paragraphs between changes by two reviewers, a move, formatting changes, hidden text, a table, a header and a note. */
function reviewedDocx() {
  const body = [
    plain(0),
    `<w:p>${run('Inserted by Ann: ')}${ins('Ann', 10, 'new words here')}${run(' and the rest.')}</w:p>`,
    plain(1),
    `<w:p>${run('Deleted by Bob: ')}${del('Bob', 11, 'old words there')}${run(' then more.')}</w:p>`,
    `<w:p>${run('Formatting changed: ')}<w:r><w:rPr><w:b/><w:rPrChange ${by('Ann', 12)}><w:rPr/></w:rPrChange></w:rPr><w:t>now bold</w:t></w:r></w:p>`,
    `<w:p>${run('Hidden text follows: ')}${run('secret words', '<w:vanish/>')}${run(' and is styled hidden: ')}${run('styled secret', '<w:rStyle w:val="Hidden"/>')}</w:p>`,
    `<w:p><w:moveFrom ${by('Bob', 13)}><w:r><w:delText>Moved away</w:delText></w:r></w:moveFrom>${run(' stays.')}</w:p>`,
    `<w:p>${run('A note is referenced here')}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>${run('.')}</w:p>`,
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${run('Cell with ')}${ins('Cy', 14, 'an insertion')}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${run('Plain cell')}</w:p></w:tc></w:tr></w:tbl>`,
    plain(2),
  ].join('');
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rId3" Type="${REL}/footnotes" Target="footnotes.xml"/></Relationships>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:styleId="Hidden"><w:name w:val="Hidden"/><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`,
    'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p>${run('Header ')}<w:r><w:rPr><w:i/><w:rPrChange ${by('Dee', 20)}><w:rPr/></w:rPrChange></w:rPr><w:t>now italic</w:t></w:r>${run(' with ')}${run('styled secret', '<w:rStyle w:val="Hidden"/>')}</w:p></w:hdr>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${run(' The note ')}${del('Eve', 30, 'lost')}${run(' text.')}</w:p></w:footnote></w:footnotes>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}

const metrics = (text, style) => ({ width: [...text].length * (style.fontSize ?? 12) * (style.bold ? .6 : .5), ascent: style.fontSize ?? 12, descent: (style.fontSize ?? 12) / 3 });
// A measurer that remembers measured paragraphs, as the canvas editor's does, and records what it measures.
function cachedMeasure() {
  const calls = [], cache = new ParagraphMeasureCache();
  const measure = (text, style) => { calls.push(text); return metrics(text, style); };
  measure.paragraphCache = () => cache;
  return { measure, calls, cache };
}
// The body and its page stories as one layout of the editor lays them out, and what painting reads of them.
function lay(pkg, doc, measure) {
  const options = { styles: doc.styles };
  const body = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories, options);
  const stories = layoutPageStories(body, pkg.pageStories, [doc.pageSettings], measure, doc.numbering, options);
  const { flowSignature, ...rest } = body;
  return JSON.parse(JSON.stringify({ body: rest, stories: { lines: stories.lines, cells: stories.cells } }));
}
async function opened() {
  const pkg = await DocxPackage.open(reviewedDocx());
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  registerRevisionAuthors(doc.paragraphs);
  return { pkg, doc };
}

// Each step changes the view; every layout must equal a fresh measurement in that view.
const steps = [
  ['Simple Markup', () => { revisionView.mode = 'simple'; }],
  ['No Markup', () => { revisionView.mode = 'none'; }],
  ['Original', () => { revisionView.mode = 'original'; }],
  ['All Markup', () => { revisionView.mode = 'all'; }],
  ['a new reviewer', () => { revisionView.authors.push('Zed'); }],
  ['hidden text shown', () => { revisionView.showHidden = true; }],
  ['formatting marked bold', () => { revisionView.options.formatMark = 'bold'; }],
  ['insertions in a fixed color', () => { revisionView.options.insertColor = '00FF00'; revisionView.options.insertMark = 'doubleUnderline'; }],
  ['a reviewer\'s own color', () => { revisionView.options.authorColors = { Bob: '123456' }; }],
  ['a reviewer hidden', () => { revisionView.options.hiddenAuthors = ['Ann']; }],
  ['deletions in balloons', () => { revisionView.options.balloons = 'balloons'; }],
  ['moves not tracked', () => { revisionView.options.trackMoves = false; }],
  ['insertions and deletions hidden', () => { revisionView.options.showInsDel = false; }],
  ['hidden text hidden', () => { revisionView.showHidden = false; }],
  ['Simple Markup again', () => { revisionView.mode = 'simple'; }],
];

it('lays each revision view out as a fresh measurement does, switching back and forth', async () => {
  const { pkg, doc } = await opened();
  const { measure, cache } = cachedMeasure();
  const fresh = () => lay(pkg, doc, metrics);
  const cached = () => { cache.nextGeneration(); return lay(pkg, doc, measure); };
  expect(cached()).toEqual(fresh());
  const seen = new Set([JSON.stringify(fresh())]);
  for (const [name, change] of [...steps, ...steps.slice(0, 4).reverse()]) {
    change();
    const expected = fresh();
    seen.add(JSON.stringify(expected));
    expect(cached(), name).toEqual(expected);
  }
  // The steps did change what is shown.
  expect(seen.size).toBeGreaterThan(8);
  // A tracked edit afterwards, in the view it was made in.
  doc.trackChanges = true; doc.revisionAuthor = 'New';
  doc.select(doc.text.indexOf('Plain paragraph 1') + 6); doc.replace('typed ');
  registerRevisionAuthors(doc.paragraphs);
  revisionView.mode = 'all';
  expect(cached()).toEqual(fresh());
});

it('measures only paragraphs with changes or hidden text again for a new reviewer or another markup view', async () => {
  const { pkg, doc } = await opened();
  const { measure, calls, cache } = cachedMeasure();
  const layout = () => { cache.nextGeneration(); calls.length = 0; lay(pkg, doc, measure); return calls.join('\n'); };
  layout();
  // The first tracked change by a reviewer new to the document gives them a color.
  revisionView.authors.push('Author');
  expect(layout()).toBe('');
  // No Markup shows the changes as Simple Markup does: what Simple Markup measured serves it.
  for (const [mode, changed] of [['simple', true], ['none', false], ['original', true]]) {
    revisionView.mode = mode;
    const measured = layout();
    expect(measured, mode).not.toMatch(/Plain paragraph|Plain cell/);
    if (changed) expect(measured, mode).toMatch(/Inserted by Ann/); else expect(measured, mode).toBe('');
  }
  // Back to a view laid out before: nothing is measured again.
  revisionView.mode = 'all';
  expect(layout()).toBe('');
});
