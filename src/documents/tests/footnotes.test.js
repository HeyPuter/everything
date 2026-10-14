import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { footnoteNumbers, footnoteOpeningRuns } from '../src/engine/footnotes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });

/** Independently written: two references to two notes, the separator notes and an unreferenced note. */
function notedDocx() {
  const note = (id, text) => `<w:footnote w:id="${id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style></w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>First claim</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r><w:r><w:t xml:space="preserve"> and second</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r><w:r><w:t>.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${note(1, 'Second source.')}${note(2, 'First source.')}${note(7, 'Unreferenced.')}</w:footnotes>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const layout = (pkg, d, stories = pkg.pageStories) => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, stories, { styles: d.styles });

function noteSettings(bytes, properties) {
  const parts = unzipSync(bytes);
  parts['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}"><w:footnotePr>${properties}</w:footnotePr></w:settings>`);
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
  return zipSync(parts);
}

describe('footnotes', () => {
  it.each([
    ['decimal', ['3', '4']], ['decimalZero', ['03', '04']],
    ['lowerRoman', ['iii', 'iv']], ['upperRoman', ['III', 'IV']],
    ['lowerLetter', ['c', 'd']], ['upperLetter', ['C', 'D']], ['chicago', ['‡', '§']],
  ])('keeps supported %s numbering editable and unchanged on export', async (format, expected) => {
    const source = noteSettings(notedDocx(), `<w:numFmt w:val="${format}"/><w:numStart w:val="3"/>`);
    const { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(layout(pkg, model).footnoteAreas[0].notes.map(n => n.display)).toEqual(expected);
    const saved = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
    expect(unzipSync(saved)).toEqual(unzipSync(source));
  });

  it.each(['ordinal'])('opens unsupported %s footnote numbering as a structured preview', async format => {
    const source = noteSettings(notedDocx(), `<w:numFmt w:val="${format}"/><w:numStart w:val="3"/>`);
    const preview = await DocxPackage.open(source, { bestEffort: true });
    await expect(DocxPackage.open(source)).rejects.toThrow(/footnote numbering format/);
    expect(preview.readOnly).toBe(true);
    expect(preview.previewIssues.join(' ')).toContain(`footnote numbering format ${format}; note numbers displayed as decimal`);
    expect(Object.values(preview.pageStories.stories).filter(s => s.kind === 'footnote')).toHaveLength(2);
    expect(preview.pageStories.footnotes).toMatchObject({ format: 'decimal', start: 3 });
    const model = new TextDocument(preview.paragraphs, preview.pageSettings, preview.numbering, preview.styles, preview.tables, preview.assets);
    expect(model.text).toBe('First claim￼ and second￼.');
    expect(layout(preview, model).footnoteAreas[0].notes.map(n => n.display)).toEqual(['3', '4']);
    expect(preview.parts).toEqual(unzipSync(source));
    expect(() => preview.export(model.paragraphs)).toThrow(/read-only/);
  });

  it.each([['eachPage', ['3', '4']], ['eachSect', ['3', '4']]])('opens %s numbering for editing, restarting from numStart', async (restart, expected) => {
    const parts = unzipSync(notedDocx());
    parts['word/settings.xml'] = strToU8(`<w:settings xmlns:w="${W}"><w:footnotePr><w:numStart w:val="3"/><w:numRestart w:val="${restart}"/></w:footnotePr></w:settings>`);
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="settings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
    parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
    const bytes = zipSync(parts);
    const { pkg, model } = await open(bytes);
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.pageStories.footnotes).toMatchObject({ restart, start: 3 });
    expect(Object.values(pkg.pageStories.stories).filter(s => s.kind === 'footnote').map(s => [s.noteId, s.editable])).toEqual([['1', true], ['2', true]]);
    expect(layout(pkg, model).footnoteAreas[0].notes.map(n => n.display)).toEqual(expected);
    const saved = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
    expect(unzipSync(saved)).toEqual(parts);
  });

  it('opens referenced notes for editing and numbers them in reference order', async () => {
    const { pkg, model } = await open(notedDocx());
    expect(pkg.readOnly).toBeFalsy();
    expect(model.text).toBe('First claim￼ and second￼.');
    expect([...footnoteNumbers(model.paragraphs).entries()]).toEqual([['2', '1'], ['1', '2']]);
    const stories = Object.entries(pkg.pageStories.stories).filter(([, s]) => s.kind === 'footnote');
    expect(stories.map(([path, s]) => [path, s.editable])).toEqual([['word/footnotes.xml#1', true], ['word/footnotes.xml#2', true]]);
  });

  it('reserves the footnote area on the referencing page and paints numbered notes', async () => {
    const { pkg, model } = await open(notedDocx());
    const body = layout(pkg, model);
    expect(body.footnoteAreas).toHaveLength(1);
    expect(body.footnoteAreas[0].notes.map(n => [n.id, n.display])).toEqual([['2', '1'], ['1', '2']]);
    const stories = layoutPageStories(body, pkg.pageStories, [model.pageSettings], measure, model.numbering, { styles: model.styles });
    const noteLines = stories.lines.filter(l => l.pageStory?.startsWith('word/footnotes.xml#'));
    expect(noteLines.map(l => l.pageStory)).toEqual(['word/footnotes.xml#2', 'word/footnotes.xml#1']);
    expect(noteLines[0].y).toBeGreaterThan(body.footnoteAreas[0].top);
    expect(body.columnSeparators.some(s => s.footnote)).toBe(true);
  });

  it('pushes body text off a page to make room for its notes', async () => {
    const { pkg, model } = await open(notedDocx());
    model.select(model.text.length); model.replace('\n' + Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n'));
    const withNotes = layout(pkg, model), without = layout(pkg, model, { ...pkg.pageStories, footnotes: undefined });
    const lastOnFirst = l => Math.max(...l.lines.filter(x => x.page === 0).map(x => x.end));
    expect(lastOnFirst(withNotes)).toBeLessThan(lastOnFirst(without));
  });

  it('saves untouched notes byte for byte, edits a note and prunes deleted references', async () => {
    const source = notedDocx(), { pkg, model } = await open(source);
    const save = async (edits) => new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, edits).arrayBuffer());
    expect(unzipSync(await save())).toEqual(unzipSync(source));
    const story = pkg.pageStories.stories['word/footnotes.xml#1'];
    const note = new TextDocument(story.paragraphs, model.pageSettings, model.numbering, model.styles, [], model.assets);
    note.select(note.text.length); note.replace(' Edited');
    model.select(model.text.indexOf('￼'), model.text.indexOf('￼') + 1); model.replace('');
    const bytes = await save({ 'word/footnotes.xml#1': { paragraphs: note.paragraphs, tables: [] } });
    const xml = strFromU8(unzipSync(bytes)['word/footnotes.xml']);
    expect(xml).toMatch(/Second source\..*Edited/);
    expect(xml).not.toMatch(/First source|Unreferenced/);
    expect(xml).toMatch(/w:type="separator"/);
    const again = await open(bytes);
    expect(again.model.text).toBe('First claim and second￼.');
    expect(again.pkg.pageStories.stories['word/footnotes.xml#1'].paragraphs[0].runs.map(r => r.noteMark ? '#' : r.text).join('')).toBe('# Second source. Edited');
  });

  it('inserts a new footnote into a document without a notes part', async () => {
    const blank = createDocx([paragraph('Claim')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const { id, path } = pkg.addFootnote();
    model.select(5); model.insertFootnoteReference(id);
    const note = new TextDocument([paragraph()], model.pageSettings, model.numbering, model.styles, [], model.assets);
    note.paragraphs[0].runs = footnoteOpeningRuns(note.typingRun(0));
    note.select(2); note.replace('A new note.');
    const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, { [path]: { paragraphs: note.paragraphs, tables: [] } }).arrayBuffer());
    const parts = unzipSync(bytes);
    expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:vertAlign w:val="superscript"\/>.*<w:footnoteReference w:id="1"\/>/);
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toMatch(/relationships\/footnotes" Target="footnotes.xml"/);
    expect(strFromU8(parts['word/footnotes.xml'])).toMatch(/<w:r><w:rPr><w:vertAlign w:val="superscript"\/><\/w:rPr><w:footnoteRef\/><\/w:r><w:r><w:t xml:space="preserve"> A new note.<\/w:t><\/w:r>/);
    const again = await open(bytes);
    expect(again.model.text).toBe('Claim￼');
    expect(again.pkg.pageStories.stories['word/footnotes.xml#1'].paragraphs[0].runs.map(r => r.noteMark ? '#' : r.text).join('')).toBe('# A new note.');
  });

  it('keeps notes clear of body text when a reference sits near the foot of a page', async () => {
    for (const n of [36, 37]) {
      const { pkg, model } = await open(notedDocx());
      model.select(0); model.replace(Array.from({ length: n }, (_, i) => `Line ${i}`).join('\n') + '\n');
      model.select(model.text.length); model.replace('\n' + Array.from({ length: 60 }, (_, i) => `Tail ${i}`).join('\n'));
      const body = layout(pkg, model);
      for (const area of body.footnoteAreas) {
        const overlap = body.lines.filter(l => l.page === area.page && !l.pageStory && !l.virtual && l.y + l.height > area.top + 0.5);
        expect(overlap).toEqual([]);
        // Each note sits on the page of its reference.
        const pid = model.paragraphs.find(p => p.runs.some(r => r.noteMark?.kind === 'footnoteReference')).id;
        expect(body.lines.some(l => l.paragraphId === pid && l.page === area.page)).toBe(true);
      }
    }
  }, 120000);

  it('drops a new note whose reference was undone', async () => {
    const { pkg, model } = await open(notedDocx());
    const { id, path } = pkg.addFootnote();
    model.select(5); model.insertFootnoteReference(id);
    const note = new TextDocument([paragraph()], model.pageSettings, model.numbering, model.styles, [], model.assets);
    note.paragraphs[0].runs = footnoteOpeningRuns(note.typingRun(0));
    model.undo();
    const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets, { [path]: { paragraphs: note.paragraphs, tables: [] } }).arrayBuffer());
    expect(strFromU8(unzipSync(bytes)['word/footnotes.xml'])).not.toMatch(new RegExp(`w:id="${id}"`));
  });
});
