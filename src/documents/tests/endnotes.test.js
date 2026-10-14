import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { footnoteOpeningRuns, noteNumbers, convertedNoteParagraphs } from '../src/engine/footnotes.js';
import { readNoteSettings } from '../src/engine/docx-notes.js';
import { formatPageNumber } from '../src/engine/page-numbering.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { referenceTargets, insertCrossReference } from '../src/engine/captions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const layout = (definition, d) => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, definition, { styles: d.styles });

async function withNotes(kinds, text = 'One. Two. Three.') {
  const blank = createDocx([paragraph(text)], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = model(pkg), edits = {};
  const definition = { sections: [{ header: {}, footer: {}, firstPageDifferent: false }], stories: {}, evenAndOdd: false };
  let position = 0;
  kinds.forEach((kind, i) => {
    const note = kind === 'footnote' ? pkg.addFootnote() : pkg.addEndnote();
    position = d.text.indexOf('.', position) + 1;
    d.select(position); d.insertFootnoteReference(note.id, kind);
    position++;
    const story = new TextDocument([paragraph()], d.pageSettings, d.numbering, d.styles, [], d.assets);
    story.paragraphs[0].runs = footnoteOpeningRuns(story.typingRun(0), null, kind);
    story.select(2); story.replace(`${kind} body ${i + 1}`);
    edits[note.path] = { paragraphs: story.paragraphs, tables: [] };
    definition[`${kind}s`] = note.settings;
    definition.stories[note.path] = { kind, noteId: note.id, paragraphs: story.paragraphs, tables: [], editable: true };
  });
  return { pkg, d, edits, definition };
}
const save = async (pkg, d, edits) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, edits).arrayBuffer());

describe('endnotes', () => {
  it('creates the endnotes part, writes references and reopens editable stories', async () => {
    const { pkg, d, edits } = await withNotes(['endnote', 'footnote', 'endnote']);
    const parts = unzipSync(await save(pkg, d, edits));
    const document = strFromU8(parts['word/document.xml']);
    expect(document.match(/<w:endnoteReference w:id="\d+"\/>/g)).toHaveLength(2);
    expect(document.match(/<w:footnoteReference w:id="\d+"\/>/g)).toHaveLength(1);
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toMatch(/relationships\/endnotes" Target="endnotes.xml"/);
    expect(strFromU8(parts['[Content_Types].xml'])).toContain('wordprocessingml.endnotes+xml');
    const endnotes = strFromU8(parts['word/endnotes.xml']);
    expect(endnotes).toMatch(/<w:endnote w:type="separator" w:id="-1">/);
    expect(endnotes).toMatch(/<w:endnoteRef\/><\/w:r><w:r><w:t xml:space="preserve"> endnote body 1<\/w:t>/);
    const again = await DocxPackage.open(await save(pkg, d, edits));
    expect(again.readOnly).toBeFalsy();
    const stories = Object.values(again.pageStories.stories);
    expect(stories.map(s => [s.kind, s.editable])).toEqual([['footnote', true], ['endnote', true], ['endnote', true]]);
    expect(again.pageStories.endnotes).toMatchObject({ format: 'lowerRoman', start: 1, restart: 'continuous', position: 'docEnd' });
  });

  it('numbers endnotes in lower Roman and lays them out after the last line, continuing on new pages', async () => {
    const { pkg, d, edits } = await withNotes(['endnote', 'endnote']);
    const again = await DocxPackage.open(await save(pkg, d, edits)), body = model(again);
    const placed = layout(again.pageStories, body);
    expect(placed.endnoteAreas[0].notes.map(n => n.display)).toEqual(['i', 'ii']);
    const last = Math.max(...placed.lines.filter(l => !l.pageStory && l.page === 0).map(l => l.y + l.height));
    expect(placed.endnoteAreas[0].top).toBeGreaterThan(last);
    expect(placed.pageCount).toBe(1);
    const stories = layoutPageStories(placed, again.pageStories, [{ header: 720, footer: 720 }], measure, body.numbering, { styles: body.styles });
    expect(stories.lines.filter(l => l.pageStory?.startsWith('word/endnotes.xml')).length).toBe(2);
    // A body that fills the page pushes the notes to an added page.
    body.select(0); body.replace(Array.from({ length: 44 }, (_, i) => `Filler ${i}`).join('\n') + '\n');
    const full = layout(again.pageStories, body);
    expect(full.endnoteAreas.at(-1).page).toBe(full.pageCount - 1);
    expect(full.pageCount).toBeGreaterThan(Math.max(...full.lines.filter(l => !l.pageStory).map(l => l.page)));
  });

  it('honours note settings and writes them to settings.xml', async () => {
    const { pkg, d, edits } = await withNotes(['footnote', 'footnote', 'endnote']);
    pkg.setNoteSettings('footnote', { format: 'chicago', start: 2, restart: 'eachSect', position: 'beneathText' });
    pkg.setNoteSettings('endnote', { format: 'upperLetter', position: 'sectEnd' });
    const parts = unzipSync(await save(pkg, d, edits));
    const settings = strFromU8(parts['word/settings.xml']);
    expect(settings).toMatch(/<w:footnotePr><w:pos w:val="beneathText"\/><w:numFmt w:val="chicago"\/><w:numStart w:val="2"\/><w:numRestart w:val="eachSect"\/><w:footnote w:id="-1"\/><w:footnote w:id="0"\/><\/w:footnotePr><w:endnotePr><w:pos w:val="sectEnd"\/><w:numFmt w:val="upperLetter"\/>/);
    const again = await DocxPackage.open(parts['word/document.xml'] ? await save(pkg, d, edits) : null);
    expect(again.pageStories.footnotes).toMatchObject({ format: 'chicago', start: 2, restart: 'eachSect', position: 'beneathText' });
    const placed = layout(again.pageStories, model(again));
    expect(placed.footnoteAreas[0].notes.map(n => n.display)).toEqual(['†', '‡']);
    expect(placed.endnoteAreas[0].notes.map(n => n.display)).toEqual(['A']);
    // Beneath text: the notes follow the last body line instead of the page bottom.
    const last = Math.max(...placed.lines.filter(l => !l.pageStory && l.page === 0).map(l => l.y + l.height));
    expect(placed.footnoteAreas[0].top).toBeLessThan(last + 2);
  });

  it('restarts numbering per section and per page', () => {
    const paragraphs = [
      { id: 'a', runs: [{ text: '￼', noteMark: { kind: 'footnoteReference', id: '1' } }], sectionEnd: {} },
      { id: 'b', runs: [{ text: '￼', noteMark: { kind: 'footnoteReference', id: '2' } }, { text: '￼', noteMark: { kind: 'footnoteReference', id: '3', custom: true } }, { text: '￼', noteMark: { kind: 'footnoteReference', id: '4' } }] },
    ];
    expect([...noteNumbers(paragraphs, { format: 'decimal', start: 1, restart: 'eachSect' }).values()]).toEqual(['1', '1', '', '2']);
    expect([...noteNumbers(paragraphs, { format: 'decimal', start: 1, restart: 'eachPage' }, 'footnote', new Map([['1', 0], ['2', 0], ['4', 1]])).values()]).toEqual(['1', '2', '', '1']);
    expect(readNoteSettings(null, 'endnote')).toEqual({ format: 'lowerRoman', start: 1, restart: 'continuous', position: 'docEnd' });
    expect(formatPageNumber(5, 'chicago')).toBe('**');
  });

  it('round-trips custom note marks', async () => {
    const blank = createDocx([paragraph('Claim')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer())), d = model(pkg);
    const note = pkg.addFootnote();
    d.select(5); d.insertFootnoteReference(note.id, 'footnote', { custom: true }); d.replace('*');
    const story = new TextDocument([paragraph('* Custom note.')], d.pageSettings, d.numbering, d.styles, [], d.assets);
    const bytes = await save(pkg, d, { [note.path]: { paragraphs: story.paragraphs, tables: [] } });
    const xmlText = strFromU8(unzipSync(bytes)["word/document.xml"]); expect(xmlText.slice(xmlText.indexOf("<w:footnoteReference"), xmlText.indexOf("<w:footnoteReference") + 4000)).toMatch(/<w:footnoteReference w:customMarkFollows="1" w:id="1"\/><\/w:r><w:r>(?:(?!<\/w:r>).)*<w:t[^>]*>\*<\/w:t>/);
    const again = model(await DocxPackage.open(bytes));
    expect(again.paragraphs[0].runs.find(r => r.noteMark).noteMark.custom).toBe(true);
    expect(again.text).toBe('Claim￼*');
  });

  it('converts note story marks and refers to a note number with NOTEREF', async () => {
    const converted = convertedNoteParagraphs([{ id: 'p', runs: [{ text: '￼', noteMark: { kind: 'footnoteRef', text: '￼', display: '' } }, { text: ' Body' }] }], 'endnote');
    expect(converted[0].runs[0].noteMark.kind).toBe('endnoteRef');
    const { d } = await withNotes(['footnote', 'footnote']);
    d.select(d.text.length); d.replace(' See note ');
    const target = referenceTargets(d, { notes: [{ kind: 'footnote', id: '2', display: '2', text: 'second' }] }).footnotes[1];
    insertCrossReference(d, target, { show: 'number' });
    expect(d.text.endsWith('See note 2')).toBe(true);
    // Numbers follow reference order: after renumbering the NOTEREF follows.
    updateSequenceFields(d, { notes: { footnote: new Map([['1', '5'], ['2', '6']]), endnote: new Map() } });
    expect(d.text.endsWith('See note 6')).toBe(true);
  });
});
