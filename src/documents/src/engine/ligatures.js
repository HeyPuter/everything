import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
export const LIGATURE_MODES = Object.freeze(['none', 'standard', 'contextual', 'historical', 'discretional', 'standardContextual', 'standardHistorical', 'contextualHistorical', 'standardDiscretional', 'contextualDiscretional', 'historicalDiscretional', 'standardContextualHistorical', 'standardContextualDiscretional', 'standardHistoricalDiscretional', 'contextualHistoricalDiscretional', 'all']);
export function checkedLigatures(value) {
  if (!LIGATURE_MODES.includes(value)) throw new UnsupportedDocumentError('invalid ligature mode');
  return value;
}
export function readLigatures(properties) {
  const nodes = childElements(properties, W14, 'ligatures');
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate ligature declaration');
  if (!nodes.length) return {};
  const node = nodes[0];
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI !== XMLNS && !(a.namespaceURI === W14 && a.localName === 'val'))) throw new UnsupportedDocumentError('invalid ligature declaration');
  return { ligatures: checkedLigatures(node.getAttributeNS(W14, 'val')) };
}
export function readOpenTypeFeatures(settings, compatibilityMode = 12) {
  const nodes = [...(settings?.getElementsByTagNameNS(W, 'compatSetting') || [])].filter(n => n.getAttributeNS(W, 'name') === 'enableOpenTypeFeatures' && n.getAttributeNS(W, 'uri') === 'http://schemas.microsoft.com/office/word');
  if (nodes.length > 1) throw new UnsupportedDocumentError('duplicate OpenType compatibility setting');
  // Modern layout defaults this switch on in compatibility mode 15,
  // unlike MS-DOCX §2.3.3's unconditional disabled default. Older modes retain
  // the documented default; an explicit switch remains authoritative.
  if (!nodes.length) return compatibilityMode >= 15;
  const value = nodes[0].getAttributeNS(W, 'val');
  if (!['0', '1', 'false', 'true', 'off', 'on'].includes(value)) throw new UnsupportedDocumentError('invalid OpenType compatibility setting');
  return ['1', 'true', 'on'].includes(value);
}
export function writeLigatures(properties, value) {
  checkedLigatures(value);
  const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  properties.setAttributeNS(XMLNS, 'xmlns:w14', W14);
  properties.setAttributeNS(XMLNS, 'xmlns:mc', mc);
  const ignored = new Set((properties.getAttributeNS(mc, 'Ignorable') || '').split(/\s+/).filter(Boolean));
  ignored.add('w14'); properties.setAttributeNS(mc, 'mc:Ignorable', [...ignored].join(' '));
  for (const child of [...properties.children]) if (child.namespaceURI === W14 && child.localName === 'ligatures') child.remove();
  const node = properties.ownerDocument.createElementNS(W14, 'w14:ligatures');
  node.setAttributeNS(W14, 'w14:val', value);
  properties.insertBefore(node, [...properties.children].find(n => n.namespaceURI === W14 && ['numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'].includes(n.localName)) || null);
}
