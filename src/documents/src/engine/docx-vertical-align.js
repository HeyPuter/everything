import { checkedVerticalAlign } from './vertical-align.js';
import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function readRunVertical(rPr) {
  const result = {};
  for (const tag of ['vertAlign', 'position']) {
    const nodes = childElements(rPr, W, tag);
    if (nodes.length > 1) throw new UnsupportedDocumentError(`duplicate run ${tag}`);
    const node = nodes[0]; if (!node) continue;
    if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError(`unsupported run ${tag} content`);
    const value = node.getAttributeNS(W, 'val');
    if (tag === 'vertAlign') {
      try { result.verticalAlign = checkedVerticalAlign(value); } catch (e) { throw new UnsupportedDocumentError(e.message); }
    } else {
      const match = /^([+-]?\d+)$|^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(value ?? '');
      if (!match) throw new UnsupportedDocumentError('invalid manual text position');
      // Numeric values are half-points; universal measures retain their units.
      // Validate the effective value after inheritance so a closer zero can reset it.
      const points = match[1] !== undefined ? Number(match[1]) / 2 : Number(match[2]) * { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 }[match[3]];
      const halfPoints = Math.round(points * 2);
      // Canonicalize conversion noise in declarations as well as effective runs,
      // so style controls and future typing see the same half-point value.
      result.baselineShift = Math.abs(points * 2 - halfPoints) < 1e-9 ? halfPoints / 2 || 0 : points;
    }
  }
  return result;
}
