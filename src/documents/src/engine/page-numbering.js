import { UnsupportedDocumentError } from './errors.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XMLNS = 'http://www.w3.org/2000/xmlns/';

export function readPageNumbering(section) {
  const nodes = [...section.children].filter(n => n.namespaceURI === W && n.localName === 'pgNumType');
  if (!nodes.length) return undefined;
  const node = nodes[0];
  if (nodes.length !== 1 || node.children.length || [...node.attributes].some(a => a.namespaceURI !== XMLNS &&
      (a.namespaceURI !== W || !['fmt', 'start', 'chapStyle', 'chapSep'].includes(a.localName)))) throw new UnsupportedDocumentError('invalid page numbering properties');
  const result = { format: node.getAttributeNS(W, 'fmt') ?? 'decimal' };
  if (node.hasAttributeNS(W, 'start')) {
    const value = node.getAttributeNS(W, 'start').trim();
    if (!/^[+]?\d+$/.test(value) || Number(value) > 2147483647) throw new UnsupportedDocumentError('unsupported page number start');
    result.start = Number(value);
  }
  if (node.hasAttributeNS(W, 'chapStyle')) result.chapterStyle = node.getAttributeNS(W, 'chapStyle');
  return result;
}

// This formatter is separate from list counters: page zero is blank for Roman
// and alphabetic formats, and Roman values beyond 3999 are permitted.
export function formatPageNumber(value, format = 'decimal') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid page number.');
  if (format === 'decimal') return String(value);
  if (format === 'decimalZero') return String(value).padStart(2, '0');
  if (['lowerLetter', 'upperLetter'].includes(format)) {
    if (!value) return ' ';
    const count = Math.floor((value - 1) / 26) + 1;
    if (count > 128) throw new Error('This alphabetic page number exceeds the preview limit.');
    const text = String.fromCharCode(65 + (value - 1) % 26).repeat(count);
    return format === 'lowerLetter' ? text.toLowerCase() : text;
  }
  if (['lowerRoman', 'upperRoman'].includes(format)) {
    if (!value) return ' ';
    if (value > 128000) throw new Error('This Roman page number exceeds the preview limit.');
    let text = '';
    for (const [number, token] of [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]) {
      const count = Math.floor(value / number); text += token.repeat(count); value %= number;
    }
    return format === 'lowerRoman' ? text.toLowerCase() : text;
  }
  if (format === 'chicago') {
    // Note symbols (§17.18.59 chicago): *, †, ‡, § and then doubled, tripled…
    if (!value) return ' ';
    const count = Math.floor((value - 1) / 4) + 1;
    if (count > 128) throw new Error('This symbol number exceeds the preview limit.');
    return ['*', '\u2020', '\u2021', '\u00a7'][(value - 1) % 4].repeat(count);
  }
  throw new Error(`Unsupported page number format: ${format}.`);
}

export function pageNumberSequence(pageSections, definition, approximations = []) {
  let previous = null, number = 0;
  return pageSections.map(section => {
    if (section === null) return null; // Duplex filler pages have no story/count.
    const start = approximations.some(item => item.section === section) ? undefined : definition?.sections[section]?.pageNumbering?.start;
    number = section !== previous && start !== undefined ? start : number + 1;
    previous = section;
    return number;
  });
}
