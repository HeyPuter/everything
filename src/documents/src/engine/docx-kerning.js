import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function readKerning(rPr) {
  const nodes = childElements(rPr, W, 'kern');
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate kerning threshold');
  const node = nodes[0]; if (!node) return {};
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError('unsupported kerning content');
  const value = node.getAttributeNS(W, 'val'), match = /^([+-]?\d+)$|^(\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(value ?? '');
  if (!match) throw new UnsupportedDocumentError('invalid kerning threshold');
  const points = match[1] !== undefined ? Number(match[1]) / 2 : Number(match[2]) * { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }[match[3]];
  const halves = Math.round(points * 2);
  return { kerning: Math.abs(points * 2 - halves) < 1e-8 ? halves / 2 || 0 : points };
}
