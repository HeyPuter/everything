import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function readTextScale(rPr) {
  const nodes = childElements(rPr, W, 'w');
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate text width');
  const node = nodes[0]; if (!node) return {};
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError('unsupported text width content');
  const value = node.getAttributeNS(W, 'val');
  // Unlike most run measurements, w@val is optional: present without val resets to 100%.
  if (value === null) return { textScale: 100 };
  if (!/^[+-]?\d+$|^\d+%$/.test(value)) throw new UnsupportedDocumentError('invalid text width');
  return { textScale: Number(value.replace(/%$/, '')) };
}
