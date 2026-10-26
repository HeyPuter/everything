import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { parseLinearMath, linearToOmml, ommlToLinear, ommlToEditableLinear, EQUATION_GALLERY } from '../src/engine/math-linear.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

const parse = xml => {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc.documentElement;
};
const math = input => parse(linearToOmml(input));
const all = (node, name) => [...node.getElementsByTagNameNS(M, name)];
const child = (node, name) => [...node.children].find(n => n.namespaceURI === M && n.localName === name);
const names = node => [...node.children].map(n => n.localName);
const text = node => all(node, 't').map(t => t.textContent).join('');
const val = (node, name) => child(node, name)?.getAttributeNS(M, 'val');

const docx = body => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
}).map(([k, v]) => [k, strToU8(v)])));

describe('linear format to Office Math', () => {
  it('builds fractions with operand precedence and drops grouping parentheses', () => {
    const simple = math('a/b');
    expect(all(simple, 'f')).toHaveLength(1);
    expect(text(child(all(simple, 'f')[0], 'num'))).toBe('a');
    const grouped = math('(a+b)/c'), [f] = all(grouped, 'f');
    expect(names(f)).toEqual(['num', 'den']);
    expect(text(child(f, 'num'))).toBe('a+b');
    expect(all(f, 'd')).toHaveLength(0);
    // a+b/c only divides b; a/b/c groups to the left.
    expect(text(child(all(math('a+b/c'), 'f')[0], 'num'))).toBe('b');
    const nested = all(math('a/b/c'), 'f');
    expect(nested).toHaveLength(2);
    expect(child(child(nested[0], 'num'), 'f')).toBe(nested[1]);
    expect(text(child(all(math('(a+b)/(c+d)'), 'f')[0], 'den'))).toBe('c+d');
  });

  it('builds scripts, radicals and n-ary operators in schema order', () => {
    const sup = all(math('x^2'), 'sSup')[0];
    expect(names(sup)).toEqual(['e', 'sup']);
    expect(text(child(sup, 'sup'))).toBe('2');
    expect(names(all(math('x_i'), 'sSub')[0])).toEqual(['e', 'sub']);
    expect(names(all(math('x_i^2'), 'sSubSup')[0])).toEqual(['e', 'sub', 'sup']);
    expect(text(child(all(math('x^(n+1)'), 'sSup')[0], 'sup'))).toBe('n+1');

    const sum = all(math('∑_(i=1)^n i'), 'nary')[0];
    expect(names(sum)).toEqual(['naryPr', 'sub', 'sup', 'e']);
    expect(names(child(sum, 'naryPr'))).toEqual(['chr', 'limLoc']);
    expect(val(child(sum, 'naryPr'), 'chr')).toBe('∑');
    expect(val(child(sum, 'naryPr'), 'limLoc')).toBe('undOvr');
    expect([text(child(sum, 'sub')), text(child(sum, 'sup')), text(child(sum, 'e'))]).toEqual(['i=1', 'n', 'i']);
    const integral = all(math('∫_0^1 f(x)dx=F(1)-F(0)'), 'nary')[0];
    expect(val(child(integral, 'naryPr'), 'limLoc')).toBe('subSup');
    expect(text(child(integral, 'e'))).toBe('fxdx');
    const bare = child(all(math('∮ E⋅dA'), 'nary')[0], 'naryPr');
    expect(names(bare)).toEqual(['chr', 'limLoc', 'subHide', 'supHide']);

    const rad = all(math('√(x+1)'), 'rad')[0];
    expect(names(rad)).toEqual(['radPr', 'deg', 'e']);
    expect(val(child(rad, 'radPr'), 'degHide')).toBe('1');
    expect(text(child(rad, 'e'))).toBe('x+1');
    expect(all(rad, 'd')).toHaveLength(0);
    for (const input of ['√(3&x)', '∛x', '\\sqrt[3]{x}']) {
      const root = all(math(input), 'rad')[0];
      expect(names(root)).toEqual(['deg', 'e']);
      expect([text(child(root, 'deg')), text(child(root, 'e'))]).toEqual(['3', 'x']);
    }
    expect(all(math('sqrt(x)'), 'rad')).toHaveLength(1);
  });

  it('builds delimiters, functions, accents, matrices and equation arrays', () => {
    const square = all(math('[a+b]'), 'd')[0];
    expect(names(square)).toEqual(['dPr', 'e']);
    expect([val(child(square, 'dPr'), 'begChr'), val(child(square, 'dPr'), 'endChr')]).toEqual(['[', ']']);
    expect(names(all(math('(a)'), 'd')[0])).toEqual(['e']);
    expect(all(math('|x|+|y|'), 'd')).toHaveLength(2);

    const sin = all(math('sin x'), 'func')[0];
    expect(names(sin)).toEqual(['fName', 'e']);
    const name = all(child(sin, 'fName'), 'r')[0];
    expect(val(child(name, 'rPr'), 'sty')).toBe('p');
    expect(text(child(sin, 'e'))).toBe('x');
    expect(all(child(all(math('cos(2θ)'), 'func')[0], 'e'), 'd')).toHaveLength(1);
    const lim = all(math('lim_(x→0) sin x/x'), 'func')[0];
    expect(names(child(child(lim, 'fName'), 'limLow'))).toEqual(['e', 'lim']);
    expect(text(child(child(child(lim, 'fName'), 'limLow'), 'lim'))).toBe('x→0');

    for (const input of ['x̂', 'hat(x)', '\\hat{x}']) expect(val(child(all(math(input), 'acc')[0], 'accPr'), 'chr')).toBe('̂');
    expect(val(child(all(math('ẋ'), 'acc')[0], 'accPr'), 'chr')).toBe('̇');
    expect(all(math('x̄'), 'acc')).toHaveLength(1);
    expect(val(child(all(math('vec(v)'), 'acc')[0], 'accPr'), 'chr')).toBe('⃗');
    const bar = all(math('bar(x)'), 'bar')[0];
    expect(names(bar)).toEqual(['barPr', 'e']);
    expect(val(child(bar, 'barPr'), 'pos')).toBe('top');

    const matrix = all(math('[■(a&b@c&d)]'), 'm')[0];
    expect(matrix.parentNode.parentNode.localName).toBe('d');
    expect(names(matrix)).toEqual(['mPr', 'mr', 'mr']);
    expect(all(matrix, 'mr').map(r => names(r))).toEqual([['e', 'e'], ['e', 'e']]);
    expect(names(all(math('■(1&2&3@4)'), 'mr')[1])).toEqual(['e', 'e', 'e']);
    const array = all(math('█(x+y=2@x-y=0)'), 'eqArr')[0];
    expect(names(array)).toEqual(['e', 'e']);
    expect(text(array.children[1])).toBe('x−y=0');
  });

  it('converts TeX control words, keeps text runs and escapes markup', () => {
    expect(text(math('\\alpha+\\beta \\le \\pi \\times \\infty \\ne \\theta \\cdot 2 \\to \\pm \\ge'))).toBe('α+β≤π×∞≠θ⋅2→±≥');
    const tex = math('\\frac{a+b}{2} + \\sum_{i=1}^{n} i');
    expect(text(child(all(tex, 'f')[0], 'num'))).toBe('a+b');
    expect(val(child(all(tex, 'nary')[0], 'naryPr'), 'chr')).toBe('∑');
    expect(text(child(all(tex, 'nary')[0], 'sub'))).toBe('i=1');
    expect(val(child(all(math('\\int_0^1 x\\,dx'), 'nary')[0], 'naryPr'), 'chr')).toBe('∫');
    expect(text(math('x \\unknown y'))).toBe('x\\unknowny');

    const words = math('"if " x>0');
    const [label] = all(words, 'r');
    expect(val(child(label, 'rPr'), 'sty')).toBe('p');
    expect(child(label, 't').getAttribute('xml:space')).toBe('preserve');
    expect(child(label, 't').textContent).toBe('if ');
    expect(linearToOmml('x<y&z')).toContain('x&lt;y&amp;z');
    expect(text(math('x<y&z'))).toBe('x<y&z');
  });

  it('keeps malformed input as literal text and rejects empty input', () => {
    for (const [input, literal] of [['(a+b', '(a+b'], ['a)', 'a)'], ['x^', 'x^'], ['/a', '/a'], ['a/', 'a/'], ['√', '√'], ['■', '■'], ['\\frac', '\\frac'], ['"open', '"open']]) {
      const root = math(input);
      expect(text(root)).toBe(literal);
      expect(root.querySelector('*') && all(root, 'f').length + all(root, 'd').length + all(root, 'sSup').length + all(root, 'rad').length).toBe(0);
    }
    expect(text(child(all(math('P(A|B)'), 'd')[0], 'e'))).toBe('A|B');
    expect(() => linearToOmml('')).toThrow();
    expect(() => linearToOmml('   ')).toThrow();
    expect(parseLinearMath('x^2').body[0]).toMatchObject({ type: 'sup', e: [{ type: 'run', text: 'x' }], sup: [{ type: 'run', text: '2' }] });
  });

  it('wraps display equations in m:oMathPara', () => {
    const root = parse(linearToOmml('E=mc^2', { display: true }));
    expect([root.namespaceURI, root.localName]).toEqual([M, 'oMathPara']);
    expect(names(root)).toEqual(['oMath']);
    expect(math('E=mc^2').localName).toBe('oMath');
  });

  it('shows existing markup linearly for editing', () => {
    expect(ommlToLinear(linearToOmml('(a+b)/(c+d)'))).toBe('(a+b)/(c+d)');
    expect(ommlToLinear(linearToOmml('x^2+y_1'))).toBe('x^2+y_1');
    // Fragments retained without their own namespace declarations.
    expect(ommlToLinear('<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath>')).toBe('a');
    expect(ommlToLinear('<broken')).toBe('');
  });
});

describe('editing an existing equation', () => {
  // Edit Equation shows the equation as linear text; typed back unchanged, it must build the same equation.
  const same = linear => {
    const xml = linearToOmml(linear), editable = ommlToEditableLinear(xml);
    expect(linearToOmml(editable), `${linear} → ${editable}`).toBe(xml);
    return editable;
  };
  it('writes every structure in a form that builds it again', () => {
    for (const { linear } of EQUATION_GALLERY) same(linear);
    // Binomials, matrices and equation arrays stay themselves; roots keep their degree.
    expect(same('(n¦k)')).toBe('(n¦k)');
    expect(same('|■(a&b@c&d)|')).toBe('|■(a&b@c&d)|');
    expect(same('█(x+y=1@x-y=3)')).toBe('█(x+y=1@x−y=3)');
    expect(same('∛x')).toBe('√(3&x)');
    expect(same('\\sqrt(4&y)')).toBe('√(4&y)');
    // Accents over several letters, scripts and fractions beside other terms, functions after scripts.
    expect(same('\\hat(xy)')).toBe('hat(xy)');
    expect(same('1/2 x')).toBe('1/2 x');
    expect(same('a_n cos x')).toBe('a_n cos x');
    expect(same('f^((n))(a)')).toBe('f^((n)) (a)');
    for (const linear of ['"rate" x', 'x̅+y̲', '\\vec v', '\\operatorname{sgn} x', 'log_2 x', 'max_(i) a_i', '‖v‖', '|x|^2', '⌊x⌋', '√(x^2+1)', '(1+x)^n/n!',
      'x^2y', 'e^(-x^2/2)', '∫_a^b f(x) dx=F(b)-F(a)', '■(1&0&0@0&1&0@0&0&1)', 'α_1^β', 'sin(x)/x', 'x/sin x', 'tan θ=sin θ/cos θ', '\\frac{a+b}{2}',
      'P(A|B)=P(B|A)P(A)/P(B)', '√(√x)', 'e^(sin x)', 'x_(n+1)=x_n-f(x_n)/f′(x_n)', 'x^(a+b)', 'x_(i,j)', '(a)(b)', 'a\\overline(xy)']) same(linear);
  });
  it('reads equations written by other applications', () => {
    const word = `<m:oMath xmlns:m="${M}" xmlns:w="${W}"><m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>y=</m:t></m:r><m:f><m:fPr><m:ctrlPr><w:rPr><w:i/></w:rPr></m:ctrlPr></m:fPr><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f><m:r><m:t>x</m:t></m:r><m:rad><m:radPr><m:degHide m:val="1"/><m:ctrlPr/></m:radPr><m:deg/><m:e><m:r><m:t>x+1</m:t></m:r></m:e></m:rad><m:func><m:funcPr><m:ctrlPr/></m:funcPr><m:fName><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sgn</m:t></m:r></m:fName><m:e><m:r><m:t>x</m:t></m:r></m:e></m:func><m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e><m:r><m:t>z</m:t></m:r></m:e></m:bar></m:oMath>`;
    const editable = ommlToEditableLinear(word);
    expect(editable).toBe('y=1/2 x√(x+1) \\operatorname{sgn} x z̅');
    const built = parse(linearToOmml(editable));
    expect(['f', 'rad', 'func', 'bar'].map(name => all(built, name).length)).toEqual([1, 1, 1, 1]);
    expect(text(child(all(built, 'func')[0], 'fName'))).toBe('sgn');
    expect(ommlToEditableLinear('<broken')).toBe('');
  });
});

describe('equation gallery', () => {
  it('lists common equations with unique ids', () => {
    expect(EQUATION_GALLERY.length).toBeGreaterThanOrEqual(10);
    expect(new Set(EQUATION_GALLERY.map(e => e.id)).size).toBe(EQUATION_GALLERY.length);
    for (const entry of EQUATION_GALLERY) expect(entry).toEqual({ id: expect.any(String), name: expect.any(String), linear: expect.any(String) });
  });

  it('builds every entry into markup that reads back linearly', () => {
    const expected = { 'circle-area': ['π', '^2'], quadratic: ['√', '±', '/'], pythagorean: ['a^2', 'c^2'], binomial: ['∑', '(a+b)^n'], 'sum-integers': ['∑', '/2'], taylor: ['∑', 'n!'], exponential: ['x^2', '2!'], fourier: ['cos', 'sin', '∑'], 'trig-identity': ['sin^2', 'cos^2'], euler: ['e^(iπ)'], 'gaussian-integral': ['∫', '√π'], determinant: ['|', 'ad'], 'limit-e': ['lim', '→∞'] };
    for (const { id, linear } of EQUATION_GALLERY) {
      expect(parse(linearToOmml(linear)).localName).toBe('oMath');
      expect(all(parse(linearToOmml(linear, { display: true })), 'oMath')).toHaveLength(1);
      const back = ommlToLinear(linearToOmml(linear));
      for (const piece of expected[id] || []) expect(back, id).toContain(piece);
    }
    expect(all(math(EQUATION_GALLERY.find(e => e.id === 'determinant').linear), 'mr')).toHaveLength(2);
    expect(all(math(EQUATION_GALLERY.find(e => e.id === 'quadratic').linear), 'rad')).toHaveLength(1);
  });

  it('opens every entry editable inside a DOCX paragraph and saves it unchanged', async () => {
    for (const { linear } of EQUATION_GALLERY) for (const display of [false, true]) {
      const omml = linearToOmml(linear, { display });
      const pkg = await DocxPackage.open(docx(`<w:p>${omml}</w:p>`));
      expect(pkg.readOnly, linear).toBeFalsy();
      const [p] = pkg.paragraphs;
      expect(p.runs.filter(r => r.math), linear).toHaveLength(1);
      expect(p.runs[0].math.text).toBe(ommlToLinear(omml));
      const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
      const saved = strFromU8(unzipSync(new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()))['word/document.xml']);
      const again = await DocxPackage.open(docx(saved.match(/<w:body>(.*)<w:sectPr/s)[1]));
      expect(again.paragraphs[0].runs.find(r => r.math).math.text).toBe(p.runs[0].math.text);
    }
  });
});
