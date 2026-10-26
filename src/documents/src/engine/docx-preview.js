import { paragraph } from './model.js';
import { MC, alternateBranch } from './docx-compatibility.js';
import { previewMacroButtons } from './docx-macro-buttons.js';
import { runText } from './docx-xml.js';

const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const children = node => [...(node?.children || [])];
const word = (node, name) => WORD.has(node.namespaceURI) && node.localName === name;
const child = (node, name) => children(node).find(n => word(n, name));

// A display-only projection. Never serialize this approximation over the source.
// Walk visible content, not textContent: field instructions, deleted revisions,
// property metadata and unused alternate branches are not document text.
export function previewParagraphs(root) {
  const result = [], runs = [];
  const flush = () => { result.push(paragraph('', { runs: runs.splice(0) })); };
  const walk = (node, format = {}) => {
    if (['p', 'sdtContent', 'hyperlink'].some(name => word(node, name))) node = previewMacroButtons(node);
    if (node.namespaceURI === MC && node.localName === 'AlternateContent') {
      let branch;
      try { branch = alternateBranch(node); }
      catch { branch = children(node).find(n => n.localName === 'Fallback') || children(node).find(n => n.localName === 'Choice'); }
      for (const n of children(branch)) walk(n, format);
      return;
    }
    if (WORD.has(node.namespaceURI)) {
      const name = node.localName;
      if (['pPr', 'rPr', 'sectPr', 'tblPr', 'trPr', 'tcPr', 'sdtPr', 'del', 'moveFrom', 'instrText', 'delText'].includes(name)) return;
      if (name === 'r') {
        const properties = child(node, 'rPr');
        format = { ...format };
        for (const [tag, key] of [['b', 'bold'], ['i', 'italic']]) {
          const property = child(properties, tag);
          if (property) format[key] = !['false', '0', 'off'].includes(property.getAttributeNS(node.namespaceURI, 'val'));
        }
      }
      const text = name === 't' ? runText(node)
        : name === 'tab' ? '\t' : ['br', 'cr'].includes(name) ? '\v'
        : name === 'noBreakHyphen' ? '\u2011' : name === 'softHyphen' ? '\u00ad' : null;
      if (text !== null) { runs.push({ text, ...format }); return; }
      if (name === 'p') {
        if (runs.length) flush();
        for (const n of children(node)) walk(n, format);
        flush(); return;
      }
    }
    for (const n of children(node)) walk(n, format);
  };
  walk(root);
  if (runs.length) flush();
  return result;
}
