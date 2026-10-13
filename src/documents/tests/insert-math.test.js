import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { linearToOmml, ommlToLinear, EQUATION_GALLERY } from '../src/engine/math-linear.js';
import { ommlToMathml } from '../src/engine/omml-mathml.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

it('previews Office Math as MathML structures', () => {
  const mathml = ommlToMathml(linearToOmml('x = (-b ± √(b^2 - 4ac))/2a'));
  expect(mathml).toMatch(/^<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML">/);
  expect(mathml).toContain('<mfrac>'); expect(mathml).toContain('<msqrt>'); expect(mathml).toContain('<msup>');
  expect(ommlToMathml(linearToOmml('∑_(i=1)^n i'))).toMatch(/<munderover><mo largeop="true">∑<\/mo>/);
  expect(ommlToMathml(linearToOmml('■(a&b@c&d)'))).toMatch(/<mtable><mtr><mtd>/);
  expect(ommlToMathml(linearToOmml('x^2', { display: true }))).toContain('display="block"');
  for (const entry of EQUATION_GALLERY) {
    const markup = ommlToMathml(linearToOmml(entry.linear));
    expect(new DOMParser().parseFromString(markup, 'application/xml').getElementsByTagName('parsererror'), entry.id).toHaveLength(0);
  }
  expect(ommlToMathml('<broken')).toBe('');
});

it('inserts equations as Office Math objects that save, reopen and replace in place', async () => {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.replace('Area: .'); doc.select(6);
  const xml = linearToOmml('A = πr^2');
  doc.insertMathRun({ xml, text: ommlToLinear(xml) });
  expect(paragraphText(doc.paragraphs[0])).toBe('Area: ￼.');
  expect(doc.range).toEqual([7, 7]);
  doc.undo();
  expect(paragraphText(doc.paragraphs[0])).toBe('Area: .');
  doc.redo();
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  expect(reopened.readOnly).toBeFalsy();
  const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
  const math = again.paragraphs[0].runs.find(r => r.math);
  expect(math.math.xml).toMatch(/m:sSup/);
  // Editing selects the equation object and inserts the new one in its place.
  again.select(6, 7);
  const next = linearToOmml('A = πr^2 + 1');
  again.insertMathRun({ xml: next, text: ommlToLinear(next) });
  expect(paragraphText(again.paragraphs[0])).toBe('Area: ￼.');
  expect(again.paragraphs[0].runs.find(r => r.math).math.xml).toContain('1');
  expect(() => again.insertMathRun({})).toThrow(/Office Math/);
});
