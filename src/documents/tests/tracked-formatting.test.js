import { beforeAll, afterAll, it, expect, describe, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { revisionView, revisionDisplay, runRevisionDisplay, describeFormatChange, MOVE_COLOR } from '../src/engine/revisions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const defaults = structuredClone(revisionView.options);
beforeEach(() => { revisionView.options = structuredClone(defaults); revisionView.mode = 'all'; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageFiles = body => ({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
});
const zip = files => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true }); model.revisionAuthor = 'Me'; return { pkg, model, session: new StorySession(model, null) }; };
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments, d.trackChanges).arrayBuffer());
const documentXml = async (pkg, d) => strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
const fresh = () => {
  const pkg = createDocx([paragraph('Alpha beta gamma'), paragraph('Second paragraph')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { trackChanges: true });
  model.revisionAuthor = 'Me';
  return { pkg, model, session: new StorySession(model, null) };
};

describe('tracked formatting', () => {
  it('records a run formatting change, saves it as rPrChange and rejects it', async () => {
    const { pkg, model, session } = fresh();
    session.run(m => { m.select(6, 10); m.setRunFormat({ bold: true }); });
    const ranges = model.revisions;
    expect(ranges.map(r => [r.type, r.author, model.text.slice(r.start, r.end)])).toEqual([['format', 'Me', 'beta']]);
    const run = model.paragraphs[0].runs.find(r => r.text === 'beta');
    expect(describeFormatChange(run)).toEqual(['Bold']);
    const xml = await documentXml(pkg, model);
    expect(xml).toMatch(/<w:r><w:rPr><w:b w:val="1"\/><w:rPrChange w:id="\d+" w:author="Me" w:date="[^"]+"><w:rPr\/><\/w:rPrChange><\/w:rPr><w:t xml:space="preserve">beta<\/w:t><\/w:r>/);
    const again = await open(await save(pkg, model));
    expect(again.model.revisions.map(r => [r.type, again.model.text.slice(r.start, r.end)])).toEqual([['format', 'beta']]);
    again.session.run(m => m.resolveRevisions(false));
    expect(again.model.revisions).toEqual([]);
    expect(again.model.paragraphs[0].runs.every(r => !r.bold)).toBe(true);
    const restored = await documentXml(again.pkg, again.model);
    expect(restored).not.toMatch(/rPrChange|<w:b /);
  });

  it('records paragraph formatting as pPrChange and restores it on reject', async () => {
    const { pkg, model, session } = fresh();
    session.run(m => { m.select(20); m.setParagraphFormat({ alignment: 'center' }); });
    expect(model.revisions.map(r => [r.type, model.text.slice(r.start, Math.min(r.end, model.text.length))])).toEqual([['format', 'Second paragraph']]);
    const xml = await documentXml(pkg, model);
    expect(xml).toMatch(/<w:pPr><w:jc w:val="center"\/><w:pPrChange w:id="\d+" w:author="Me" w:date="[^"]+"><w:pPr\/><\/w:pPrChange><\/w:pPr><w:r><w:t xml:space="preserve">Second paragraph/);
    const again = await open(await save(pkg, model));
    expect(again.model.paragraphs[1].format.alignment).toBe('center');
    again.session.run(m => m.resolveRevisions(false));
    expect(again.model.paragraphs[1].format.alignment).toBe('left');
    expect(again.model.revisions).toEqual([]);
    expect(await documentXml(again.pkg, again.model)).not.toMatch(/pPrChange|w:jc/);
  });

  it('keeps the original formatting through several changes and drops a change undone by hand', () => {
    const { model, session } = fresh();
    session.run(m => { m.select(0, 5); m.setRunFormat({ italic: true }); });
    session.run(m => { m.select(0, 5); m.setRunFormat({ bold: true }); });
    expect(model.revisions).toHaveLength(1);
    expect(describeFormatChange(model.paragraphs[0].runs[0]).sort()).toEqual(['Bold', 'Italic']);
    session.run(m => { m.select(0, 5); m.setRunFormat({ bold: false, italic: false }); });
    expect(model.revisions).toEqual([]);
  });

  it('does not track formatting when Track Changes is off or formatting tracking is off', () => {
    const { model, session } = fresh();
    model.trackChanges = false;
    session.run(m => { m.select(0, 5); m.setRunFormat({ bold: true }); });
    expect(model.revisions).toEqual([]);
    model.trackChanges = true; model.trackFormatting = false;
    session.run(m => { m.select(6, 10); m.setRunFormat({ bold: true }); });
    expect(model.revisions).toEqual([]);
  });

  it('accepting keeps the new formatting and drops the record', async () => {
    const { pkg, model, session } = fresh();
    session.run(m => { m.select(6, 10); m.setRunFormat({ underline: true }); });
    session.run(m => m.resolveRevisions(true));
    expect(model.revisions).toEqual([]);
    const xml = await documentXml(pkg, model);
    expect(xml).toMatch(/<w:u w:val="single"/);
    expect(xml).not.toMatch(/rPrChange/);
  });

  it('does not record restyling caused by table structure edits', async () => {
    const { model, session } = await open(readFileSync('tests/fixtures/review/original.docx'));
    session.run(m => { m.select(m.text.indexOf('North') + 1); m.insertTableRow(); });
    expect(model.revisions.filter(r => r.type === 'format')).toEqual([]);
  });

  it('shows formatting marks only when chosen', () => {
    const run = { text: 'x', formatRevision: { type: 'format', author: 'Ada', previous: {} } };
    expect(runRevisionDisplay(run)).toBeNull();
    revisionView.options.formatMark = 'bold';
    expect(runRevisionDisplay(run)).toMatchObject({ bold: true });
    revisionView.options.hiddenAuthors = ['Ada'];
    expect(runRevisionDisplay(run)).toBeNull();
  });
});

describe('tracked moves', () => {
  it('records cut and paste as a move and saves moveFrom/moveTo with ranges', async () => {
    const { pkg, model, session } = fresh();
    session.run(m => { m.select(6, 11); m.replace(''); });
    session.run(m => { m.select(m.text.length); m.replace('beta '); });
    const moves = model.revisions.filter(r => r.move);
    expect(moves.map(r => [r.type, model.text.slice(r.start, r.end)])).toEqual([['del', 'beta '], ['ins', 'beta ']]);
    expect(moves[0].moveName).toBe(moves[1].moveName);
    const xml = await documentXml(pkg, model);
    expect(xml).toMatch(/<w:moveFromRangeStart w:id="(\d+)" w:name="move[^"]+" w:author="Me"[^>]*\/><w:moveFrom [^>]*><w:r><w:delText xml:space="preserve">beta <\/w:delText><\/w:r><\/w:moveFrom><w:moveFromRangeEnd w:id="\1"\/>/);
    expect(xml).toMatch(/<w:moveToRangeStart w:id="(\d+)" w:name="move[^"]+"[^>]*\/><w:moveTo [^>]*><w:r><w:t xml:space="preserve">beta <\/w:t><\/w:r><\/w:moveTo><w:moveToRangeEnd w:id="\1"\/>/);
    const again = await open(await save(pkg, model));
    const reopened = again.model.revisions.filter(r => r.move);
    expect(reopened).toHaveLength(2);
    expect(reopened[0].moveName).toBe(reopened[1].moveName);
    again.model.resolveRevisions(true);
    expect(again.model.text).toBe('Alpha gamma\nSecond paragraphbeta ');
  });

  it('does not call ordinary typing a move', () => {
    const { model, session } = fresh();
    session.run(m => { m.select(0, 5); m.replace(''); });
    session.run(m => { m.select(m.text.length); m.replace('Omega'); });
    expect(model.revisions.some(r => r.move)).toBe(false);
  });

  it('opens moves with their names and keeps an untouched file byte for byte', async () => {
    const source = zip(packageFiles(
      `<w:p><w:moveFromRangeStart w:id="1" w:name="move1" w:author="Ada" w:date="2026-01-01T00:00:00Z"/><w:moveFrom w:id="2" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">Moved </w:delText></w:r></w:moveFrom><w:moveFromRangeEnd w:id="1"/><w:r><w:t>Stay</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t xml:space="preserve">End </w:t></w:r><w:moveToRangeStart w:id="3" w:name="move1" w:author="Ada" w:date="2026-01-01T00:00:00Z"/><w:moveTo w:id="4" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">Moved </w:t></w:r></w:moveTo><w:moveToRangeEnd w:id="3"/></w:p>`));
    const { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(model.revisions.map(r => [r.type, r.move, r.moveName, model.text.slice(r.start, r.end)])).toEqual([['del', true, 'move1', 'Moved '], ['ins', true, 'move1', 'Moved ']]);
    model.trackChanges = false;
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    model.select(model.text.length); model.replace('!');
    const xml = await documentXml(pkg, model);
    expect(xml).toMatch(/<w:moveToRangeStart w:id="\d+" w:name="move1"/);
    expect(xml).toMatch(/<w:moveFromRangeStart [^>]*w:name="move1"/);
  });

  it('displays moves in their own color and balloons hide deletions', () => {
    expect(revisionDisplay({ type: 'del', move: true, author: 'Ada' }, 'all', 'B5082E')).toMatchObject({ color: MOVE_COLOR, strikethrough: 'double' });
    expect(revisionDisplay({ type: 'ins', move: true, author: 'Ada' }, 'all', 'B5082E')).toMatchObject({ color: MOVE_COLOR, underlineStyle: 'double' });
    revisionView.options.balloons = 'balloons';
    expect(revisionDisplay({ type: 'del', author: 'Ada' }, 'all', 'B5082E')).toEqual({ hidden: true });
    revisionView.options.balloons = 'inline';
    revisionView.options.deleteMark = 'doubleStrikethrough'; revisionView.options.deleteColor = '0000FF';
    expect(revisionDisplay({ type: 'del', author: 'Ada' }, 'all', 'B5082E')).toEqual({ color: '0000FF', strikethrough: 'double' });
    revisionView.options.showInsDel = false;
    expect(revisionDisplay({ type: 'ins', author: 'Ada' }, 'all', 'B5082E')).toEqual({});
  });
});
