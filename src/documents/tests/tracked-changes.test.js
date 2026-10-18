import { beforeAll, afterAll, it, expect, describe, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph, boundaries } from '../src/engine/model.js';
import { revisionRanges, revisionDisplay } from '../src/engine/revisions.js';
import { pasteFragment } from '../src/engine/clipboard-fragment.js';
import { insertBodyField } from '../src/engine/field-results.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { insertCrossReference, referenceTargets } from '../src/engine/captions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** Independently written: an insertion, a deletion, an inserted paragraph mark and Track Changes on. */
function trackedDocx({ track = true } = {}) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    'word/settings.xml': `<w:settings xmlns:w="${W}">${track ? '<w:trackRevisions/>' : ''}<w:defaultTabStop w:val="720"/></w:settings>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>`
      + `<w:p><w:pPr><w:rPr><w:ins w:id="9" w:author="Ada" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2" w:author="Grace" w:date="2026-01-02T00:00:00Z"><w:r><w:delText xml:space="preserve"> removed</w:delText></w:r></w:del><w:r><w:t xml:space="preserve"> end.</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>Second</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
const open = async bytes => { const pkg = await DocxPackage.open(bytes); const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments, trackChanges: pkg.trackRevisions }); model.revisionAuthor = 'Me'; return { pkg, model }; };
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments, d.trackChanges).arrayBuffer());
const summary = d => d.revisions.map(r => [r.type, r.author, d.text.slice(r.start, r.end), ...(r.marks ? ['¶'] : [])]);

function formattedDocx() {
  const files = unzipSync(trackedDocx({ track: false }));
  files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>`
    + `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="5" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Centered now</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/><w:rPrChange w:id="6" w:author="Grace" w:date="2026-01-02T00:00:00Z"><w:rPr><w:vanish/></w:rPr></w:rPrChange></w:rPr><w:t>bolded</w:t></w:r></w:p>`
    + `<w:sectPr/></w:body></w:document>`);
  return zipSync(files);
}

describe('tracked changes', () => {
  it('keeps tracked formatting changes, lists them and accepts them', async () => {
    const source = formattedDocx(), { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(model.paragraphs[1].runs[1].bold).toBe(true);
    expect(model.revisions.map(r => [r.type, r.author, model.text.slice(r.start, r.end)])).toEqual([['format', 'Ada', 'Centered now\n'], ['format', 'Grace', 'bolded']]);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    // Rejecting restores the recorded former formatting.
    const rejected = await open(source);
    rejected.model.resolveRevisions(false);
    expect(rejected.model.formatRejectSkipped).toBe(false);
    expect(rejected.model.revisions).toEqual([]);
    expect(rejected.model.paragraphs[0].format.alignment).toBe('left');
    expect(rejected.model.paragraphs[1].runs.at(-1)).toMatchObject({ text: 'bolded', bold: false, vanish: true });
    const restored = strFromU8(unzipSync(await save(rejected.pkg, rejected.model))['word/document.xml']);
    expect(restored).not.toMatch(/PrChange/);
    expect(restored).toMatch(/<w:jc w:val="left"\/>/);
    expect(restored).toMatch(/<w:vanish\/>/);
    expect(restored).not.toMatch(/<w:b\/>/);
    model.resolveRevisions(true);
    expect(model.revisions).toEqual([]);
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml).not.toMatch(/PrChange/);
    expect(xml).toMatch(/<w:jc w:val="center"\/>/);
    expect(xml).toMatch(/<w:b\/>/);
  });

  it('opens tracked insertions, deletions and paragraph marks for editing', async () => {
    const { pkg, model } = await open(trackedDocx());
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.trackRevisions).toBe(true);
    expect(model.text).toBe('Keep added removed end.\nSecond');
    expect(summary(model)).toEqual([['ins', 'Ada', 'added'], ['del', 'Grace', ' removed'], ['ins', 'Ada', '\n', '¶']]);
  });

  it('saves an untouched tracked document byte for byte and keeps revisions through edits', async () => {
    const source = trackedDocx(), { pkg, model } = await open(source);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    model.trackChanges = false;
    model.select(model.text.length); model.replace('!');
    const again = await open(await save(pkg, model));
    expect(summary(again.model)).toEqual(summary(model));
    expect(again.pkg.trackRevisions).toBe(false);
  });

  it('records typing and deletion while tracking', async () => {
    const { pkg, model } = await open(trackedDocx());
    const at = model.text.indexOf('Second');
    model.select(at + 6); model.replace(' line');
    // A deleted selection stays visible; the caret lands after it.
    model.select(at, at + 3); model.delete(-1);
    expect(model.selection.focus).toBe(at + 3);
    model.select(at + 3); model.delete(-1);
    expect(model.selection.focus).toBe(at + 2);
    model.select(0); model.delete(1);
    expect(model.selection.focus).toBe(1);
    expect(model.text).toBe('Keep added removed end.\nSecond line');
    const mine = summary(model).filter(r => r[1] === 'Me');
    expect(mine).toEqual([['del', 'Me', 'K'], ['del', 'Me', 'Sec'], ['ins', 'Me', ' line']]); // Backspace over struck text only moves the caret.
    // Deleting your own insertion removes it outright.
    model.select(model.text.length - 2, model.text.length); model.replace('');
    expect(model.text.endsWith('Second li')).toBe(true);
    const reopened = await open(await save(pkg, model));
    expect(summary(reopened.model)).toEqual(summary(model));
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml).toMatch(/<w:del [^>]*w:author="Me"[^>]*><w:r><w:delText xml:space="preserve">Sec<\/w:delText><\/w:r><\/w:del>/);
  });

  it('keeps one burst of typing as one insertion across a clock second, but not an old insertion', async () => {
    const { pkg, model } = await open(trackedDocx());
    const at = model.text.indexOf('Second') + 6;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-01T10:00:00.900Z'));
      model.select(at); model.replace(' M');
      vi.setSystemTime(new Date('2026-05-01T10:00:01.100Z'));
      model.replace('ore');
      expect(summary(model).filter(r => r[1] === 'Me')).toEqual([['ins', 'Me', ' More']]);
      // Ada's months-old insertion is not extended by her typing now.
      model.revisionAuthor = 'Ada';
      model.select(model.text.indexOf('added') + 5); model.replace('!');
      expect(summary(model)).toEqual(expect.arrayContaining([['ins', 'Ada', 'added'], ['ins', 'Ada', '!']]));
      model.revisionAuthor = 'Me';
    } finally { vi.useRealTimers(); }
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml.match(/<w:ins [^>]*w:author="Me"[^>]*>/g)).toHaveLength(1);
    expect(xml.replace(/<\/w:t><\/w:r><w:r><w:t xml:space="preserve">/g, '')).toMatch(/<w:ins [^>]*w:author="Me"[^>]*><w:r><w:t xml:space="preserve"> More<\/w:t><\/w:r><\/w:ins>/);
  });
  it('accepts and rejects changes, singly and all at once', async () => {
    let { model } = await open(trackedDocx());
    model.select(model.text.indexOf('added') + 1);
    model.resolveRevisions(true, ...model.range);
    expect(summary(model).map(r => r[2])).toEqual([' removed', '\n']);
    model.resolveRevisions(true);
    expect(model.text).toBe('Keep added end.\nSecond');
    expect(model.revisions).toEqual([]);
    ({ model } = await open(trackedDocx()));
    model.resolveRevisions(false);
    expect(model.text).toBe('Keep  removed end.Second');
    model.undo();
    expect(model.text).toBe('Keep added removed end.\nSecond');
  });

  it('marks pasted and typed text, and leaves untracked typing plain', async () => {
    const pkg = createDocx([paragraph('Hello')]);
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
    model.revisionAuthor = 'Me';
    model.select(5); model.replace(' world\nNext');
    expect(summary(model)).toEqual([['ins', 'Me', ' world\nNext', '¶']]);
    model.trackChanges = false;
    model.select(model.text.indexOf('world') + 2); model.replace('X');
    expect(model.text).toBe('Hello woXrld\nNext');
    expect(revisionRanges(model.paragraphs).map(r => model.text.slice(r.start, r.end))).toEqual([' wo', 'rld\nNext']);
    expect(revisionDisplay({ type: 'del' }, 'none')).toEqual({ hidden: true });
  });
});

describe('tracked change edge cases', () => {
  const three = () => { const pkg = createDocx([paragraph('First'), paragraph('Second'), paragraph('Third')]); const m = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true }); m.revisionAuthor = 'Me'; return { pkg, m }; };
  it('accepting a deleted paragraph mark leaves no stale mark revision', () => {
    const { m } = three();
    m.select(3, 9); m.replace('');
    m.resolveRevisions(true);
    expect(m.text).toBe('Firond\nThird');
    expect(m.revisions).toEqual([]);
  });
  it('rejecting a tracked Enter restores the paragraph without a stale insertion', () => {
    const { m } = three();
    m.select(2); m.replace('\n');
    m.resolveRevisions(false);
    expect(m.text).toBe('First\nSecond\nThird');
    expect(m.revisions).toEqual([]);
    m.select(5); m.insertParagraph(); m.replace('New'); m.resolveRevisions(false);
    expect(m.text).toBe('First\nSecond\nThird'); expect(m.revisions).toEqual([]);
  });
  it('accepting the deletion of a whole paragraph leaves no zero-length change', () => {
    const { m } = three();
    m.select(6, 13); m.replace(''); m.resolveRevisions(true);
    expect(m.text).toBe('First\nThird'); expect(m.revisions).toEqual([]);
  });
  it('marks exactly the inserted text when line endings are normalized', () => {
    const pkg = createDocx([paragraph('Hello world')]);
    const m = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true }); m.revisionAuthor = 'Me';
    m.select(5); m.replace('A\r\nB');
    expect(summary(m)).toEqual([['ins', 'Me', 'A\nB', '¶']]);
  });
  it('keeps another reviewer\'s insertion under a deletion, round-trips it and restores it on reject', async () => {
    const files = unzipSync(trackedDocx());
    files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>theirs</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> B</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    const { pkg, model } = await open(zipSync(files));
    model.select(2, 8); model.replace('');
    expect(model.text).toBe('A theirs B');
    expect(summary(model)).toEqual([['del', 'Me', 'theirs']]);
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml).toMatch(/<w:ins [^>]*w:author="Ada"[^>]*><w:del [^>]*w:author="Me"[^>]*><w:r><w:delText xml:space="preserve">theirs<\/w:delText><\/w:r><\/w:del><\/w:ins>/);
    const again = await open(await save(pkg, model));
    expect(summary(again.model)).toEqual([['del', 'Me', 'theirs']]);
    again.model.resolveRevisions(false);
    expect(summary(again.model)).toEqual([['ins', 'Ada', 'theirs']]);
  });
  it('never marks a table cell\'s final paragraph mark as deleted', async () => {
    const files = unzipSync(trackedDocx());
    const cell = t => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${cell('One')}${cell('Two')}</w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    const { model } = await open(zipSync(files));
    model.select(model.text.indexOf('One') + 1, model.text.indexOf('Two') + 1); model.replace('');
    expect(model.paragraphs.some(p => p.markRevision)).toBe(false);
    model.resolveRevisions(true);
    expect(model.revisions).toEqual([]);
  });
  it('formats pasted text, not the struck-out selection, when pasting with tracking on', () => {
    const pkg = createDocx([paragraph('Hello world')]);
    const m = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true }); m.revisionAuthor = 'Me';
    m.select(0, 5);
    pasteFragment(m, { paragraphs: [{ text: 'XY', mark: false, runs: [{ text: 'XY', format: { bold: true } }] }] });
    const runs = m.paragraphs[0].runs;
    expect(runs.find(r => r.text.includes('XY')).bold).toBe(true);
    expect(runs.find(r => r.text.includes('Hello')).bold).not.toBe(true);
    expect(m.selection.focus).toBe(7);
  });
  it('turns Track Changes on when settings carry trackRevisions off', async () => {
    const files = unzipSync(trackedDocx({ track: false }));
    files['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}"><w:trackRevisions w:val="0"/><w:defaultTabStop w:val="720"/></w:settings>`);
    const { pkg, model } = await open(zipSync(files));
    expect(pkg.trackRevisions).toBe(false);
    model.trackChanges = true;
    expect((await open(await save(pkg, model))).pkg.trackRevisions).toBe(true);
  });
});

describe('a tracked edit that joins two characters into one', () => {
  it('leaves the caret after the whole character, so Delete removes only the next one', () => {
    const doc = new TextDocument([paragraph('Intro paragraph.'), paragraph('Second \u{1F1F8}tail')]);
    doc.trackChanges = true; doc.revisionAuthor = 'Me';
    const at = doc.text.indexOf('\u{1F1F8}');
    doc.select(at); doc.replace('\u{1F1FA}'); // completes the flag 🇺🇸
    expect(doc.selection.focus).toBe(at + 4);
    expect(boundaries(doc.text)).toContain(doc.selection.focus);
    doc.delete(1);
    expect(revisionRanges(doc.paragraphs).filter(r => r.type === 'del').map(r => doc.text.slice(r.start, r.end))).toEqual(['t']);
  });
  it('after Accept joins two halves, Delete does not reach back to the document start', () => {
    const doc = new TextDocument([paragraph('First paragraph.'), paragraph('Flag \u{1F1FA}X\u{1F1F8} end')]);
    doc.trackChanges = true; doc.revisionAuthor = 'Reviewer';
    const x = doc.text.indexOf('X'); doc.select(x, x + 1); doc.replace('');
    doc.trackChanges = false; doc.select(x);
    doc.resolveRevisions(true, x, x + 1);
    expect(boundaries(doc.text)).toContain(doc.selection.focus);
    doc.delete(1);
    expect(doc.text).toBe('First paragraph.\nFlag \u{1F1FA}\u{1F1F8}end');
  });
  it('a caret left inside a character moves after it before Delete', () => {
    const doc = new TextDocument([paragraph('Keep this.'), paragraph('a\u{1F1FA}\u{1F1F8}b')]);
    const at = doc.text.indexOf('\u{1F1FA}') + 2;
    doc.selection = { anchor: at, focus: at };
    doc.delete(-1);
    expect(doc.text).toBe('Keep this.\nab');
  });
});

describe('fields inserted over a selection with Track Changes on', () => {
  it('Insert Field wraps exactly the new result, after the struck-out selection', () => {
    const pkg = createDocx([paragraph('Due OLD today')]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
    doc.trackChanges = true; doc.revisionAuthor = 'Me';
    doc.select(4, 7); insertBodyField(doc, ' DATE \\@ "yyyy" ', '2026');
    const range = bodyFieldRanges(doc.paragraphs)[0];
    expect(doc.text.slice(range.start, range.end)).toBe('2026');
    expect(revisionRanges(doc.paragraphs).map(r => [r.type, doc.text.slice(r.start, r.end)])).toEqual([['del', 'OLD'], ['ins', '2026']]);
  });
  it('a cross-reference marks the text it replaces as deleted', () => {
    const pkg = createDocx([paragraph('Heading target'), paragraph('See OLD here')]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
    doc.select(0, 14); doc.addBookmark('Target');
    doc.trackChanges = true; doc.revisionAuthor = 'Me';
    doc.select(19, 22);
    insertCrossReference(doc, referenceTargets(doc).bookmarks[0], { show: 'text' });
    expect(revisionRanges(doc.paragraphs).map(r => [r.type, doc.text.slice(r.start, r.end)])).toEqual([['del', 'OLD'], ['ins', 'Heading target']]);
    const range = bodyFieldRanges(doc.paragraphs)[0];
    expect(doc.text.slice(range.start, range.end)).toBe('Heading target');
  });
});


describe('Replace over tracked text with Track Changes off', () => {
  it('writes the new text as plain text, not as part of the found text\'s insertion or deletion', async () => {
    const { pkg, model } = await open(trackedDocx({ track: false }));
    expect(model.trackChanges).toBe(false);
    expect(model.replaceMatches('removed', 'gone', {}, true)).toBe(1);
    expect(model.replaceMatches('added', 'joined', {}, true)).toBe(1);
    // The rest of the original changes stay (the deleted space before "removed", the inserted paragraph mark).
    expect(summary(model).map(([, , text]) => text).join('|')).not.toMatch(/gone|joined/);
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    const parsed = new DOMParser().parseFromString(xml, 'application/xml');
    expect(['ins', 'del'].flatMap(tag => [...parsed.getElementsByTagNameNS(W, tag)]).map(e => e.textContent).join('|')).not.toMatch(/gone|joined/);
    expect(model.text).toContain('Keep joined gone end.');
  });
});
