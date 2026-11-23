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
/**
 * Comments named after what was drawn, by their intent (IT): an arrow is a line that ends in
 * an arrowhead, a cloud a polygon with a cloudy border, a callout a text box with a pointer.
 */
const INTENT_LABELS = {
  LineArrow: 'Arrow',
  LineDimension: 'Distance',
  PolyLineDimension: 'Perimeter',
  PolygonCloud: 'Cloud',
  PolygonDimension: 'Area',
  FreeTextCallout: 'Callout',
  FreeTextTypeWriter: 'Typewriter text',
};
/** What a comment of `subtype` with the intent `intent` is called. */
export const commentLabel = (subtype, intent) =>
  (String(intent ?? '').startsWith(subtype) && INTENT_LABELS[intent]) ||
  (COMMENT_KINDS[subtype]?.label ?? subtype);
export const MAX_COMMENTS = 2000;

const toHex = (color) =>
  color?.length >= 3
    ? '#' +
      Array.from(color.subarray(0, 3), (c) => Math.round(c).toString(16).padStart(2, '0')).join('')
    : null;

const REVIEW = new Set(['Accepted', 'Rejected', 'Cancelled', 'Completed', 'None']);
/**
 * A page's threads, from what PDF.js reports: for a comment, its review status (the newest one
 * set, as its panel shows it; none when that is None) and how many replies it has, replies to
 * replies included. Review states and members of a comment's group are not replies.
 */
function pageThreads(annotations) {
  const children = new Map();
  annotations.forEach((a, position) => {
    if (!a.inReplyTo) return;
    if (!children.has(a.inReplyTo)) children.set(a.inReplyTo, []);
    children.get(a.inReplyTo).push({ a, position });
  });
  const isState = (a) => a.stateModel != null || (a.state != null && a.subtype === 'Text');
  const when = (a) =>
    (parsePdfDate(a.modificationDate) || parsePdfDate(a.creationDate))?.getTime() ?? 0;
  return {
    of(id) {
      const own = children.get(id) || [];
      const review = own
        .filter(({ a }) => isState(a) && (a.stateModel ?? 'Review') === 'Review')
        .filter(({ a }) => REVIEW.has(a.state))
        .sort((x, y) => when(x.a) - when(y.a) || x.position - y.position);
      const status = review.at(-1)?.a.state;
      let replies = 0;
      const seen = new Set([id]);
      const count = (parent) => {
        for (const { a } of children.get(parent) || []) {
          if (seen.has(a.id) || isState(a) || a.replyType === 'Group') continue;
          seen.add(a.id);
          replies++;
          count(a.id);
        }
      };
      count(id);
      return { status: status && status !== 'None' ? status : null, replies };
    },
  };
}

/**
 * Every comment on every page, in page order: page index, PDF.js id, kind, text, author, date,
 * color, rectangle, review status and number of replies. One comment past MAX_COMMENTS is collected and no more, so a caller can
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
    const ids = new Set(annotations.map((a) => a.id));
    const threads = pageThreads(annotations);
    for (const a of annotations) {
      const kind = COMMENT_KINDS[a.subtype];
      // A reply is listed in its comment's thread; one to a note no longer on the page (another
      // editor deleted it) is offered on the page as a note of its own, and listed as one.
      const reply = a.inReplyTo && (a.subtype !== 'Text' || ids.has(a.inReplyTo));
      // A hidden annotation is not on the page, so it cannot be opened from the list either
      // (the page's note and markup lists leave it out too). PDF.js drops NoView ones itself.
      if (!kind || reply || a.annotationFlags & 2 || !annotationLayerVisible(a, layers)) continue;
      comments.push({
        page: index,
        id: a.id,
        subtype: a.subtype,
        kind: commentLabel(a.subtype, a.it),
        icon: kind.icon,
        reveal: kind.reveal,
        text: String(a.contentsObj?.str ?? a.contents ?? '').trim(),
        author: String(a.titleObj?.str ?? a.title ?? '').trim(),
        date: parsePdfDate(a.modificationDate) || parsePdfDate(a.creationDate),
        hex: toHex(a.color),
        rect: a.rect ? Array.from(a.rect) : null,
        ...threads.of(a.id),
      });
      if (comments.length >= limit) break;
    }
  }
  return comments;
}
