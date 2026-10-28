import { UnsupportedDocumentError } from './errors.js';
import { drawingColor } from './docx-drawing-style.js';
import { checkedFontName } from './font-families.js';
import { elementChildren } from './docx-xml.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const children = n => n?.children ? elementChildren(n) : [];
const child = (n, name) => children(n).find(c => c.namespaceURI === A && c.localName === name);
const fail = why => { throw new UnsupportedDocumentError(`chart text with ${why}`); };
function check(n, names) {
  const seen = new Set();
  for (const c of children(n)) {
    if (c.namespaceURI !== A || !names.includes(c.localName) || seen.has(c.localName)) fail(`unsupported or duplicate ${c.localName}`);
    seen.add(c.localName);
  }
}
function attributes(n, names) {
  for (const a of n?.attributes || []) if (a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI || !names.includes(a.localName))) fail(`unsupported ${a.name}`);
}
function allowed(n, key, values) {
  const value = n?.getAttribute(key);
  if (value != null && !values.includes(value)) fail(`unsupported ${key}`);
}
function integer(n, key, min, max) {
  const raw = n.getAttribute(key);
  if (!/^\d+$/.test(raw || '') || Number(raw) < min || Number(raw) > max) fail(`invalid ${key}`);
  return Number(raw);
}

// txPr formats generated chart labels; it is not a second source of label text.
// Keep its source XML immutable and merge only explicit properties over parent
// chart text defaults. Rich runs and decorated/vertical labels remain separate.
export function readChartText(node, inherited, scheme, fonts) {
  if (!node) return inherited;
  check(node, ['bodyPr', 'lstStyle', 'p']);
  const body = child(node, 'bodyPr'), p = child(node, 'p');
  if (!body || !p) fail('missing body or paragraph properties');
  check(body, []); check(child(node, 'lstStyle'), []);
  attributes(body, ['rot', 'spcFirstLastPara', 'vertOverflow', 'horzOverflow', 'vert', 'wrap', 'anchor', 'anchorCtr']);
  allowed(body, 'rot', ['0', '-60000000']);
  allowed(body, 'spcFirstLastPara', ['0', '1', 'false', 'true']);
  allowed(body, 'vertOverflow', ['overflow', 'ellipsis', 'clip']);
  allowed(body, 'horzOverflow', ['overflow', 'clip']);
  allowed(body, 'vert', ['horz']); allowed(body, 'wrap', ['square', 'none']);
  allowed(body, 'anchor', ['ctr', 't']); allowed(body, 'anchorCtr', ['0', '1', 'false', 'true']);
  check(p, ['pPr', 'endParaRPr']);
  const pp = child(p, 'pPr'); check(pp, ['defRPr']); attributes(pp, []);
  const end = child(p, 'endParaRPr'); check(end, []); attributes(end, ['lang']);
  const run = child(pp, 'defRPr');
  check(run, ['ln', 'solidFill', 'latin', 'ea', 'cs']);
  attributes(run, ['sz', 'b', 'i', 'u', 'strike', 'kern', 'baseline', 'lang', 'cap', 'spc']);
  allowed(run, 'u', ['none']); allowed(run, 'strike', ['noStrike']);
  allowed(run, 'baseline', ['0']); allowed(run, 'cap', ['none']); allowed(run, 'spc', ['0']);
  const line = child(run, 'ln'); check(line, ['noFill']);
  if (line && !child(line, 'noFill')) fail('text outlines');
  check(child(line, 'noFill'), []);
  const result = { ...inherited };
  if (run?.hasAttribute('sz')) result.fontSize = integer(run, 'sz', 100, 400000) / 100;
  if (run?.hasAttribute('kern')) result.kerning = integer(run, 'kern', 0, 400000) / 100;
  for (const [attr, key] of [['b', 'bold'], ['i', 'italic']]) if (run?.hasAttribute(attr)) {
    allowed(run, attr, ['0', '1', 'false', 'true']); result[key] = ['1', 'true'].includes(run.getAttribute(attr));
  }
  const fill = child(run, 'solidFill');
  if (fill) {
    if (children(fill).length !== 1) fail('missing or conflicting colors');
    result.color = drawingColor(children(fill)[0], scheme);
  }
  for (const [tag, key, suffix] of [['latin', 'fontAscii', 'lt'], ['ea', 'fontEastAsia', 'ea'], ['cs', 'fontCs', 'cs']]) {
    const face = child(run, tag); if (!face) continue;
    check(face, []); attributes(face, ['typeface']);
    const name = face.getAttribute('typeface'), theme = /^\+(mj|mn)-(lt|ea|cs)$/.exec(name || '');
    if (theme) {
      if (theme[2] !== suffix || !fonts) fail('an unresolved theme font');
      result[key] = fonts(theme[1] === 'mj' ? 'major' : 'minor')[key];
    } else {
      try { result[key] = checkedFontName(name); } catch { fail('an invalid typeface'); }
    }
    if (tag === 'latin') result.fontHAnsi = result.fontAscii;
  }
  return result;
}

// Rich title content is independent of txPr, which supplies inherited styling.
// Reuse the same property validation for paragraph defaults and run overrides.
export function readChartRichTitle(node, inherited, scheme, fonts) {
  const nodes = children(node), body = child(node, 'bodyPr'), list = child(node, 'lstStyle');
  if (!body || nodes.filter(n => n.localName === 'bodyPr').length !== 1
    || nodes.filter(n => n.localName === 'lstStyle').length > 1
    || nodes.some(n => n.namespaceURI !== A || !['bodyPr', 'lstStyle', 'p'].includes(n.localName))) fail('invalid rich title body');
  const properties = (paragraph, base) => {
    const container = node.cloneNode(false); container.append(body.cloneNode(true));
    if (list) container.append(list.cloneNode(true));
    container.append(paragraph); return readChartText(container, base, scheme, fonts);
  };
  const paragraphs = nodes.filter(n => n.localName === 'p').map(p => {
    attributes(p, []);
    const defaults = p.cloneNode(false);
    for (const n of children(p)) if (['pPr', 'endParaRPr'].includes(n.localName)) defaults.append(n.cloneNode(true));
    const base = properties(defaults, inherited), runs = [];
    for (const n of children(p)) {
      if (n.namespaceURI !== A) fail('unsupported rich title namespace');
      if (['pPr', 'endParaRPr'].includes(n.localName)) continue;
      if (n.localName !== 'r') fail('unsupported rich title content');
      attributes(n, []); check(n, ['rPr', 't']);
      const text = child(n, 't'); if (!text || children(text).length) fail('missing rich title text');
      for (const a of text.attributes) if (a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && a.localName === 'space' && ['default', 'preserve'].includes(a.value))) fail('unsupported title text attribute');
      let style = base;
      const override = child(n, 'rPr');
      if (override) {
        const paragraph = p.cloneNode(false), pp = p.ownerDocument.createElementNS(A, 'a:pPr');
        const run = p.ownerDocument.createElementNS(A, 'a:defRPr');
        for (const a of override.attributes) run.setAttributeNS(a.namespaceURI, a.name, a.value);
        for (const c of children(override)) run.append(c.cloneNode(true));
        pp.append(run); paragraph.append(pp); style = properties(paragraph, base);
      }
      if (!['fontSize','fontAscii','bold','italic','color','kerning'].every(k => style?.[k] !== undefined)) fail('inherited rich title formatting');
      if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]|[\uD800-\uDFFF\u{10000}-\u{10FFFF}\r\n]/u.test(text.textContent)) fail('unsupported rich title script or line breaks');
      runs.push({ text: text.textContent, style });
    }
    if (!runs.length && !['fontSize','fontAscii','bold','italic','color','kerning'].every(k => base?.[k] !== undefined)) fail('inherited empty title paragraph formatting');
    return { runs, style: base };
  });
  if (!paragraphs.length || !paragraphs.some(p => p.runs.some(r => r.text.trim()))) fail('empty rich title');
  return paragraphs;
}
