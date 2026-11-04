import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { htmlEquation, EQUATION_ATTRIBUTE } from '../src/engine/drawing-clipboard.js';

let dom;
beforeAll(() => { dom = new JSDOM(); Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer }); });
afterAll(() => dom.window.close());

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math', W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const carried = (xml, text = 'x') => `<span ${EQUATION_ATTRIBUTE}="${JSON.stringify({ xml, text }).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">x</span>`;

it('takes Office Math from a copy, with run formatting, and refuses anything else the saved file would carry', () => {
  const math = `<m:oMath xmlns:m="${M}" xmlns:w="${W}"><m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t xml:space="preserve">x</m:t></m:r></m:oMath>`;
  expect(htmlEquation(carried(math))).toMatchObject({ text: 'x' });
  expect(htmlEquation(carried(math)).xml).toContain('Cambria Math');
  // A drawing, a field, another namespace's attribute, or a root that is not an equation.
  expect(htmlEquation(carried(math.replace('<m:t', `<w:drawing/><m:t`)))).toBe(null);
  expect(htmlEquation(carried(math.replace('<m:t', `<w:fldChar w:fldCharType="begin"/><m:t`)))).toBe(null);
  expect(htmlEquation(carried(math.replace('<m:r>', `<m:r xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1">`)))).toBe(null);
  expect(htmlEquation(carried(`<w:p xmlns:w="${W}"/>`))).toBe(null);
  expect(htmlEquation(carried('<m:oMath'))).toBe(null);
  expect(htmlEquation('<p>no equation</p>')).toBe(null);
});

it('finds fields in pasted drawing XML that load something from elsewhere, however their instruction is written', async () => {
  const { externalField } = await import('../src/engine/drawing-clipboard.js');
  const read = body => externalField(new DOMParser().parseFromString(`<w:drawing xmlns:w="${W}"><w:txbxContent>${body}</w:txbxContent></w:drawing>`, 'application/xml').documentElement);
  const complex = (...parts) => `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${parts.map(p => `<w:r><w:instrText xml:space="preserve">${p}</w:instrText></w:r>`).join('')}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>result</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  expect(read(complex(' INCLUDEPICTURE "https://example.com/a.png" \\d '))).toBe('INCLUDEPICTURE');
  // Split across runs, in any case, with any spacing.
  expect(read(complex('  inclu', 'dePicture ', '"https://example.com/a.png"'))).toBe('inclu' + 'dePicture');
  expect(read(`<w:p><w:fldSimple w:instr="&#9;IncludeText &quot;\\\\server\\share\\a.docx&quot;"><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`)).toBe('IncludeText');
  for (const name of ['LINK Excel.Sheet.12 "a.xlsx" "" \\a', 'DDE x y', 'DDEAUTO x y', 'IMPORT a.png', 'INCLUDE a.docx']) expect(read(complex(name))).toBe(name.split(' ')[0]);
  // A tracked deletion's instruction comes back live if the deletion is rejected.
  expect(read(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:delInstrText>INCLUDEPICTURE "a.png"</w:delInstrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`)).toBe('INCLUDEPICTURE');
  // A field named by a field nested at its start, and a field left without its end.
  expect(read(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>${complex('QUOTE "INCLUDEPICTURE"').slice(5, -6)}<w:r><w:instrText> "a.png"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`)).toBe('named by another field');
  expect(read('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>LINK a b</w:instrText></w:r></w:p>')).toBe('LINK');
  // Fields that load nothing, a link field's result text and a nested field inside an instruction are fine.
  expect(read(complex('PAGE \\* MERGEFORMAT'))).toBe(null);
  expect(read(complex('MERGEFIELD Link'))).toBe(null);
  expect(read(`<w:p><w:r><w:t>INCLUDEPICTURE "a.png"</w:t></w:r></w:p>`)).toBe(null);
  expect(read(`<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF 1 = 1 </w:instrText></w:r>${complex('PAGE').slice(5, -6)}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`)).toBe(null);
});
