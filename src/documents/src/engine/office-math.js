// Office Math (ECMA-376 Part 1 §22.1) is retained, not edited: each m:oMath or
// m:oMathPara is one atomic object whose source XML is written back unchanged.
// It is displayed in a linear form close to the UnicodeMath linear format.
export const MATH = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const kids = node => [...(node?.children || [])];
const m = (node, name) => kids(node).find(n => n.namespaceURI === MATH && n.localName === name);
const val = (node, name) => m(node, name)?.getAttributeNS(MATH, 'val');

// Elements nested deeper than this inside one equation are read as their plain text. Word's
// equations stay far below it; a generated or hostile file nested thousands deep would otherwise
// exhaust the call stack of every reader that walks the structure (display text, previews, Edit
// Equation). The equation's XML is still saved unchanged.
export const MATH_DEPTH_LIMIT = 400;

/** The characters of a math subtree in document order, without walking it recursively. */
export function mathPlainText(node) {
  if (!node) return '';
  const text = [];
  for (const t of node.getElementsByTagName('*')) if (t.localName === 't' && (t.namespaceURI === MATH || t.namespaceURI === W)) text.push(t.textContent);
  return node.localName === 't' ? node.textContent : text.join('');
}

/** Linear text for an Office Math element. */
export function linearMath(node, depth = 0) {
  if (!node) return '';
  if (depth >= MATH_DEPTH_LIMIT) return mathPlainText(node);
  const linear = n => linearMath(n, depth + 1);
  const all = n => kids(n).map(linear).join('');
  const group = n => { const t = all(n); return [...t].length > 1 && !/^\(.*\)$/.test(t) ? `(${t})` : t; };
  if (node.namespaceURI === W) {
    if (node.localName === 't') return node.textContent;
    if (['rPr', 'pPr'].includes(node.localName)) return '';
    return all(node);
  }
  if (node.namespaceURI !== MATH) return '';
  switch (node.localName) {
    case 't': return node.textContent;
    case 'rPr': case 'ctrlPr': case 'oMathParaPr': case 'fPr': case 'radPr': case 'dPr': case 'naryPr': case 'sSupPr': case 'sSubPr': case 'sSubSupPr': case 'funcPr': case 'accPr': case 'barPr': case 'limLowPr': case 'limUppPr': case 'eqArrPr': case 'mPr': case 'boxPr': case 'borderBoxPr': case 'groupChrPr': case 'sPrePr': case 'phantPr': return '';
    case 'oMathPara': return kids(node).filter(n => n.localName === 'oMath').map(linear).join('\n');
    case 'f': return `${group(m(node, 'num'))}/${group(m(node, 'den'))}`;
    case 'sSup': return `${all(m(node, 'e'))}^${group(m(node, 'sup'))}`;
    case 'sSub': return `${all(m(node, 'e'))}_${group(m(node, 'sub'))}`;
    case 'sSubSup': return `${all(m(node, 'e'))}_${group(m(node, 'sub'))}^${group(m(node, 'sup'))}`;
    case 'sPre': return `_${group(m(node, 'sub'))}^${group(m(node, 'sup'))}${all(m(node, 'e'))}`;
    case 'rad': {
      const degree = all(m(node, 'deg'));
      return `${degree ? `${degree}` : ''}√${group(m(node, 'e'))}`;
    }
    case 'd': {
      const pr = m(node, 'dPr'), open = val(pr, 'begChr') ?? '(', close = val(pr, 'endChr') ?? ')', sep = val(pr, 'sepChr') ?? '|';
      return `${open}${kids(node).filter(n => n.localName === 'e').map(linear).join(sep)}${close}`;
    }
    case 'nary': {
      const pr = m(node, 'naryPr'), symbol = val(pr, 'chr') ?? '∫';
      const sub = all(m(node, 'sub')), sup = all(m(node, 'sup'));
      return `${symbol}${sub ? `_${sub.length > 1 ? `(${sub})` : sub}` : ''}${sup ? `^${sup.length > 1 ? `(${sup})` : sup}` : ''} ${all(m(node, 'e'))}`;
    }
    case 'func': return `${all(m(node, 'fName'))} ${group(m(node, 'e'))}`;
    case 'acc': return `${all(m(node, 'e'))}${val(m(node, 'accPr'), 'chr') ?? '̂'}`;
    case 'bar': return `${all(m(node, 'e'))}̅`;
    case 'limLow': return `${all(m(node, 'e'))}_${group(m(node, 'lim'))}`;
    case 'limUpp': return `${all(m(node, 'e'))}^${group(m(node, 'lim'))}`;
    case 'eqArr': return kids(node).filter(n => n.localName === 'e').map(linear).join('; ');
    case 'm': return `[${kids(node).filter(n => n.localName === 'mr').map(r => kids(r).filter(n => n.localName === 'e').map(linear).join(', ')).join('; ')}]`;
    default: return all(node);
  }
}

export const isMathElement = node => node?.namespaceURI === MATH && ['oMath', 'oMathPara'].includes(node.localName);
