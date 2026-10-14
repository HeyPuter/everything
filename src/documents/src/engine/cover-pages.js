import { paragraphText } from './model.js';
import { bookmarkEntries } from './bookmarks.js';

/**
 * Insert → Cover Page: an original title page placed before the document's first paragraph and
 * ended with a page break (`w:br w:type="page"`). Each design is direct paragraph and run formatting on
 * Normal-style paragraphs, so it looks the same in any document and in any consumer.
 * Lines: [role, paragraph format, run format].
 *
 * The cover is marked by a hidden bookmark (`_CoverPage`, ECMA-376 §17.13.6.2: names starting with an
 * underscore are hidden), so it can be found again to replace or remove it after saving and reopening.
 */
const NAVY = '1F3864', BLUE = '2F5597', GRAY = '595959', TEAL = '1E6E6A', SAND = 'F4EFE6', PLUM = '5B2C6F';
export const COVER_BOOKMARK = '_CoverPage';
export const COVER_DESIGNS = Object.freeze([
  { id: 'simple', name: 'Simple', lines: [
    ['title', { alignment: 'center', spaceBefore: 216, spaceAfter: 12 }, { fontSize: 36, bold: true, color: NAVY }],
    ['subtitle', { alignment: 'center', spaceAfter: 120 }, { fontSize: 18, color: GRAY }],
    ['author', { alignment: 'center', spaceAfter: 4 }, { fontSize: 12, color: GRAY }],
    ['date', { alignment: 'center', spaceAfter: 0 }, { fontSize: 12, color: GRAY }],
  ] },
  { id: 'banded', name: 'Banded', lines: [
    ['title', { alignment: 'left', spaceBefore: 180, spaceAfter: 0, paragraphShading: NAVY, indentLeft: 144, indentRight: 144 }, { fontSize: 32, bold: true, color: 'FFFFFF' }],
    ['subtitle', { alignment: 'left', spaceAfter: 240, paragraphShading: 'D9E2F3', indentLeft: 144, indentRight: 144 }, { fontSize: 16, color: NAVY }],
    ['author', { alignment: 'left', spaceAfter: 4, indentLeft: 144 }, { fontSize: 12, color: GRAY }],
    ['date', { alignment: 'left', spaceAfter: 0, indentLeft: 144 }, { fontSize: 12, color: GRAY }],
  ] },
  { id: 'lined', name: 'Lined', lines: [
    ['title', { alignment: 'left', spaceBefore: 168, spaceAfter: 6, paragraphBorders: { bottom: { style: 'single', size: 24, color: BLUE, space: 4 } } }, { fontSize: 34, color: BLUE }],
    ['subtitle', { alignment: 'left', spaceAfter: 216 }, { fontSize: 16, italic: true, color: GRAY }],
    ['author', { alignment: 'right', spaceAfter: 4, paragraphBorders: { top: { style: 'single', size: 6, color: BLUE, space: 4 } } }, { fontSize: 12, bold: true, color: BLUE }],
    ['date', { alignment: 'right', spaceAfter: 0 }, { fontSize: 12, color: GRAY }],
  ] },
  { id: 'sidebar', name: 'Sidebar', lines: [
    ['date', { alignment: 'left', spaceBefore: 96, spaceAfter: 36, indentLeft: 360, paragraphBorders: { left: { style: 'single', size: 48, color: TEAL, space: 12 } } }, { fontSize: 14, bold: true, color: TEAL }],
    ['title', { alignment: 'left', spaceAfter: 6, indentLeft: 360, paragraphBorders: { left: { style: 'single', size: 48, color: TEAL, space: 12 } } }, { fontSize: 40, bold: true, color: '202020' }],
    ['subtitle', { alignment: 'left', spaceAfter: 180, indentLeft: 360, paragraphBorders: { left: { style: 'single', size: 48, color: TEAL, space: 12 } } }, { fontSize: 16, color: TEAL }],
    ['abstract', { alignment: 'left', spaceAfter: 120, indentLeft: 360, indentRight: 1440 }, { fontSize: 11, italic: true, color: GRAY }],
    ['author', { alignment: 'left', spaceAfter: 0, indentLeft: 360 }, { fontSize: 12, bold: true, color: TEAL }],
  ] },
  { id: 'minimal', name: 'Minimal', lines: [
    ['title', { alignment: 'right', spaceBefore: 360, spaceAfter: 4 }, { fontSize: 30, capitalization: 'smallCaps', characterSpacing: 2, color: '262626' }],
    ['subtitle', { alignment: 'right', spaceAfter: 200, paragraphBorders: { bottom: { style: 'single', size: 4, color: 'A6A6A6', space: 8 } } }, { fontSize: 13, color: GRAY }],
    ['author', { alignment: 'right', spaceAfter: 2 }, { fontSize: 11, color: GRAY }],
    ['date', { alignment: 'right', spaceAfter: 0 }, { fontSize: 11, color: GRAY }],
  ] },
  { id: 'block', name: 'Block', lines: [
    ['company', { alignment: 'left', spaceBefore: 0, spaceAfter: 0, paragraphShading: PLUM, indentLeft: 0, indentRight: 0 }, { fontSize: 12, bold: true, capitalization: 'caps', characterSpacing: 1.5, color: 'FFFFFF' }],
    ['title', { alignment: 'left', spaceBefore: 0, spaceAfter: 0, paragraphShading: PLUM }, { fontSize: 44, bold: true, color: 'FFFFFF' }],
    ['subtitle', { alignment: 'left', spaceAfter: 300, paragraphShading: PLUM }, { fontSize: 18, color: 'E8DAEF' }],
    ['author', { alignment: 'left', spaceAfter: 4 }, { fontSize: 12, bold: true, color: PLUM }],
    ['date', { alignment: 'left', spaceAfter: 0 }, { fontSize: 12, color: GRAY }],
  ] },
  { id: 'framed', name: 'Framed', lines: [
    ['title', { alignment: 'center', spaceBefore: 180, spaceAfter: 0, indentLeft: 720, indentRight: 720, paragraphShading: SAND,
      paragraphBorders: { top: { style: 'double', size: 6, color: NAVY, space: 12 }, left: { style: 'double', size: 6, color: NAVY, space: 12 }, right: { style: 'double', size: 6, color: NAVY, space: 12 } } }, { fontSize: 34, color: NAVY }],
    ['subtitle', { alignment: 'center', spaceAfter: 240, indentLeft: 720, indentRight: 720, paragraphShading: SAND,
      paragraphBorders: { bottom: { style: 'double', size: 6, color: NAVY, space: 12 }, left: { style: 'double', size: 6, color: NAVY, space: 12 }, right: { style: 'double', size: 6, color: NAVY, space: 12 } } }, { fontSize: 15, italic: true, color: GRAY }],
    ['author', { alignment: 'center', spaceAfter: 4 }, { fontSize: 12, color: NAVY }],
    ['date', { alignment: 'center', spaceAfter: 0 }, { fontSize: 12, color: GRAY }],
  ] },
]);
/** Placeholder text for the roles a design uses beyond title, subtitle, author and date. */
export const COVER_DEFAULTS = Object.freeze({ abstract: 'Add a short summary of the document here.', company: 'Company name' });

const length = p => paragraphText(p).length;
/** The cover page's range [start, end) including its final page break and paragraph mark, or null. */
export function coverPageRange(model) {
  const mark = bookmarkEntries(model.paragraphs, model.tables).find(b => b.name === COVER_BOOKMARK);
  if (!mark) return null;
  // The bookmark spans the cover's text; the cover runs through its page break and the paragraph mark after it.
  let at = 0, end = mark.end;
  for (const p of model.paragraphs) { const size = length(p); if (at + size >= mark.end) { end = at + size + 1; break; } at += size + 1; }
  return { start: mark.start, end: Math.min(end, model.text.length), id: mark.id };
}

/** Remove the cover page this editor inserted (or one marked the same way). Returns false when there is none. */
export function removeCoverPage(model) {
  const range = coverPageRange(model);
  if (!range) return false;
  // Remove the cover's whole paragraphs, so the paragraph after it keeps its own style and formatting
  // (deleting text across paragraph marks would keep the first cover paragraph's properties instead).
  let at = 0, first = -1, last = -1;
  model.paragraphs.forEach((p, i) => { const end = at + length(p); if (first < 0 && end >= range.start) first = i; if (end + 1 <= range.end) last = i; at = end + 1; });
  const owned = model.paragraphs.slice(first, last + 1);
  if (first < 0 || last < first || last + 1 >= model.paragraphs.length || owned.some(p => p.cellId || p.sectionEnd || p.fieldMarkers?.length || p.bookmarks?.some(b => b.id !== range.id))) {
    model.removeBookmark(range.id); model.select(range.start, range.end); model.replace(''); model.select(range.start);
    return true;
  }
  model.checkpoint();
  model.paragraphs.splice(first, owned.length);
  model.select(Math.min(range.start, model.text.length));
  model.didChange();
  return true;
}

/**
 * Insert a cover page design at the start of the document, replacing the current one.
 * text: { title, subtitle, author, date, abstract?, company? }. Runs inside one engine transaction; returns true.
 */
export function insertCoverPage(model, designId, text) {
  const design = COVER_DESIGNS.find(d => d.id === designId);
  if (!design) throw new Error('Choose a cover page.');
  removeCoverPage(model);
  if (model.paragraphs[0]?.cellId) throw new Error('The document starts with a table. Add a paragraph before it, then insert the cover page.');
  const lines = design.lines.map(([role]) => String(text[role] ?? COVER_DEFAULTS[role] ?? '').replace(/[\n\f\v]/g, ' ').trim() || ' ');
  model.select(0);
  // The cover's own paragraphs, then a page break so the document starts on the next page.
  model.replace(`${lines.join('\n')}\f\n`);
  const normal = model.styles.defaultParagraph;
  let at = 0;
  design.lines.forEach(([, paragraphFormat, runFormat], index) => {
    const size = length(model.paragraphs[index]);
    model.select(at, at + size);
    if (normal && model.styles.definitions[normal]) model.setParagraphStyle(normal);
    model.clearDirectParagraphFormatting();
    model.setParagraphFormat({ ...paragraphFormat, pageBreakBefore: false });
    model.clearDirectTextFormatting();
    model.setRunFormat(runFormat);
    at += size + 1;
  });
  // The page break closes the last cover paragraph; it is outside the bookmark so typing there stays plain.
  model.select(0, at - 2);
  model.addBookmark(COVER_BOOKMARK);
  model.select(0, length(model.paragraphs[0]));
  return true;
}
