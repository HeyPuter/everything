/**
 * The comments in a PDF: sticky notes and markups on every page, gathered from what PDF.js
 * reports so the list can be built without reparsing the file.
 */
import { parsePdfDate } from './notes.js';
import { annotationLayerVisible } from './optional-content.js';

/** Annotation kinds that count as comments, with how the list names and draws them. */
export const COMMENT_KINDS = {
  Text: { label: 'Note', icon: 'StickyNote', reveal: 'note' },
  Highlight: { label: 'Highlight', icon: 'Highlighter', reveal: 'highlight' },
  Underline: { label: 'Underline', icon: 'Underline', reveal: 'highlight' },
  StrikeOut: { label: 'Strikethrough', icon: 'Strikethrough', reveal: 'highlight' },
  // Selected among the drawn comments: the highlight tools redraw only their own three kinds.
  Squiggly: { label: 'Squiggly underline', icon: 'Underline', reveal: null },
  FreeText: { label: 'Text box', icon: 'Type', reveal: null },
  Ink: { label: 'Drawing', icon: 'Pencil', reveal: null },
  Square: { label: 'Rectangle', icon: 'Square', reveal: null },
  Circle: { label: 'Ellipse', icon: 'Circle', reveal: null },
  Line: { label: 'Line', icon: 'Minus', reveal: null },
  Polygon: { label: 'Polygon', icon: 'Square', reveal: null },
  PolyLine: { label: 'Polyline', icon: 'Minus', reveal: null },
  Stamp: { label: 'Stamp', icon: 'Stamp', reveal: null },
  Caret: { label: 'Insertion mark', icon: 'Type', reveal: null },
  FileAttachment: { label: 'Attachment', icon: 'Files', reveal: null },
};
export const MAX_COMMENTS = 2000;

const toHex = (color) =>
  color?.length >= 3
    ? '#' +
      Array.from(color.subarray(0, 3), (c) => Math.round(c).toString(16).padStart(2, '0')).join('')
    : null;

/**
 * Every comment on every page, in page order: page index, PDF.js id, kind, text, author, date,
 * color, and rectangle. One comment past MAX_COMMENTS is collected and no more, so a caller can
 * tell a full list from one that was cut rather than report a total that is short; `isCurrent`
 * can cancel a stale run between pages.
 */
export async function collectComments(pdf, { isCurrent = () => true } = {}) {
  const limit = MAX_COMMENTS + 1;
  const comments = [];
  const layers = await pdf.getOptionalContentConfig?.({ intent: 'display' });
  for (let index = 0; index < pdf.numPages && comments.length < limit; index++) {
    let annotations;
    try {
      annotations = await (await pdf.getPage(index + 1)).getAnnotations({ intent: 'display' });
    } catch {
      annotations = [];
    }
    if (!isCurrent()) return null;
    for (const a of annotations) {
      const kind = COMMENT_KINDS[a.subtype];
      // A hidden annotation is not on the page, so it cannot be opened from the list either
      // (the page's note and markup lists leave it out too). PDF.js drops NoView ones itself.
      if (!kind || a.inReplyTo || a.annotationFlags & 2 || !annotationLayerVisible(a, layers))
        continue;
      comments.push({
        page: index,
        id: a.id,
        subtype: a.subtype,
        kind: kind.label,
        icon: kind.icon,
        reveal: kind.reveal,
        text: String(a.contentsObj?.str ?? a.contents ?? '').trim(),
        author: String(a.titleObj?.str ?? a.title ?? '').trim(),
        date: parsePdfDate(a.modificationDate) || parsePdfDate(a.creationDate),
        hex: toHex(a.color),
        rect: a.rect ? Array.from(a.rect) : null,
      });
      if (comments.length >= limit) break;
    }
  }
  return comments;
}
