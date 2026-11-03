import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { insertCaption } from '../src/engine/captions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" mc:Ignorable="wps"';
const t = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const seq = cached => `<w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>${cached}</w:t></w:r></w:fldSimple>`;
const caption = cached => `<w:p>${t('Figure ')}${seq(cached)}${t(': body')}</w:p>`;
// A caption in a text box, as Word writes one for a floating picture: DrawingML with a VML copy of the same text as its fallback.
const box = cached => {
  const content = `<w:txbxContent><w:p>${t('Figure ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ Figure \\* ARABIC </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${t(cached)}<w:r><w:fldChar w:fldCharType="end"/></w:r>${t(': boxed')}</w:p></w:txbxContent>`;
  const drawing = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1524000" cy="762000"/><wp:docPr id="1" name="Caption box"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvPr id="101" name="Caption box"/><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1524000" cy="762000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr><wps:txbx>${content}</wps:txbx><wps:bodyPr lIns="76200" rIns="76200" tIns="38100" bIns="38100" anchor="t" wrap="square"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  return `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawing}</mc:Choice><mc:Fallback><w:pict><v:shape style="width:120pt;height:60pt"><v:textbox>${content}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
};
const source = body => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)])));
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, d: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const numbers = d => bodyFieldRanges(d.paragraphs).filter(r => r.field.type === 'SEQ').map(r => d.text.slice(r.start, r.end));

// Word numbers a caption in a text box where its drawing stands. Update Fields counted only the body's captions, so
// "Figure 3" after a text box holding Figure 2 became "Figure 2": two figures numbered 2.
it('counts the captions in text boxes where their drawings stand', async () => {
  const { pkg, d } = await open(source(caption(1) + box(2) + caption(3) + '<w:p/>'));
  expect(pkg.readOnly).toBeFalsy();
  const issues = [];
  updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) });
  // The text box's caption counts once, though its text is also in the VML fallback.
  expect(numbers(d)).toEqual(['1', '3']);
  expect(issues).toEqual([]);
  // A caption inserted before them renumbers the body's captions around the text box's, and says the text box's
  // number is now out of date.
  d.select(0);
  insertCaption(d, { label: 'Figure', text: 'New', above: true });
  expect(numbers(d)).toEqual(['1', '2', '4']);
  issues.length = 0;
  updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) });
  expect(numbers(d)).toEqual(['1', '2', '4']);
  expect(issues).toEqual(['A caption number in a text box or shape keeps its text; edit the drawing’s text to change it.']);
});
