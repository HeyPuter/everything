import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export function readRunSpacing(rPr) {
  const result = {}, nodes = childElements(rPr, W, 'spacing');
  if (childElements(rPr, W, 'fitText').length) result.fitText = true;
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate character spacing');
  const node = nodes[0]; if (!node) return result;
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError('unsupported character spacing content');
  const value = node.getAttributeNS(W, 'val'), match = /^([+-]?\d+)$|^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(value ?? '');
  if (!match) throw new UnsupportedDocumentError('invalid character spacing');
  const points = match[1] !== undefined ? Number(match[1]) / 20 : Number(match[2]) * { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }[match[3]];
  const twips = Math.round(points * 20);
  // Normalize conversion noise in declarations too, without flattening inherited values.
  result.characterSpacing = Math.abs(points * 20 - twips) < 1e-8 ? twips / 20 || 0 : points;
  return result;
}
