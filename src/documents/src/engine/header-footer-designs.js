// Insert → Header, Footer and Page Number galleries: original designs written into a header or
// footer story (ECMA-376 Part 1 §17.10) as ordinary paragraphs with direct formatting, tab stops
// (§17.3.1.37) and PAGE / NUMPAGES fields (§17.16.5.44, §17.16.5.42) as page-field runs.
import { pageFieldSegments } from './docx-page-fields.js';
import { paragraphText } from './model.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ACCENT = '2F5597', INK = '404040', SOFT = '7F7F7F';
export const PLACEHOLDER = '[Type here]';

/** A page field record for header/footer stories, as the DOCX reader produces one, showing `cached`. */
export function storyPageField(type, cached = '1') {
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}"><w:fldSimple w:instr=" ${type} "><w:r><w:t>${cached}</w:t></w:r></w:fldSimple></w:p>`, 'application/xml').documentElement;
  const [segment] = pageFieldSegments(root);
  return { ...segment.field, cachedText: cached };
}

/**
 * A line is { paragraph: format, run: format, parts: [text | { field: 'PAGE'|'NUMPAGES' } | { text, run }] }.
 * `width` is the text width in twips, for tab stops at the center and right margin.
 */
const center = width => ({ position: Math.round(width / 2), alignment: 'center', leader: 'none' });
const right = width => ({ position: Math.round(width), alignment: 'right', leader: 'none' });
export const HEADER_DESIGNS = Object.freeze([
  { id: 'blank', name: 'Blank', kinds: ['header', 'footer'], hint: 'One line to type in',
    lines: () => [{ paragraph: {}, run: {}, parts: [PLACEHOLDER] }] },
  { id: 'threeColumns', name: 'Blank (Three Columns)', kinds: ['header', 'footer'], hint: 'Left, center and right text',
    lines: ({ width }) => [{ paragraph: { tabs: [center(width), right(width)] }, run: {}, parts: [PLACEHOLDER, '\t', PLACEHOLDER, '\t', PLACEHOLDER] }] },
  { id: 'title', name: 'Title', kinds: ['header'], hint: 'The document title, centered',
    lines: ({ title }) => [{ paragraph: { alignment: 'center' }, run: { capitalization: 'smallCaps', characterSpacing: 1, color: ACCENT, fontSize: 11 }, parts: [title] }] },
  { id: 'titleDate', name: 'Title and Date', kinds: ['header'], hint: 'Title at the left, date at the right',
    lines: ({ title, date, width }) => [{ paragraph: { tabs: [right(width)] }, run: { color: INK, fontSize: 10 }, parts: [{ text: title, run: { bold: true, color: ACCENT, fontSize: 10 } }, '\t', date] }] },
  { id: 'lined', name: 'Lined', kinds: ['header', 'footer'], hint: 'Title and page number over a rule',
    lines: ({ title, width, kind }) => [{ paragraph: { tabs: [right(width)], paragraphBorders: { [kind === 'header' ? 'bottom' : 'top']: { style: 'single', size: 6, color: ACCENT, space: 4 } } }, run: { color: INK, fontSize: 10 },
      parts: [title, '\t', { field: 'PAGE' }] }] },
  { id: 'banded', name: 'Banded', kinds: ['header', 'footer'], hint: 'White text on a colored band',
    lines: ({ title, width }) => [{ paragraph: { tabs: [right(width)], paragraphShading: ACCENT }, run: { color: 'FFFFFF', fontSize: 10, bold: true }, parts: [` ${title}`, '\t', 'Page ', { field: 'PAGE' }, ' '] }] },
  { id: 'pageOf', name: 'Page X of Y', kinds: ['footer'], hint: 'Centered page count',
    lines: () => [{ paragraph: { alignment: 'center' }, run: { color: SOFT, fontSize: 10 }, parts: ['Page ', { field: 'PAGE' }, ' of ', { field: 'NUMPAGES' }] }] },
  { id: 'accent', name: 'Accent Bar', kinds: ['footer'], hint: 'Page number and a bar at the left',
    lines: () => [{ paragraph: {}, run: { color: SOFT, fontSize: 10 }, parts: [{ text: '', run: { bold: true, color: ACCENT } }, { field: 'PAGE' }, { text: ' | Page', run: { color: SOFT } }] }] },
]);

/** Page number designs: [id, name, parts, run, paragraph extras]. Alignment is chosen per gallery entry. */
export const PAGE_NUMBER_DESIGNS = Object.freeze([
  { id: 'plain', name: 'Plain Number', parts: [{ field: 'PAGE' }], run: {} },
  { id: 'accentBar', name: 'Accent Bar', parts: [{ field: 'PAGE' }, ' | ', 'Page'], run: { color: SOFT } },
  { id: 'pageNumber', name: 'Page Number', parts: ['Page ', { field: 'PAGE' }], run: {} },
  { id: 'pageOf', name: 'Page X of Y', parts: ['Page ', { field: 'PAGE' }, ' of ', { field: 'NUMPAGES' }], run: {} },
  { id: 'dashes', name: 'Dashes', parts: ['– ', { field: 'PAGE' }, ' –'], run: {} },
  { id: 'brackets', name: 'Brackets', parts: ['[ ', { field: 'PAGE' }, ' ]'], run: {} },
  { id: 'bold', name: 'Bold Accent', parts: [{ field: 'PAGE' }], run: { bold: true, color: ACCENT, fontSize: 14 } },
]);

const textOf = part => typeof part === 'string' ? part : part.text ?? '';

/**
 * Write lines into a story model, replacing its contents (or after them when `append`). Runs inside an
 * editor transaction. Text placeholders are selected afterwards so typing replaces the first one.
 */
export function writeStoryLines(model, lines, { append = false, fields = {} } = {}) {
  const field = type => fields[type] || storyPageField(type);
  if (append && model.text.trim()) { model.select(model.text.length); model.replace('\n'); }
  else { model.select(0, model.text.length); if (model.text.length) model.replace(''); }
  lines.forEach((line, index) => {
    if (index) model.replace('\n');
    const at = model.range[0];
    // Paragraph formatting first, so text and fields typed after it share the paragraph's look.
    model.setParagraphFormat({ alignment: 'left', ...line.paragraph });
    for (const part of line.parts) {
      if (typeof part === 'object' && part.field) { model.insertFieldRun(field(part.field)); continue; }
      const text = textOf(part); if (!text) { if (part.run) model.setRunFormat({ ...line.run, ...part.run }); continue; }
      const start = model.range[0];
      model.replace(text);
      model.select(start, start + text.length);
      model.setRunFormat({ ...line.run, ...(typeof part === 'object' ? part.run : {}) });
      model.select(start + text.length);
    }
    if (model.range[0] === at && Object.keys(line.run || {}).length) model.setRunFormat(line.run);
  });
  // Typing replaces the first placeholder, as a gallery design invites.
  const start = model.text.indexOf(PLACEHOLDER);
  if (start >= 0) model.select(start, start + PLACEHOLDER.length);
  return true;
}

/** Remove every paragraph holding a PAGE field from a story model. Returns whether anything changed. */
export function removePageNumberParagraphs(model) {
  let at = 0; const ranges = [];
  for (const p of model.paragraphs) {
    const size = paragraphText(p).length;
    if (p.runs.some(r => r.field?.type === 'PAGE')) ranges.push([at, at + size]);
    at += size + 1;
  }
  if (!ranges.length) return false;
  for (const [start, end] of ranges.reverse()) {
    // A paragraph and its mark; the story keeps at least one paragraph.
    if (end < model.text.length) model.select(start, end + 1);
    else if (start > 0) model.select(start - 1, end);
    else model.select(start, end);
    model.replace('');
  }
  return true;
}
