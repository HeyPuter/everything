import { checkedHighlight } from './backgrounds.js';
import { UnsupportedDocumentError } from './errors.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fail = why => { throw new UnsupportedDocumentError(why); };
function single(parent, tag) {
  const nodes = [...(parent?.children || [])].filter(n => n.namespaceURI === W && n.localName === tag);
  if (nodes.length > 1) fail(`duplicate run ${tag}`);
  if (nodes[0]?.children.length) fail(`nested run ${tag}`);
  return nodes[0];
}
export function readRunBackground(rPr, readColor) {
  const result = {}, highlight = single(rPr, 'highlight');
  if (highlight) {
    if ([...highlight.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) fail('unsupported highlight attributes');
    try { result.highlight = checkedHighlight(highlight.getAttributeNS(W, 'val')); } catch (e) { fail(e.message); }
  }
  const shading = single(rPr, 'shd');
  if (shading) {
    const pattern = shading.getAttributeNS(W, 'val');
    if (!['clear', 'solid'].includes(pattern)) fail('run shading other than clear or solid');
    const fill = readColor(rPr, 'shd', 'fill'), color = readColor(rPr, 'shd', 'color');
    result.shading = pattern === 'clear' ? fill : color === 'auto' ? 'foreground' : color;
  }
  return result;
}

// Highlight is not permitted in these contexts ([MS-OI29500] §§2.1.245,
// 2.1.248, 2.1.260, 2.1.291). Keep unused definitions, reject active ones.
// A highlight of none (§17.3.2.15) highlights nothing and is accepted.
export function rejectStyleHighlight(rPr) {
  const highlight = single(rPr, 'highlight');
  if (highlight && highlight.getAttributeNS(W, 'val') !== 'none') fail('highlighting in document defaults, named styles or numbering definitions');
}
