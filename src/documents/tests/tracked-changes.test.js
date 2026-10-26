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
import { updateSequenceFields } from '../src/engine/field-update.js';
import { insertMergeField, mergeFieldRanges, applyMergeResults } from '../src/engine/mail-merge-model.js';

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
  it('keeps Backspace or Delete held down as one deletion across a clock second, but not an old deletion', async () => {
    const { pkg, model } = await open(trackedDocx());
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-05-01T10:00:00.900Z'));
      model.select(model.text.indexOf('Second') + 6); model.delete(-1);
      vi.setSystemTime(new Date('2026-05-01T10:00:01.100Z'));
      model.delete(-1);
      expect(summary(model).filter(r => r[1] === 'Me')).toEqual([['del', 'Me', 'nd']]);
      vi.setSystemTime(new Date('2026-05-01T10:00:01.900Z'));
      model.select(model.text.indexOf('Second')); model.delete(1);
      vi.setSystemTime(new Date('2026-05-01T10:00:02.100Z'));
      model.delete(1);
      expect(summary(model).filter(r => r[1] === 'Me')).toEqual([['del', 'Me', 'Se'], ['del', 'Me', 'nd']]);
      // A deletion made minutes later is a change of its own.
      vi.setSystemTime(new Date('2026-05-01T10:05:00.000Z'));
      model.delete(1);
      expect(summary(model).filter(r => r[1] === 'Me')).toEqual([['del', 'Me', 'Se'], ['del', 'Me', 'c'], ['del', 'Me', 'nd']]);
    } finally { vi.useRealTimers(); }
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml.match(/<w:del [^>]*w:author="Me"[^>]*>/g)).toHaveLength(3);
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
    // Rejecting the deletion alone (at the caret) brings Ada's insertion back.
    again.model.select(4); again.model.resolveRevisions(false, ...again.model.range);
    expect(summary(again.model)).toEqual([['ins', 'Ada', 'theirs']]);
  });
  it('rejects another reviewer\'s insertion under a deletion with Reject All, leaving the original text', async () => {
    const files = unzipSync(trackedDocx());
    files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">A </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>theirs</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> B</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    const { pkg, model } = await open(zipSync(files));
    model.select(2, 13); model.replace('');
    expect(summary(model)).toEqual([['del', 'Me', 'theirs B\nNe', '¶']]);
    const again = await open(await save(pkg, model));
    again.model.resolveRevisions(false);
    expect(again.model.text).toBe('A  B\nNext');
    expect(again.model.revisions).toEqual([]);
    // Rejecting a selection rejects both changes in it too; with Ada's changes hidden, only the deletion goes.
    const selected = await open(await save(pkg, model));
    selected.model.resolveRevisions(false, 0, 8);
    expect(summary(selected.model)).toEqual([['del', 'Me', ' B\nNe', '¶']]);
    expect(selected.model.text).toBe('A  B\nNext');
    const shown = await open(await save(pkg, model));
    shown.model.resolveRevisions(false, undefined, undefined, { only: change => change.author !== 'Ada' });
    expect(summary(shown.model)).toEqual([['ins', 'Ada', 'theirs']]);
    expect(shown.model.text).toBe('A theirs B\nNext');
    const undone = await open(await save(pkg, model));
    undone.model.resolveRevisions(false); undone.model.undo();
    expect(summary(undone.model)).toEqual([['del', 'Me', 'theirs B\nNe', '¶']]);
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

describe('a tracked deletion across a field\'s start or end', () => {
  const setup = () => {
    const pkg = createDocx([paragraph('Date: ')]);
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
    doc.select(6); insertBodyField(doc, 'DATE', '2026-10-21'); doc.select(doc.text.length); doc.replace(' end');
    doc.trackChanges = true; doc.revisionAuthor = 'Me';
    return doc;
  };
  const results = doc => bodyFieldRanges(doc.paragraphs).map(r => doc.text.slice(r.start, r.end));
  it.each([['start', 3, 10, 'Dat-10-21 end', '-10-21'], ['end', 12, 19, 'Date: 2026-1d', '2026-1']])('is accepted, leaving the rest of the result (across its %s)', (side, start, end, text, result) => {
    const doc = setup();
    doc.select(start, end); expect(doc.replace('')).toBe(true);
    // Accepting it threw, and so did Accept All for every other change in the document.
    expect(doc.resolveRevisions(true)).toBe(true);
    expect(doc.text).toBe(text);
    expect(results(doc)).toEqual([result]);
    expect(doc.revisions).toEqual([]);
  });
  it('is rejected, leaving the field as it was', () => {
    const doc = setup();
    doc.select(3, 10); doc.replace('');
    expect(doc.resolveRevisions(false)).toBe(true);
    expect(doc.text).toBe('Date: 2026-10-21 end');
    expect(results(doc)).toEqual(['2026-10-21']);
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


describe('Find and Replace with Track Changes on', () => {
  it('does not find text already deleted, so Replace All twice replaces once', () => {
    const show = m => m.paragraphs.map(p => p.runs.map(r => r.revision ? `[${r.revision.type}:${r.text}]` : r.text).join('')).join('|');
    for (const advanced of [false, true]) {
      const m = new TextDocument([paragraph('the cat sat on the cat mat')]);
      m.trackChanges = true; m.revisionAuthor = 'R';
      expect(m.replaceMatches('cat', 'dog', { advanced }, true)).toBe(2);
      expect(m.findMatches('cat', { advanced })).toEqual([]);
      expect(m.replaceMatches('cat', 'dog', { advanced }, true)).toBe(0);
      expect(show(m)).toBe('the [del:cat][ins:dog] sat on the [del:cat][ins:dog] mat');
      m.resolveRevisions(true);
      expect(m.text).toBe('the dog sat on the dog mat');
    }
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

describe('resolving the changes of one paragraph', () => {
  const setup = async () => {
    const { StorySession } = await import('../src/engine/story-session.js');
    const pkg = createDocx([paragraph('Hello world'), paragraph('Hi')]);
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
    const session = new StorySession(model, null);
    model.revisionAuthor = 'Other';
    session.run(m => { m.select(12, 14); m.setRunFormat({ bold: true }); });
    model.revisionAuthor = 'Me';
    session.run(m => { m.select(2); m.setParagraphFormat({ alignment: 'center' }); });
    session.run(m => { m.select(5); m.replace(' big'); });
    return { model, session };
  };
  const others = model => model.revisions.filter(r => r.author === 'Other').map(r => [r.type, model.text.slice(r.start, r.end)]);
  it('leaves another reviewer\'s change in the next paragraph when its paragraph is rejected', async () => {
    const { model, session } = await setup();
    session.run(m => m.resolveRevisions(false, 0, model.text.indexOf('\n') + 1));
    expect(model.text).toBe('Hello world\nHi');
    expect(others(model)).toEqual([['format', 'Hi']]);
    expect(model.paragraphs[1].runs.some(r => r.bold)).toBe(true);
  });
  it('leaves it when Reject is pressed with the caret inside an insertion', async () => {
    const { model, session } = await setup();
    session.run(m => m.resolveRevisions(false, 7, 7));
    expect(model.paragraphs[1].runs.some(r => r.bold)).toBe(true);
    expect(others(model)).toEqual([['format', 'Hi']]);
  });
});

it.each([true, false])('resolves only the changes Show Markup shows (accept=%s), leaving a hidden reviewer\'s', async accept => {
  const { StorySession } = await import('../src/engine/story-session.js');
  const pkg = createDocx([paragraph('Hello world'), paragraph('Second')]);
  const body = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
  const session = new StorySession(body, null);
  body.revisionAuthor = 'Bea';
  session.run(m => { m.select(5); m.replace(' big'); });
  body.revisionAuthor = 'Al';
  session.run(m => { m.select(2); m.setParagraphFormat({ alignment: 'center' }); });
  session.run(m => m.resolveRevisions(accept, undefined, undefined, { only: change => change.author !== 'Bea' }));
  expect(body.revisions.map(r => [r.type, r.author, body.text.slice(r.start, r.end)])).toEqual([['ins', 'Bea', ' big']]);
});

describe('Accept All and Reject All on a long reviewed document', () => {
  const reviewed = count => {
    const revision = type => ({ type, author: 'Ada', date: '2026-01-01T00:00:00Z' });
    const paragraphs = Array.from({ length: count }, (_, i) => {
      const p = paragraph(`Item ${i} reads`);
      p.runs.push({ ...p.runs[0], text: ' old', revision: revision('del') }, { ...p.runs[0], text: ' new', revision: revision('ins') }, { ...p.runs[0], text: ' text.' });
      // A bookmark around the final word moves with the text before it.
      const length = p.runs.reduce((n, r) => n + r.text.length, 0);
      p.bookmarks = [{ id: `b${i}`, name: `Item${i}`, edge: 'start', offset: length - 5 }, { id: `b${i}`, edge: 'end', offset: length - 1 }];
      return p;
    });
    const pkg = createDocx(paragraphs);
    return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  };
  it.each([true, false])('resolves thousands of changes in linear time (accept=%s)', accept => {
    const doc = reviewed(2000);
    const started = performance.now();
    expect(doc.resolveRevisions(accept)).toBe(true);
    // It took over a minute when every change walked or rewrote the document from its start.
    expect(performance.now() - started).toBeLessThan(15000);
    expect(doc.revisions).toEqual([]);
    const kept = accept ? 'new' : 'old';
    expect(doc.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(Array.from({ length: 2000 }, (_, i) => `Item ${i} reads ${kept} text.`));
    expect(doc.bookmarks.map(b => doc.text.slice(b.start, b.end))).toEqual(Array(2000).fill('text'));
  }, 90000);
});

it('replaces thousands of matches with Track Changes on in linear time', () => {
  const pkg = createDocx(Array.from({ length: 2000 }, (_, i) => paragraph(`Clause ${i}: the Company shall notify the Company's agent.`)));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
  doc.revisionAuthor = 'Me';
  const started = performance.now();
  expect(doc.replaceMatches('Company', 'Contractor', { matchCase: true }, true)).toBe(4000);
  // Every match listed and walked the whole document's changes, so this took over a minute.
  expect(performance.now() - started).toBeLessThan(15000);
  expect(doc.revisions).toHaveLength(8000);
  expect(doc.revisions.slice(0, 2).map(r => [r.type, doc.text.slice(r.start, r.end)])).toEqual([['del', 'Company'], ['ins', 'Contractor']]);
  doc.resolveRevisions(true);
  expect(doc.paragraphs[1999].runs.map(r => r.text).join('')).toBe("Clause 1999: the Contractor shall notify the Contractor's agent.");
}, 120000);

describe('fields inside tracked changes', () => {
  const seq = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
  const withField = wrapper => {
    const files = unzipSync(trackedDocx());
    files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">Figure </w:t></w:r>${wrapper(seq)}<w:r><w:t xml:space="preserve"> caption</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    return zipSync(files);
  };
  it('keeps a field result a reviewer inserted marked inserted when the field updates', async () => {
    const { pkg, model } = await open(withField(x => `<w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z">${x}</w:ins>`));
    expect(updateSequenceFields(model)).toBe(1);
    expect(summary(model)).toEqual([['ins', 'Ada', '1']]);
    expect(model.trackChanges).toBe(true);
    const again = await open(await save(pkg, model));
    expect(summary(again.model)).toEqual([['ins', 'Ada', '1']]);
    again.model.resolveRevisions(false);
    expect(again.model.text).toBe('Figure  caption');
  });
  it('keeps a deleted field result deleted when the field updates', async () => {
    const { pkg, model } = await open(withField(x => `<w:del w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z">${x.replace(/<w:t>/g, '<w:delText>').replace(/<\/w:t>/g, '</w:delText>')}</w:del>`));
    expect(summary(model)).toEqual([['del', 'Ada', '7']]);
    updateSequenceFields(model);
    expect(summary(model)).toEqual([['del', 'Ada', '1']]);
    const again = await open(await save(pkg, model));
    again.model.resolveRevisions(true);
    expect(again.model.text).toBe('Figure  caption');
  });
  it('keeps a merge field inserted with Track Changes on marked inserted while previewing recipients', async () => {
    const { model } = await open(trackedDocx());
    model.select(model.text.length); insertMergeField(model, ' MERGEFIELD First ');
    expect(summary(model).at(-1)).toEqual(['ins', 'Me', '«First»']);
    applyMergeResults(model, mergeFieldRanges(model), ['Alexander']);
    expect(summary(model).at(-1)).toEqual(['ins', 'Me', 'Alexander']);
    applyMergeResults(model, mergeFieldRanges(model), ['Bo']);
    expect(summary(model).at(-1)).toEqual(['ins', 'Me', 'Bo']);
    model.resolveRevisions(false);
    expect(model.text).toBe('Keep  removed end.Second');
  });
});

describe('revision UTC times', () => {
  const W16DU = 'http://schemas.microsoft.com/office/word/2023/wordml/word16du';
  const utcDocx = ({ ignorable = true } = {}) => {
    const files = unzipSync(trackedDocx({ track: false }));
    const utc = ' w16du:dateUtc="2026-01-01T08:00:00Z"';
    files['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w16du="${W16DU}"${ignorable ? ' mc:Ignorable="w16du"' : ''}><w:body>`
      + `<w:p><w:pPr><w:rPr><w:ins w:id="9" w:author="Ada" w:date="2026-01-01T00:00:00Z"${utc}/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"${utc}><w:r><w:t>added</w:t></w:r></w:ins><w:del w:id="2" w:author="Grace" w:date="2026-01-02T00:00:00Z"${utc}><w:r><w:delText xml:space="preserve"> removed</w:delText></w:r></w:del><w:r><w:rPr><w:b/><w:rPrChange w:id="6" w:author="Grace" w:date="2026-01-02T00:00:00Z"${utc}><w:rPr/></w:rPrChange></w:rPr><w:t xml:space="preserve"> end.</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t>Second</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    return zipSync(files);
  };
  const utcTimes = bytes => {
    const doc = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
    return [...doc.getElementsByTagNameNS(W16DU, '*'), ...doc.getElementsByTagNameNS(W, '*')].filter(n => n.hasAttributeNS(W16DU, 'dateUtc')).map(n => n.localName).sort();
  };
  it('opens insertions and deletions that carry a UTC time for editing and keeps the time when saved', async () => {
    const source = utcDocx(), { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(summary(model)).toEqual([['ins', 'Ada', 'added'], ['del', 'Grace', ' removed'], ['format', 'Grace', ' end.'], ['ins', 'Ada', '\n', '¶']]);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    // Editing the paragraph rewrites it; each recorded revision keeps its UTC time, new ones have none.
    model.trackChanges = true; model.select(0); model.replace('New ');
    const saved = await save(pkg, model);
    expect(utcTimes(saved)).toEqual(['del', 'ins', 'ins', 'rPrChange']);
    const reopened = await open(saved);
    expect(reopened.pkg.readOnly).toBeFalsy();
    expect(reopened.model.revisions.find(r => r.type === 'ins' && reopened.model.text.slice(r.start, r.end) === 'added')).toBeTruthy();
  });
  it('leaves out the UTC time when the part does not declare it ignorable', async () => {
    const { pkg, model } = await open(utcDocx({ ignorable: false }));
    expect(pkg.readOnly).toBeFalsy();
    model.select(0); model.replace('New ');
    expect(utcTimes(await save(pkg, model))).toEqual([]);
  });
});
