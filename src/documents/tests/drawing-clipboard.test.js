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
