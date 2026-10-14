// The printed page number of a body position, from a finished layout: the
// page of the line holding it, numbered as the page's section numbers pages
// (§17.6.12 pgNumType). Used by generated indexes and tables of authorities.
import { pageNumberSequence, formatPageNumber } from './page-numbering.js';

/** A function (position, paragraphId) → { page, number, text } for `layout`. */
export function pageLookup(layout, definition) {
  const numbers = pageNumberSequence(layout.pageSections, definition, layout.numberingApproximations);
  const byParagraph = new Map();
  for (const line of layout.lines) {
    if (line.virtual || line.pageStory) continue;
    if (!byParagraph.has(line.paragraphId)) byParagraph.set(line.paragraphId, []);
    byParagraph.get(line.paragraphId).push(line);
  }
  return (position, paragraphId) => {
    const lines = byParagraph.get(paragraphId) || [];
    const line = lines.find(l => l.start <= position && position < l.end) || lines.find(l => l.start === position) || lines.findLast(l => l.start <= position) || lines[0];
    if (!line) return null;
    const number = numbers[line.page] ?? line.page + 1;
    const section = line.region === undefined ? layout.pageSections[line.page] : layout.pageRegions?.[line.page]?.[line.region]?.section;
    let text;
    try { text = formatPageNumber(number, definition?.sections?.[section]?.pageNumbering?.format || 'decimal'); } catch { text = String(number); }
    return { page: line.page, number, text };
  };
}
