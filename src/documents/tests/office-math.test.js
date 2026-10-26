import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { linearMath, MATH_DEPTH_LIMIT } from '../src/engine/office-math.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const r = t => `<m:r><m:t>${t}</m:t></m:r>`;
// The quadratic formula, written independently in Office Math markup.
const quadratic = `<m:oMath>${r('x=')}<m:f><m:num>${r('-b±')}<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e>${r('b')}</m:e><m:sup>${r('2')}</m:sup></m:sSup>${r('-4ac')}</m:e></m:rad></m:num><m:den>${r('2a')}</m:den></m:f></m:oMath>`;
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });

it('opens equations for editing, shows them linearly and saves their markup unchanged', async () => {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:m="${M}"><w:body><w:p><w:r><w:t xml:space="preserve">Solve </w:t></w:r>${quadratic}<w:r><w:t xml:space="preserve"> now.</w:t></w:r></w:p><w:p><m:oMathPara><m:oMath>${r('E=m')}<m:sSup><m:e>${r('c')}</m:e><m:sup>${r('2')}</m:sup></m:sSup></m:oMath></m:oMathPara></w:p><w:sectPr/></w:body></w:document>`,
  };
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  expect(pkg.readOnly).toBeFalsy();
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(d.text).toBe('Solve ￼ now.\n￼');
  expect(d.paragraphs[0].runs[1].math.text).toBe('x=(-b±√(b^2-4ac))/(2a)');
  expect(d.paragraphs[1].runs[0].math.text).toBe('E=mc^2');
  const placed = layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, undefined, { styles: d.styles });
  expect(placed.lines[0].fragments.map(f => f.text).join('')).toContain('x=(-b±√(b^2-4ac))/(2a)');
  d.select(0); d.replace('Please ');
  const xml = strFromU8(unzipSync(new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()))['word/document.xml']);
  expect(xml).toContain('<m:f><m:num>');
  const again = new TextDocument((await DocxPackage.open(new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()))).paragraphs);
  expect(again.text).toBe('Please Solve ￼ now.\n￼');
  expect(again.paragraphs[0].runs.find(r => r.math).math.text).toBe('x=(-b±√(b^2-4ac))/(2a)');
});

// A bare element tree: jsdom's own parser and serializer recurse, so they cannot hold a tree this deep.
class Element {
  constructor(localName, children = [], text = '') { Object.assign(this, { namespaceURI: M, localName, children, text }); }
  get textContent() { return this.text || this.getElementsByTagName('*').map(n => n.text).join(''); }
  getAttributeNS() { return null; }
  getElementsByTagName() {
    const out = [], stack = [...this.children].reverse();
    while (stack.length) { const n = stack.pop(); out.push(n); stack.push(...[...n.children].reverse()); }
    return out;
  }
}
it('reads an equation nested far too deeply as text instead of exhausting the stack', () => {
  // Brackets inside brackets 20,000 deep, deeper than any recursive reader survives. The levels
  // past the limit read as their characters, so nothing of the equation's text is lost.
  let inner = new Element('r', [new Element('t', [], 'x')]);
  for (let i = 0; i < 20000; i++) inner = new Element('d', [new Element('e', [inner])]);
  const root = new Element('oMath', [inner, new Element('r', [new Element('t', [], '+1')])]);
  const levels = MATH_DEPTH_LIMIT / 2;
  expect(linearMath(root)).toBe(`${'('.repeat(levels)}x${')'.repeat(levels)}+1`);
});
