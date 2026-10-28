import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export function readContextualFlag(parent, tag = 'contextualSpacing') {
  const nodes = childElements(parent, W, tag);
  if (nodes.length > 1) throw new UnsupportedDocumentError(`duplicate ${tag}`);
  const node = nodes[0]; if (!node) return undefined;
  if (node.children.length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI === W && a.localName !== 'val')) throw new UnsupportedDocumentError(`unsupported ${tag} content`);
  // ST_OnOff is a union type: XML Schema collapses XML whitespace around
  // its boolean/on/off tokens. Do not accept other Unicode spaces.
  const value = node.getAttributeNS(W, 'val')?.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '') ?? null;
  if (value !== null && !['0', '1', 'false', 'true', 'off', 'on'].includes(value)) throw new UnsupportedDocumentError(`invalid ${tag} value`);
  return value === null || ['1', 'true', 'on'].includes(value);
}
