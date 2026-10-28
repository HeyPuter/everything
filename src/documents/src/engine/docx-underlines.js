import { checkedUnderline } from './underlines.js';
import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export function readUnderline(rPr, readColor) {
  const nodes = childElements(rPr, W, 'u');
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate underline');
  const node = nodes[0]; if (!node) return {};
  const attrs = ['val', 'color', 'themeColor', 'themeTint', 'themeShade'];
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && !attrs.includes(a.localName))) throw new UnsupportedDocumentError('unsupported underline content');
  const pattern = node.getAttributeNS(W, 'val'), result = {};
  if (pattern !== null) { result.underlineStyle = checkedUnderline(pattern); result.underline = pattern !== 'none'; }
  // MS-OI29500 §2.1.99: omitted pattern/color attributes inherit independently;
  // the final defaults are no underline and automatic color.
  const color = readColor?.(rPr, 'u');
  if (attrs.slice(1).some(a => node.hasAttributeNS(W, a))) result.underlineColor = color ?? 'auto';
  return result;
}
