import { UnsupportedDocumentError } from './errors.js';
import { elementChildren } from './docx-xml.js';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
const MAC = 'http://schemas.microsoft.com/office/mac/drawingml/2011/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const SHADOW = '{53640926-aad7-44d8-bbd7-cce9431645ec}';
const HIDDEN_LINE = '{91240b29-f687-4f45-9708-019b960494df}';
const HIDDEN_FILL = '{909e8e84-426e-40dd-afc4-6f175d3dccd1}';
const MAC_WRAP = '{c572a759-6a51-4108-aa02-dfa0a04fc94b}';
const fail = reason => { throw new UnsupportedDocumentError(`shape extensions with ${reason}`); };
const children = node => elementChildren(node);
function attributes(node, allowed) {
  for (const attr of node.attributes) if (attr.namespaceURI !== XMLNS && (attr.namespaceURI || !allowed.includes(attr.localName))) fail('unknown attributes');
  if ([...node.childNodes].some(n => [3, 4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('unexpected text');
}

function hiddenLine(node) {
  attributes(node, ['w', 'cap', 'cmpd', 'algn']);
  if (node.hasAttribute('w')) {
    const width = node.getAttribute('w').trim();
    if (!/^[+-]?\d+$/.test(width) || Number(width) < 0 || Number(width) > 20116800) fail('invalid saved outline width');
  }
  for (const [name, values] of Object.entries({ cap: ['rnd', 'sq', 'flat'], cmpd: ['sng', 'dbl', 'thickThin', 'thinThick', 'tri'], algn: ['ctr', 'in'] })) {
    if (node.hasAttribute(name) && !values.includes(node.getAttribute(name).trim())) fail('invalid saved outline ' + name);
  }
  // CT_LineProperties has one member of each ordered choice. Its dormant fill,
  // dash, join and end definitions stay opaque in the source package: rendering
  // limitations on active outlines must not discard invisible saved formatting.
  const groups = [['noFill', 'solidFill', 'gradFill', 'pattFill'], ['prstDash', 'custDash'], ['round', 'bevel', 'miter'], ['headEnd'], ['tailEnd'], ['extLst']];
  let previous = -1;
  for (const child of children(node)) {
    const group = groups.findIndex(names => names.includes(child.localName));
    if (child.namespaceURI !== A || group < 0 || group <= previous) fail('invalid saved outline properties');
    previous = group;
  }
}

// MS-ODRAWXML §§2.3.1.12/2.3.3.40. This flag does not create a shadow.
// Callers still reject unsupported effect lists. Preserve the source flag and
// its omitted default; no shadow behavior is materialized in an effect-free scene.
export function readShapeExtensions(properties) {
  const lists = children(properties).filter(n => n.namespaceURI === A && n.localName === 'extLst');
  if (lists.length > 1) fail('duplicate extension lists');
  if (!lists.length) return;
  const list = lists[0]; attributes(list, []);
  const seen = new Set();
  for (const ext of children(list)) {
    attributes(ext, ['uri']);
    const uri = ext.getAttribute('uri')?.toLowerCase();
    if (ext.namespaceURI !== A || ext.localName !== 'ext' || ![SHADOW, HIDDEN_LINE, HIDDEN_FILL, MAC_WRAP].includes(uri) || seen.has(uri)) fail('unknown or duplicate extension');
    seen.add(uri);
    const flags = children(ext), flag = flags[0];
    if (uri === MAC_WRAP) {
      // Independent native reference controls show identical wrapping/paint for absent,
      // omitted, true/false and 1/0 values. Preserve this Mac metadata; active
      // bodyPr wrapping/autofit still follows its separate validation path.
      if (flags.length !== 1 || flag.namespaceURI !== MAC || flag.localName !== 'wrappingTextBoxFlag') fail('invalid Mac wrapping element');
      attributes(flag, ['val']);
      if (children(flag).length) fail('nested Mac wrapping content');
      if (flag.hasAttribute('val') && !['0', '1', 'false', 'true'].includes(flag.getAttribute('val').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''))) fail('invalid Mac wrapping flag');
      continue;
    }
    if (uri === HIDDEN_FILL) {
      // MS-ODRAWXML §2.3.1.5: saved fill information, never active paint.
      // Preserve the dormant subtree even when its active rendering is unsupported.
      if (flags.length !== 1 || flag.namespaceURI !== A14 || flag.localName !== 'hiddenFill') fail('invalid saved fill element');
      attributes(flag, []);
      const fills = children(flag);
      if (fills.length !== 1 || fills[0].namespaceURI !== A || !['noFill', 'solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(fills[0].localName)) fail('invalid saved fill properties');
      continue;
    }
    if (uri === HIDDEN_LINE) {
      // MS-ODRAWXML §2.3.1.6 stores the outline while invisible; it is ignored
      // when an outline is visible too. It never contributes ink or extents.
      if (flags.length !== 1 || flag.namespaceURI !== A14 || flag.localName !== 'hiddenLine') fail('invalid saved outline element');
      hiddenLine(flag); continue;
    }
    if (flags.length !== 1 || flag.namespaceURI !== A14 || flag.localName !== 'shadowObscured') fail('invalid shadow obscuration element');
    attributes(flag, ['val']);
    if (children(flag).length) fail('nested shadow obscuration content');
    if (flag.hasAttribute('val') && !['0', '1', 'false', 'true'].includes(flag.getAttribute('val').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''))) fail('invalid shadow obscuration flag');
  }
}
