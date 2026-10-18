// Footnote areas: after pagination, each page reserves room at the foot of its
// text area for the notes referenced on it, separated from the body by a short
// rule. Pagination repeats until the reservations settle (a reference pushed to
// the next page takes its note with it).
import { measurePageStory } from './page-story-measure.js';
import { noteNumbers, noteReferences, numberedParagraphs, footnoteStoryPath } from './footnotes.js';

export const FOOTNOTE_SEPARATOR = 16; // px: the separator paragraph, about one 12pt line
const SEPARATOR_RULE = 192; // px: the separator spans two inches of the text width

/** Notes of `kind` referenced from the body, with their display numbers, or null. */
export function notePlan(definition, paragraphs, kind = 'footnote') {
  const settings = definition?.[kind === 'footnote' ? 'footnotes' : 'endnotes'];
  if (!settings) return null;
  const refs = noteReferences(paragraphs, kind);
  if (!refs.length) return null;
  const numbers = noteNumbers(paragraphs, settings, kind);
  const stories = new Map();
  for (const id of numbers.keys()) {
    const story = definition.stories[footnoteStoryPath(settings.part, id)];
    if (story) stories.set(id, story);
  }
  return { kind, refs, numbers, stories, part: settings.part, settings, restart: settings.restart || 'continuous', position: settings.position || (kind === 'footnote' ? 'pageBottom' : 'docEnd') };
}
/** Footnotes referenced from the body, with their display numbers, or null. */
export const footnotePlan = (definition, paragraphs) => notePlan(definition, paragraphs, 'footnote');
/** Endnotes referenced from the body, with their display numbers, or null. */
export const endnotePlan = (definition, paragraphs) => notePlan(definition, paragraphs, 'endnote');
/** Page-restarted footnote numbers once the notes' pages are known (numRestart eachPage, §17.11.19). */
export function pageRestartedNumbers(plan, paragraphs, placed) {
  const pages = new Map();
  for (const area of placed.footnoteAreas || []) for (const note of area.notes) pages.set(note.id, area.page);
  return noteNumbers(paragraphs, { ...plan.settings, restart: 'eachPage' }, 'footnote', pages);
}

/** The page of each reference: Map(page -> [ids]) in reference order. */
export function assignFootnotes(placed, refs) {
  const pages = new Map(), seen = new Set();
  // Each paragraph's lines, in layout order: a long document has many references and many lines.
  const byParagraph = new Map();
  for (const line of placed.lines) {
    if (line.virtual || line.pageStory) continue;
    const list = byParagraph.get(line.paragraphId);
    if (list) list.push(line); else byParagraph.set(line.paragraphId, [line]);
  }
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    const lines = byParagraph.get(ref.paragraphId) || [];
    const line = lines.find(l => l.start <= ref.position && ref.position < l.end) || lines.find(l => l.start <= ref.position && ref.position <= l.end);
    if (!line) continue;
    seen.add(ref.id);
    if (!pages.has(line.page)) pages.set(line.page, []);
    pages.get(line.page).push(ref.id);
  }
  return pages;
}

/** Measure one note at the page's text width, showing its number. */
export function measureNote(story, display, numbers, geometry, measure, numbering, options = {}) {
  const paragraphs = numberedParagraphs(story.paragraphs, numbers, display);
  return measurePageStory({ ...story, paragraphs }, { ...geometry, storyKind: 'footnote', top: 0, bottom: 0 }, measure, numbering,
    { pageNumber: 1, pageCount: 1, sectionPageCount: 1 }, { styles: options.styles, drawingLayouts: options.drawingLayouts, onUnsupported: options.bestEffort ? () => {} : undefined });
}

/**
 * Lay out with footnote reservations. `layout(reserve)` paginates with `reserve[page]` px kept
 * free above the bottom margin. Returns the final layout with `footnoteAreas`.
 */
export function layoutWithFootnotes(plan, layout, measure, numbering, options) {
  const heights = new Map();
  const noteHeight = (id, geometry) => {
    const key = `${id}/${geometry.width}/${geometry.left}/${geometry.right}`;
    if (!heights.has(key)) {
      try { heights.set(key, measureNote(plan.stories.get(id), plan.numbers.get(id), plan.numbers, geometry, measure, numbering, options).placed.endY); }
      catch (error) { if (!options.bestEffort) throw error; heights.set(key, 0); }
    }
    return heights.get(key);
  };
  const needed = (placed, pages) => {
    const next = {};
    for (const [page, ids] of pages) {
      const geometry = placed.pages[page] || placed.page;
      const notes = ids.filter(id => plan.stories.has(id));
      if (notes.length) next[page] = Math.ceil(FOOTNOTE_SEPARATOR + notes.reduce((sum, id) => sum + noteHeight(id, geometry), 0));
    }
    return next;
  };
  // A reference that only fits without its note's reservation moves to the next
  // page and takes the note along; that can alternate. When a state repeats,
  // reserve the union so the final layout and its note areas agree.
  let reserve = {}, placed, pages;
  const seen = new Set();
  for (let attempt = 0; attempt < 8; attempt++) {
    placed = layout(reserve);
    pages = assignFootnotes(placed, plan.refs);
    const next = needed(placed, pages), key = JSON.stringify(next);
    if (key === JSON.stringify(reserve)) break;
    if (seen.has(key) || attempt === 7) {
      const union = { ...reserve };
      for (const [page, height] of Object.entries(next)) union[page] = Math.max(union[page] || 0, height);
      reserve = union;
      placed = layout(reserve);
      pages = assignFootnotes(placed, plan.refs);
      break;
    }
    seen.add(JSON.stringify(reserve));
    reserve = next;
  }
  const final = needed(placed, pages);
  placed.footnoteAreas = [];
  for (const [page, ids] of pages) {
    const geometry = placed.pages[page] || placed.page, notes = ids.filter(id => plan.stories.has(id));
    if (!notes.length || !final[page]) continue;
    // Never draw notes over body text: start the area below the body's reserved space.
    // Notes placed beneath text (§17.11.21 beneathText) follow the page's last body line instead.
    const height = Math.max(final[page], reserve[page] || 0);
    let top = geometry.height - geometry.bottom - height;
    if (plan.position === 'beneathText') {
      const bodyBottom = Math.max(...placed.lines.filter(line => line.page === page && !line.virtual && !line.pageStory).map(line => line.y + line.height));
      if (Number.isFinite(bodyBottom)) top = Math.min(top, bodyBottom);
    }
    placed.footnoteAreas.push({ page, top, notes: notes.map(id => ({ id, path: footnoteStoryPath(plan.part, id), display: plan.numbers.get(id) })) });
    (placed.columnSeparators ||= []).push({ page, x: geometry.left, y: top + FOOTNOTE_SEPARATOR / 2, width: Math.min(SEPARATOR_RULE, geometry.width - geometry.left - geometry.right), height: 0.75, footnote: true });
  }
  return placed;
}

const ENDNOTE_GAP = 12; // px between the last body line and the endnote separator

/**
 * Place endnotes (§17.11.4) after the document's last body line, continuing on added pages when they do
 * not fit. Each note stays whole on one page. Adds `endnoteAreas` [{ page, top, separator, notes: [{ id,
 * path, display, y }] }] to `placed` and returns it.
 */
export function placeEndnotes(plan, placed, measure, numbering, options) {
  if (!placed.pageCount) return placed;
  const geometryOf = page => placed.pages[page] || placed.page;
  const noteTop = page => placed.footnoteAreas?.find(area => area.page === page)?.top ?? Infinity;
  const bottomOf = page => { const g = geometryOf(page); return Math.min(g.height - g.bottom, noteTop(page)); };
  const heights = new Map();
  const height = (id, geometry) => {
    const key = `${id}/${geometry.width}/${geometry.left}/${geometry.right}`;
    if (!heights.has(key)) {
      try { heights.set(key, measureNote(plan.stories.get(id), plan.numbers.get(id), { footnote: new Map(), endnote: plan.numbers }, geometry, measure, numbering, options).placed.endY); }
      catch (error) { if (!options.bestEffort) throw error; heights.set(key, 0); }
    }
    return heights.get(key);
  };
  const appendPage = () => {
    const last = placed.pageCount - 1, geometry = geometryOf(last), region = placed.pageRegions?.[last]?.at(-1);
    placed.pages.push(geometry); placed.pageSections.push(placed.pageSections[last]);
    (placed.pageRegions ||= []).push(region ? [{ ...region, top: geometry.top, bottom: geometry.top }] : []);
    placed.pageCount++;
    return placed.pageCount - 1;
  };
  let page = placed.pageCount - 1;
  const last = placed.lines.filter(line => line.page === page && !line.virtual && !line.pageStory).map(line => line.y + line.height);
  let y = Math.max(last.length ? Math.max(...last) : geometryOf(page).top, Number.isFinite(placed.endY) ? placed.endY : -Infinity) + ENDNOTE_GAP;
  const ids = [...new Set(plan.refs.map(ref => ref.id))].filter(id => plan.stories.has(id));
  if (!ids.length) return placed;
  // The separator and the first note keep together.
  if (y + FOOTNOTE_SEPARATOR + height(ids[0], geometryOf(page)) > bottomOf(page) && y > geometryOf(page).top + ENDNOTE_GAP) { page = appendPage(); y = geometryOf(page).top; }
  const areas = [{ page, top: y, separator: true, notes: [] }];
  y += FOOTNOTE_SEPARATOR;
  for (const id of ids) {
    let area = areas.at(-1);
    const h = height(id, geometryOf(page));
    if (y + h > bottomOf(page) && area.notes.length) {
      page = appendPage(); y = geometryOf(page).top;
      area = { page, top: y, separator: false, notes: [] }; areas.push(area);
    }
    area.notes.push({ id, path: footnoteStoryPath(plan.part, id), display: plan.numbers.get(id), y });
    y += h;
  }
  placed.endnoteAreas = areas;
  const first = areas[0], geometry = geometryOf(first.page);
  (placed.columnSeparators ||= []).push({ page: first.page, x: geometry.left, y: first.top + FOOTNOTE_SEPARATOR / 2, width: Math.min(SEPARATOR_RULE, geometry.width - geometry.left - geometry.right), height: 0.75, footnote: true });
  return placed;
}
