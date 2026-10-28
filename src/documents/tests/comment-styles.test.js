import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';

// A new comment's paragraphs use the paragraph style CommentText and its reference marks the character
// style CommentReference, as Word writes them (its built-in "annotation text" and "annotation
// reference", §17.7.4.17 style identifiers). A document that had no comments usually lacks both,
// so its comments were saved with references to styles the file does not define. The styles part
// now gets Word's definitions of the two when they are missing.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STYLES = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`;
function withStyles(extra = '') {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Commented text' }]));
  parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}">${STYLES}${extra}</w:styles>`);
  parts['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
  return zipSync(parts);
}
async function comment(bytes) {
  const pkg = await DocxPackage.open(bytes);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments });
  doc.select(0, 9); doc.addComment({ author: 'Ada', text: 'Check this' });
  return unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets, undefined, doc.comments).arrayBuffer()));
}
const styleIds = xml => [...new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS(W, 'style')].map(s => `${s.getAttributeNS(W, 'type')}:${s.getAttributeNS(W, 'styleId')}`);

it('adds the comment styles a new comment uses when the document lacks them', async () => {
  const parts = await comment(withStyles());
  expect(strFromU8(parts['word/comments.xml'])).toContain('<w:pStyle w:val="CommentText"/>');
  const styles = strFromU8(parts['word/styles.xml']);
  expect(styleIds(styles)).toEqual(['paragraph:Normal', 'character:DefaultParagraphFont', 'paragraph:CommentText', 'character:CommentReference']);
  expect(styles).toContain('<w:name w:val="annotation text"/>');
  expect(styles).toContain('<w:name w:val="annotation reference"/>');
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).toBeFalsy();
  expect(reopened.styles.definitions.CommentText.basedOn).toBe('Normal');
  expect(reopened.comments.map(c => c.text)).toEqual(['Check this']);
});

it('leaves comment styles the document already defines as they are', async () => {
  const own = '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="14"/></w:rPr></w:style>';
  const parts = await comment(withStyles(own));
  expect(strFromU8(parts['word/styles.xml'])).toBe(strFromU8(unzipSync(withStyles(own))['word/styles.xml']));
});
