import { describe, it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { emptyStyles } from '../src/engine/styles.js';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';

const headingStyles = () => {
  const styles = emptyStyles();
  styles.definitions.Heading1 = { id: 'Heading1', type: 'paragraph', name: 'heading 1', basedOn: null, next: null, properties: {}, reference: {}, run: { bold: true } };
  return styles;
};
const shape = doc => doc.paragraphs.map(p => [p.styleId || null, p.runs.map(r => r.text).join(''), p.format?.alignment ?? 'left']);

describe('removing an empty paragraph', () => {
  const heading = () => new TextDocument([
    paragraph('Intro'), paragraph(''), paragraph('Title', { styleId: 'Heading1', format: { alignment: 'center' } }), paragraph('Body'),
  ], undefined, undefined, headingStyles());
  it('keeps the following heading when Backspace deletes the empty line above it', () => {
    const doc = heading(), before = shape(doc);
    doc.select(7); expect(doc.delete(-1)).toBe(true);
    expect(shape(doc)).toEqual([[null, 'Intro', 'left'], ['Heading1', 'Title', 'center'], [null, 'Body', 'left']]);
    expect(doc.paragraphs[1].runs[0].bold).toBe(true);
    expect(doc.selection).toEqual({ anchor: 6, focus: 6 });
    doc.undo(); expect(shape(doc)).toEqual(before); expect(doc.selection).toEqual({ anchor: 7, focus: 7 });
  });
  it('keeps the following heading when Delete is pressed in the empty line', () => {
    const doc = heading();
    doc.select(6); expect(doc.delete(1)).toBe(true);
    expect(shape(doc)[1]).toEqual(['Heading1', 'Title', 'center']);
  });
  it('moves a bookmark from the removed paragraph onto the surviving one', () => {
    const doc = heading();
    doc.select(6); doc.addBookmark('Empty');
    doc.select(7); doc.delete(-1);
    expect(doc.bookmarks.map(b => [b.name, b.startParagraph === doc.paragraphs[1].id])).toEqual([['Empty', true]]);
  });
  it('keeps the first paragraph\'s identity on the survivor, so removing paragraphs by id stays exact', () => {
    const doc = new TextDocument([paragraph('Intro'), paragraph(''), paragraph(''), paragraph(''), paragraph('End')]);
    const ids = new Set(doc.paragraphs.slice(2, 4).map(p => p.id));
    // Remove each listed paragraph by deleting the mark before it, last first.
    for (let i = doc.paragraphs.length - 1; i >= 0; i--) {
      if (!ids.has(doc.paragraphs[i].id)) continue;
      const at = doc.paragraphOffset(i); doc.select(at - 1, at); doc.delete(-1);
    }
    expect(doc.text).toBe('Intro\n\nEnd');
  });
  it('still keeps the first paragraph when it has text', () => {
    const doc = new TextDocument([paragraph('Intro'), paragraph('Title', { styleId: 'Heading1' })], undefined, undefined, headingStyles());
    doc.select(6); doc.delete(-1);
    expect(shape(doc)).toEqual([[null, 'IntroTitle', 'left']]);
  });
  it('saves and reopens the surviving heading with its style and source properties', async () => {
    const dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const heading = '<w:p w:rsidR="00A1B2C3"><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:proofErr w:type="spellStart"/><w:r><w:t>Titel</w:t></w:r><w:proofErr w:type="spellEnd"/></w:p>';
    const files = {
      '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style></w:styles>`,
      'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p><w:p/>${heading}<w:sectPr/></w:body></w:document>`,
    };
    try {
      const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
      const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
      doc.select(7); doc.delete(-1);
      expect(doc.text).toBe('Intro\nTitel');
      const xml = strFromU8(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()))['word/document.xml']);
      expect(xml).toMatch(/<w:body><w:p><w:r><w:t>Intro<\/w:t><\/w:r><\/w:p><w:p w:rsidR="00A1B2C3"><w:pPr><w:pStyle w:val="Heading1"\/><w:jc w:val="center"\/><\/w:pPr>(?:<w:proofErr[^>]*\/>)?<w:r><w:t[^>]*>Titel<\/w:t><\/w:r>/);
      const reopened = await DocxPackage.open(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
      expect(reopened.paragraphs.map(p => p.styleId || null)).toEqual([null, 'Heading1']);
    } finally { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; }
  });
});

describe('a comment made at a caret', () => {
  const range = (text, caret) => {
    const doc = new TextDocument([paragraph(text)], undefined, undefined, undefined, [], {}, { comments: [] });
    doc.select(caret);
    const [start, end] = doc.commentRange();
    return doc.text.slice(start, end);
  };
  it('anchors the whole word, including combining marks and astral letters', () => {
    expect(range('cafe\u0301 au lait', 1)).toBe('cafe\u0301');
    expect(range('नमस्ते दुनिया', 1)).toBe('नमस्ते');
    expect(range('𝐀𝐁𝐂 x', 2)).toBe('𝐀𝐁𝐂');
    expect(range("don't stop", 2)).toBe("don't");
  });
  it('anchors comment markers on grapheme boundaries', () => {
    const doc = new TextDocument([paragraph('cafe\u0301 au')], undefined, undefined, undefined, [], {}, { comments: [] });
    doc.select(2); const id = doc.addComment({ text: 'Accent' });
    expect(doc.commentList.find(c => c.id === id)).toMatchObject({ start: 0, end: 5 });
  });
});

describe('Replace with Track Changes on', () => {
  const tracked = text => {
    const doc = new TextDocument([paragraph(text)], undefined, undefined, undefined, [], {}, { trackChanges: true });
    doc.revisionAuthor = 'Me'; return doc;
  };
  const marks = doc => doc.revisions.map(r => [r.type, r.author, doc.text.slice(r.start, r.end)]);
  it('records Replace All as tracked deletions and insertions', () => {
    const doc = tracked('one cat, two cat');
    expect(doc.replaceMatches('cat', 'dog', {}, true)).toBe(2);
    expect(marks(doc)).toEqual([['del', 'Me', 'cat'], ['ins', 'Me', 'dog'], ['del', 'Me', 'cat'], ['ins', 'Me', 'dog']]);
    expect(doc.selection).toEqual({ anchor: 10, focus: 10 });
    expect(doc.history).toHaveLength(1);
    doc.undo(); expect(doc.text).toBe('one cat, two cat'); expect(doc.revisions).toEqual([]);
    doc.redo(); doc.resolveRevisions(false); expect(doc.text).toBe('one cat, two cat');
    doc.undo(); doc.resolveRevisions(true); expect(doc.text).toBe('one dog, two dog');
  });
  it('records a single Replace as a tracked change', () => {
    const doc = tracked('one cat, two cat');
    doc.select(4, 7);
    expect(doc.replaceMatches('cat', 'dog', {}, false)).toBe(1);
    expect(marks(doc)).toEqual([['del', 'Me', 'cat'], ['ins', 'Me', 'dog']]);
  });
  it('changes nothing, including history, when every match is already deleted text', () => {
    const doc = tracked('one cat, two cat');
    doc.select(4, 7); doc.replace(''); doc.select(13, 16); doc.replace('');
    doc.select(0); const before = JSON.stringify(doc.paragraphs), history = doc.history.length;
    expect(doc.replaceMatches('cat', '', {}, true)).toBe(0);
    expect(JSON.stringify(doc.paragraphs)).toBe(before); expect(doc.history).toHaveLength(history);
    expect(doc.selection).toEqual({ anchor: 0, focus: 0 });
    doc.undo(); expect(doc.revisions.map(r => r.type)).toEqual(['del']);
  });
});
