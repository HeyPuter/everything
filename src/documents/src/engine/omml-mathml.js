// Office Math (ECMA-376 Part 1 §22.1) to MathML Core markup, for previews in the equation editor
// and the equation gallery. The document keeps the OMML; this is display only.
import { MATH_DEPTH_LIMIT, mathPlainText } from './office-math.js';

const MATH = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const kids = node => [...(node?.children || [])];
const m = (node, name) => kids(node).find(n => n.namespaceURI === MATH && n.localName === name);
const val = (node, name) => m(node, name)?.getAttributeNS(MATH, 'val') ?? m(node, name)?.getAttribute('m:val');
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const OPERATORS = /[+\-−=<>≤≥≠≈±∓×÷·∙∘→←↔⇒⇐⇔∈∉⊂⊃⊆⊇∪∩∧∨¬∀∃∂∇∑∏∫∮,;:!|/()[\]{}⟨⟩⌊⌋⌈⌉′″…⋯∞%]/;

/** Tokens of a math run: numbers, letters (italic identifiers), operators. Upright runs stay text. */
function runTokens(text, plain) {
  if (plain) return `<mtext>${escape(text)}</mtext>`;
  return [...String(text).matchAll(/\d+(?:\.\d+)?|\s+|./gu)].map(([t]) => /^\d/.test(t) ? `<mn>${t}</mn>` : /^\s+$/.test(t) ? '<mspace width="0.25em"/>' : OPERATORS.test(t) ? `<mo>${escape(t)}</mo>` : `<mi>${escape(t)}</mi>`).join('');
}
function toMathml(node, depth = 0) {
  if (!node || node.namespaceURI !== MATH) return '';
  // Structure nested beyond the limit previews as its text (see office-math.js).
  if (depth >= MATH_DEPTH_LIMIT) return `<mtext>${escape(mathPlainText(node))}</mtext>`;
  const convert = child => toMathml(child, depth + 1), row = n => `<mrow>${kids(n).map(convert).join('')}</mrow>`;
  switch (node.localName) {
    case 'oMathPara': return kids(node).filter(n => n.localName === 'oMath').map(n => `<mrow>${kids(n).map(convert).join('')}</mrow>`).join('<mspace linebreak="newline"/>');
    case 'oMath': case 'e': case 'num': case 'den': case 'sub': case 'sup': case 'deg': case 'fName': case 'lim': return row(node);
    case 'r': {
      const t = kids(node).filter(n => n.localName === 't').map(n => n.textContent).join('');
      const plain = val(m(node, 'rPr'), 'sty') === 'p' || !!m(m(node, 'rPr'), 'nor');
      return plain && /^[A-Za-z]{2,}$/.test(t) ? `<mi mathvariant="normal">${escape(t)}</mi>` : runTokens(t, plain && !/^[A-Za-z]+$/.test(t));
    }
    case 'f': return `<mfrac${val(m(node, 'fPr'), 'type') === 'noBar' ? ' linethickness="0"' : ''}>${convert(m(node, 'num'))}${convert(m(node, 'den'))}</mfrac>`;
    case 'sSup': return `<msup>${convert(m(node, 'e'))}${convert(m(node, 'sup'))}</msup>`;
    case 'sSub': return `<msub>${convert(m(node, 'e'))}${convert(m(node, 'sub'))}</msub>`;
    case 'sSubSup': return `<msubsup>${convert(m(node, 'e'))}${convert(m(node, 'sub'))}${convert(m(node, 'sup'))}</msubsup>`;
    case 'sPre': return `<mmultiscripts>${convert(m(node, 'e'))}<mprescripts/>${convert(m(node, 'sub'))}${convert(m(node, 'sup'))}</mmultiscripts>`;
    case 'rad': return ['1', 'on', 'true'].includes(val(m(node, 'radPr'), 'degHide')) || !m(node, 'deg')?.children.length ? `<msqrt>${convert(m(node, 'e'))}</msqrt>` : `<mroot>${convert(m(node, 'e'))}${convert(m(node, 'deg'))}</mroot>`;
    case 'd': {
      const pr = m(node, 'dPr'), open = val(pr, 'begChr') ?? '(', close = val(pr, 'endChr') ?? ')', sep = val(pr, 'sepChr') ?? '|';
      const parts = kids(node).filter(n => n.localName === 'e').map(convert).join(`<mo>${escape(sep)}</mo>`);
      return `<mrow>${open ? `<mo fence="true">${escape(open)}</mo>` : ''}${parts}${close ? `<mo fence="true">${escape(close)}</mo>` : ''}</mrow>`;
    }
    case 'nary': {
      const pr = m(node, 'naryPr'), chr = val(pr, 'chr') ?? '∫', under = val(pr, 'limLoc') === 'undOvr';
      const hideSub = ['1', 'on', 'true'].includes(val(pr, 'subHide')), hideSup = ['1', 'on', 'true'].includes(val(pr, 'supHide'));
      const op = `<mo largeop="true">${escape(chr)}</mo>`, sub = hideSub ? '' : convert(m(node, 'sub')), sup = hideSup ? '' : convert(m(node, 'sup'));
      const base = sub && sup ? (under ? `<munderover>${op}${sub}${sup}</munderover>` : `<msubsup>${op}${sub}${sup}</msubsup>`) : sub ? (under ? `<munder>${op}${sub}</munder>` : `<msub>${op}${sub}</msub>`) : sup ? (under ? `<mover>${op}${sup}</mover>` : `<msup>${op}${sup}</msup>`) : op;
      return `<mrow>${base}${convert(m(node, 'e'))}</mrow>`;
    }
    case 'func': return `<mrow>${convert(m(node, 'fName'))}<mo>&#x2061;</mo>${convert(m(node, 'e'))}</mrow>`;
    case 'acc': return `<mover accent="true">${convert(m(node, 'e'))}<mo>${escape(val(m(node, 'accPr'), 'chr') ?? '\u0302')}</mo></mover>`;
    case 'bar': return val(m(node, 'barPr'), 'pos') === 'top' ? `<mover accent="true">${convert(m(node, 'e'))}<mo>\u203E</mo></mover>` : `<munder>${convert(m(node, 'e'))}<mo>_</mo></munder>`;
    case 'limLow': return `<munder>${convert(m(node, 'e'))}${convert(m(node, 'lim'))}</munder>`;
    case 'limUpp': return `<mover>${convert(m(node, 'e'))}${convert(m(node, 'lim'))}</mover>`;
    case 'groupChr': return `<munder>${convert(m(node, 'e'))}<mo>${escape(val(m(node, 'groupChrPr'), 'chr') ?? '\u23DF')}</mo></munder>`;
    case 'm': return `<mrow><mtable>${kids(node).filter(n => n.localName === 'mr').map(r => `<mtr>${kids(r).filter(n => n.localName === 'e').map(e => `<mtd>${convert(e)}</mtd>`).join('')}</mtr>`).join('')}</mtable></mrow>`;
    case 'eqArr': return `<mtable columnalign="left">${kids(node).filter(n => n.localName === 'e').map(e => `<mtr><mtd>${convert(e)}</mtd></mtr>`).join('')}</mtable>`;
    case 'box': case 'borderBox': case 'phant': return convert(m(node, 'e'));
    default: return kids(node).map(convert).join('');
  }
}

/** MathML markup (a `<math>` element string) for an OMML string; display adds block layout. */
export function ommlToMathml(xml, { display = false } = {}) {
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (!root || root.localName === 'parsererror' || root.getElementsByTagName('parsererror').length) return '';
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display || root.localName === 'oMathPara' ? ' display="block"' : ''}>${toMathml(root)}</math>`;
}
