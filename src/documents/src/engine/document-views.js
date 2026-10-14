/**
 * Document views: how the same document is laid out on screen. Print Layout shows the authored pages;
 * the other views give the layout a screen geometry instead. Nothing here changes the document model,
 * its page settings or its package: each function returns a private display copy.
 *
 * - web: one column the width of the window, no page boundaries, headers or footers; the page colour
 *   runs the full width.
 * - draft: continuous text in a plain white strip, no headers, footers, page borders or floating
 *   drawings; page and section breaks show as labelled dotted rules.
 * - read: the window split into screen pages (columns) of a comfortable width, turned like a book.
 * - outline: shown by the outline surface over the model, not by page layout.
 *
 * Continuous views are laid out as tall strips with no gap between them and then trimmed to their
 * content, so the text reads as one scroll while canvases stay within browser size limits.
 */

export const DOCUMENT_VIEWS = Object.freeze(['print', 'read', 'web', 'outline', 'draft']);
export const CONTINUOUS_VIEWS = Object.freeze(['web', 'draft']);
/** The height of one continuous strip, in layout pixels (1/96 in). */
export const STRIP_HEIGHT = 2400;
/** Reading page colours. Inverse is painted as sepia's opposite by the view (a display filter). */
export const READING_COLORS = Object.freeze({ none: null, sepia: '#F5ECD9', inverse: '#FFFFFF' });
/** Text spacing in Read Mode: more room between lines, paragraphs and letters. */
export const READING_SPACING = Object.freeze({ lineFactor: 1.35, paragraphAfter: 6, character: 0.6 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Is `view` a view whose pages are a screen geometry rather than the authored paper? */
export const isContinuousView = kind => CONTINUOUS_VIEWS.includes(kind);
export const usesScreenGeometry = kind => isContinuousView(kind) || kind === 'read';

/**
 * Screen page geometry for a view, as a function of the authored geometry of a section.
 * `view`: { kind, width, height, color, textSpacing } where width/height are in layout pixels (the
 * window's size divided by zoom). Returns null for views that keep the authored pages.
 */
export function viewGeometry(view) {
  if (!view || !usesScreenGeometry(view.kind)) return null;
  const width = clamp(Math.round(view.width || 816), 240, 6000);
  if (view.kind === 'read') {
    const height = clamp(Math.round(view.height || 1056), 240, 4000);
    const side = clamp(Math.round(width * 0.08), 24, 56), top = clamp(Math.round(height * 0.05), 20, 48);
    return geometry => ({
      ...screenPage(geometry), width, height, left: side, right: side, top, bottom: top,
      background: READING_COLORS[view.color] || geometry.background, backgroundPicture: view.color && view.color !== 'none' ? null : geometry.backgroundPicture,
      ...(view.textSpacing ? { textSpacing: view.textSpacing === true ? READING_SPACING : { ...READING_SPACING, ...view.textSpacing } } : {}),
    });
  }
  const draft = view.kind === 'draft';
  const side = draft ? clamp(Math.round(width * 0.03), 12, 36) : clamp(Math.round(width * 0.04), 16, 48);
  return geometry => ({
    ...screenPage(geometry), width, height: STRIP_HEIGHT, left: side, right: side, top: 0, bottom: 0,
    ...(draft ? { background: '#FFFFFF', backgroundPicture: null } : {}),
  });
}

/** What every screen page drops from the authored paper: margins for stories, borders, columns, gaps. */
function screenPage(geometry) {
  const page = { ...geometry, gap: 0, header: 0, footer: 0, pageBorders: null, columns: null,
    verticalAlignment: 'top', fixedTop: false, fixedBottom: false, screenView: true };
  delete page.bookFold; delete page.bookFoldReferenceMargins; delete page.pageBounds; delete page.boundsBase;
  return page;
}

/**
 * The page stories a view lays out: screen views show no headers or footers (their parts and references
 * stay in the package). Footnotes and endnotes are kept.
 */
export function viewPageStories(definition, kind) {
  if (!definition || !usesScreenGeometry(kind)) return definition;
  return { ...definition, sections: definition.sections.map(section => ({ ...section, header: {}, footer: {}, firstPageDifferent: false })) };
}

/** Text spacing for a measured paragraph format on a page that asks for it (Read Mode). */
export function spacedFormat(format, spacing) {
  if (!spacing) return format;
  const next = { ...format };
  if (next.lineRule === 'auto' || !next.lineRule) next.lineSpacing = Math.min(5, (next.lineSpacing || 1) * spacing.lineFactor);
  else next.lineSpacing = Math.min(600, (next.lineSpacing || 12) * spacing.lineFactor);
  next.spaceAfter = Math.min(600, (next.spaceAfter || 0) + spacing.paragraphAfter);
  return next;
}

/**
 * Continuous views: trim each strip to the content it holds, so strips join without blank space, and
 * recompute the page offsets used for hit testing and vertical caret motion. The layout object is a
 * display copy: its page geometries are replaced, never mutated.
 */
export function fitContinuousPages(layout, storyLayout, { padding = 16, minimum = 48 } = {}) {
  const bottoms = layout.pages.map(() => 0);
  const reach = (page, bottom) => { if (page in bottoms && Number.isFinite(bottom)) bottoms[page] = Math.max(bottoms[page], bottom); };
  for (const line of [...layout.lines, ...(layout.repeatedLines || [])]) if (!line.virtual) reach(line.page, line.y + line.height);
  for (const cell of layout.cells || []) reach(cell.page, cell.y + cell.height);
  for (const frame of layout.floatingObjects || []) reach(frame.page, frame.y + frame.height);
  for (const frame of layout.paragraphFrames || []) reach(frame.page, frame.bottom);
  for (const line of storyLayout?.lines || []) reach(line.page, line.y + line.height);
  const last = layout.pages.length - 1;
  const pages = layout.pages.map((page, index) => {
    // A strip's text ends at its content, plus breathing room at the very end of the document.
    const height = Math.min(page.height, Math.max(minimum, Math.ceil(bottoms[index] + (index === last ? padding * 2 : padding / 2))));
    return { ...page, height };
  });
  let offset = 0;
  const pageOffsets = pages.map(page => { const start = offset; offset += page.height; return start; });
  return { ...layout, pages, pageOffsets, page: { ...layout.page, gap: 0 } };
}

/**
 * Read Mode screens: how many screen pages fit side by side, and how wide each is, for a window of
 * `width` × `height` CSS pixels at a column-width choice ('narrow' | 'default' | 'wide').
 */
export function readingColumns(width, height, choice = 'default', zoom = 1) {
  const target = { narrow: 480, default: 640, wide: 880 }[choice] || 640;
  const gap = 32, usable = Math.max(240, width - 48);
  const count = Math.max(1, Math.min(3, Math.floor((usable + gap) / (Math.min(target, usable) + gap))));
  const column = Math.floor(Math.min(choice === 'wide' && count === 1 ? usable : target * 1.25, (usable - gap * (count - 1)) / count));
  return { count, width: Math.max(240, column) / zoom, height: Math.max(240, height - 32) / zoom, gap };
}

/** Line Focus: the vertical band [top, bottom] on a page that stays clear around `line`, `count` lines tall. */
export function lineFocusBand(lines, line, count = 1) {
  if (!line) return null;
  const same = lines.filter(l => l.page === line.page && !l.virtual && !l.pageStory).sort((a, b) => a.y - b.y);
  const at = same.findIndex(l => l === line || l.start === line.start && l.y === line.y);
  if (at < 0) return { page: line.page, top: line.y, bottom: line.y + line.height };
  const from = Math.max(0, at - Math.floor((count - 1) / 2)), to = Math.min(same.length - 1, from + count - 1);
  return { page: line.page, top: same[from].y, bottom: same[to].y + same[to].height };
}

/**
 * Map a w:view value (§17.15.1.92) to a view and back. 'normal' is Draft; 'masterPages' opens as
 * Outline; 'none' is the default (Print Layout). Read Mode has no ST_View value and is not stored.
 */
export function viewFromSetting(value) {
  return { print: 'print', web: 'web', outline: 'outline', masterPages: 'outline', normal: 'draft', none: 'print' }[value] || null;
}
export function settingFromView(kind) {
  return { print: 'print', web: 'web', outline: 'outline', draft: 'normal' }[kind] || null;
}
