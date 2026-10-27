import { inlineSegments } from './images.js';
// Hyperlinks are document structure, independent of character formatting.
let nextLink = 0;
export const hyperlinkId = () => `link${++nextLink}`;
export const internalHyperlink = link => link && Object.hasOwn(link, 'anchor');
export const hyperlinkLabel = link => internalHyperlink(link) ? link.anchor === null ? 'Start of document' : `Bookmark: ${link.anchor}` : link.target;

export function checkedHyperlinkDestination(destination) {
  if (typeof destination === 'string') return { target: checkedHyperlinkTarget(destination) };
  if (!destination || Object.keys(destination).length !== 1 || !Object.hasOwn(destination, 'anchor') || destination.anchor !== null && (typeof destination.anchor !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(destination.anchor))) throw new Error('Choose a bookmark or the start of the document.');
  return { anchor: destination.anchor };
}

export function checkedHyperlinkTarget(target) {
  if (typeof target !== 'string' || /[\s\\\u0000-\u001f\u007f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(target) || /%(?![\da-f]{2})/i.test(target)) throw new Error('Enter an absolute http, https, mailto or tel link without spaces or invalid escapes.');
  let url;
  try { url = new URL(target); } catch { throw new Error('Enter an absolute http, https, mailto or tel link.'); }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) ||
      (['http:', 'https:'].includes(url.protocol) ? !/^https?:\/\/[^/]/i.test(target) || !url.hostname : !url.pathname)) {
    throw new Error('Only absolute http, https, mailto and tel links are supported.');
  }
  return target; // Preserve the relationship's spelling, escaping and fragment.
}

/**
 * Whether a link can be opened from the editor. Imported relationship targets
 * outside the supported schemes (relative paths, file links, unescaped
 * spaces…) are retained as the document's data, but never opened.
 */
export const openableHyperlink = link => {
  if (internalHyperlink(link)) return true;
  try { checkedHyperlinkTarget(link?.target); return true; } catch { return false; }
};

/** The links of the paragraphs from `first` up to `last`, the first starting at document position `offset`. */
export function hyperlinkRanges(paragraphs, first = 0, last = paragraphs.length, offset = 0) {
  const result = [];
  for (let index = first; index < last; index++) {
    const p = paragraphs[index];
    let last = null;
    for (const run of p.runs) {
      const end = offset + run.text.length;
      const link = run.image?.hyperlink || run.link;
      const drawing = !!run.image?.hyperlink;
      if (link && run.text) {
        if (last?.link.id === link.id && last.end === offset && !!last.drawing === drawing) last.end = end;
        else { last = { start: offset, end, link, ...(drawing ? { drawing: true } : {}) }; result.push(last); }
      } else last = null;
      offset = end;
    }
    offset++;
  }
  return result;
}

export function hyperlinkAt(paragraphs, position, affinity = 'forward') {
  return hyperlinkRanges(paragraphs).find(r => affinity === 'backward' ? r.start < position && position <= r.end : r.start <= position && position < r.end) || null;
}

// A caret cannot address part of a grapheme. During typing, a combining mark or
// joined emoji follows the link of its cluster's first character.
export function hyperlinkBoundaryChanges(runs) {
  if (!runs.some(r => r.link)) return [];
  const changes = [], text = runs.map(r => r.text).join('');
  let index = 0, at = 0;
  for (const segment of inlineSegments(text)) {
    const start = segment.index, end = start + segment.segment.length;
    while (index < runs.length && at + runs[index].text.length <= start) at += runs[index++].text.length;
    const link = runs[index]?.link;
    for (let i = index, offset = at; i < runs.length && offset < end; offset += runs[i++].text.length) {
      if (runs[i].link?.id !== link?.id) changes.push({ start: Math.max(offset, start), end: Math.min(offset + runs[i].text.length, end), link });
    }
  }
  return changes;
}
