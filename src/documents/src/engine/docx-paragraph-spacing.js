import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const fail = () => { throw new UnsupportedDocumentError('malformed or unsupported paragraph spacing declarations'); };

export function readParagraphSpacing(pPr) {
  const nodes = childElements(pPr, W, 'spacing');
  if (nodes.length > 1) fail();
  const node = nodes[0], result = {};
  if (!node) return result;
  if ([...node.childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && n.textContent.trim())) fail();
  for (const attr of [...node.attributes].filter(a => a.namespaceURI === W)) {
    const { localName: name, value } = attr;
    if (name === 'lineRule') { if (!['auto', 'exact', 'atLeast'].includes(value)) fail(); }
    else if (['beforeAutospacing', 'afterAutospacing'].includes(name)) { if (!['true', 'false', 'on', 'off', '0', '1'].includes(value)) fail(); }
    else if (['before', 'after', 'beforeLines', 'afterLines', 'line'].includes(name)) {
      // Absolute-unit spellings remain outside this declared spacing subset.
      if (!/^[+]?\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) fail();
    } else fail();
    result[name] = value;
  }
  return result;
}
