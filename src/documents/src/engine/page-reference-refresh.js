import { bodyFieldRanges } from './body-fields.js';
import { bookmarkEntries } from './bookmarks.js';
import { fieldInstructionTokens, pageFieldInstruction, pageFieldValue } from './docx-page-fields.js';
import { pageNumberSequence } from './page-numbering.js';
import { serializeFragment } from './docx-compatibility.js';
import { checkedHyperlinkDestination, hyperlinkId, hyperlinkRanges } from './hyperlinks.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function referenceOptions(field) {
  const tokens = fieldInstructionTokens(field.instruction, true);
  let suffix = field.instruction.slice(tokens[1].end);
  const relative = tokens.some(t => t.value === '\\p'), hyperlink = tokens.some(t => t.value === '\\h');
  for (const token of tokens.slice(2).reverse()) if (['\\p', '\\h'].includes(token.value)) suffix = suffix.slice(0, token.start - tokens[1].end) + suffix.slice(token.end - tokens[1].end);
  try { return { ...pageFieldInstruction('PAGE ' + suffix), relative, hyperlink }; }
  catch { throw new Error('This PAGEREF uses switches that cannot be refreshed yet; its cached result is retained.'); }
}

function lineFor(layout, position, paragraphId) {
  const lines = layout.lines.filter(l => l.paragraphId === paragraphId);
  // A marker at a wrapped line boundary belongs to the following text line.
  return lines.find(l => l.start <= position && position < l.end) || lines.find(l => l.start === position) || lines.at(-1);
}

export function pageReferencePlan(model, layout, definition, ids) {
  const ranges = bodyFieldRanges(model.paragraphs), byId = new Map(ranges.map(r => [r.field.id, r]));
  const bookmarks = new Map(bookmarkEntries(model.paragraphs, model.tables).map(b => [b.name, b]));
  const numbers = pageNumberSequence(layout.pageSections, definition, layout.numberingApproximations);
  const links = hyperlinkRanges(model.paragraphs);
  const changes = [], issues = [];
  for (const range of ranges) {
    if (range.field.type !== 'PAGEREF' || ids && !ids.has(range.field.id)) continue;
    let owner = range;
    while (owner && !owner.field.locked) owner = byId.get(owner.parentId);
    if (owner?.field.locked) continue;
    try {
      if (ranges.some(child => child.parentId === range.field.id)) throw new Error('A PAGEREF with nested result fields cannot be refreshed yet; its cached result is retained.');
      const options = referenceOptions(range.field), bookmark = bookmarks.get(range.field.bookmark);
      let text, link;
      if (!bookmark) text = 'Error! Bookmark not defined.';
      else {
        const line = lineFor(layout, bookmark.start, bookmark.startParagraph);
        if (!line || numbers[line.page] == null) throw new Error('The PAGEREF bookmark has no resolved text page; its cached result is retained.');
        const section = line.region === undefined ? layout.pageSections[line.page] : layout.pageRegions[line.page]?.[line.region]?.section;
        text = pageFieldValue({ type: 'PAGE', ...options }, { pageNumber: numbers[line.page], pageNumbering: definition?.sections[section]?.pageNumbering });
        if (options.relative) {
          const origin = lineFor(layout, range.start, range.startParagraph);
          if (!origin) throw new Error('The PAGEREF has no resolved source page; its cached result is retained.');
          text = origin.page === line.page ? (bookmark.start < range.start ? 'above' : 'below') : `on page ${text}`;
        }
        if (options.hyperlink) {
          const destination = checkedHyperlinkDestination({ anchor: bookmark.name });
          if (!links.some(l => l.start <= range.start && l.end >= range.end && l.link.anchor === destination.anchor)) link = destination;
        }
      }
      if (model.text.slice(range.start, range.end) !== text || range.field.dirty || link) changes.push({ ...range, text, link });
    } catch (error) { issues.push({ id: range.field.id, message: error.message }); }
  }
  return { changes, issues };
}

function referenceLink(paragraphs, range, destination) {
  const link = { ...destination, id: hyperlinkId() }; let at = 0;
  for (const p of paragraphs) {
    const size = p.runs.reduce((n, r) => n + r.text.length, 0);
    const a = Math.max(0, range.start - at), b = Math.min(size, range.end - at);
    if (b > a) {
      let offset = 0;
      p.runs = p.runs.flatMap(run => {
        const start = offset, end = offset += run.text.length;
        if (end <= a || start >= b) return [run];
        const first = Math.max(start, a), last = Math.min(end, b), result = [];
        if (first > start) result.push({ ...run, text: run.text.slice(0, first - start) });
        result.push({ ...run, text: run.text.slice(first - start, last - start), link: { ...link } });
        if (last < end) result.push({ ...run, text: run.text.slice(last - start) });
        return result;
      });
      // The generated hyperlink owns only the result runs. Field delimiters
      // stay outside it, and simple-field shells contain it as inline content.
    }
    at += size + 1;
  }
}

function cleanDirty(field) {
  if (!field.dirty) return;
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}">${field.source}</w:p>`, 'application/xml').documentElement;
  const delimiter = root.getElementsByTagNameNS(W, 'fldSimple')[0] || [...root.getElementsByTagNameNS(W, 'fldChar')].find(n => n.getAttributeNS(W, 'fldCharType') === 'begin');
  if (!delimiter) throw new Error('A refreshed field has no retained delimiter.');
  delimiter.removeAttributeNS(W, 'dirty');
  field.source = [...root.children].map(serializeFragment).join('');
  field.dirty = false;
}

/** Recompute against actual pagination until field widths and bookmark pages settle. */
export function refreshPageReferences(model, layoutOf, definition, { dirtyOnly = false, checkpoint = true, only = null } = {}) {
  if (!model.hasBodyFields) return { changed: 0, issues: [] };
  const ids = new Set(bodyFieldRanges(model.paragraphs).filter(r => r.field.type === 'PAGEREF' && (!dirtyOnly || r.field.dirty) && (!only || only.has(r.field.id))).map(r => r.field.id));
  if (!ids.size) return { changed: 0, issues: [] };
  const before = model.snapshot(), revision = model.revision, history = [...model.history], future = [...model.future];
  let anchor = before.selection.anchor, focus = before.selection.focus, recorded = false;
  const changed = new Set();
  // A refreshed page number is not a tracked edit: tracked, the old number stayed beside the new one as
  // deleted text, the result never matched the page and every refresh with Track Changes on failed.
  const tracking = model.trackChanges; model.trackChanges = false;
  try {
    for (let pass = 0; pass < 32; pass++) {
      const plan = pageReferencePlan(model, layoutOf(model), definition, ids);
      if (!plan.changes.length) {
        model.select(anchor, focus, before.selection.controlCaret, before.selection.controlSelection);
        model.typingFormat = before.typingFormat; model.typingStyle = before.typingStyle; model.typingDirectCleared = before.typingDirectCleared;
        return { changed: changed.size, issues: plan.issues };
      }
      if (!recorded) { if (checkpoint) model.checkpoint(); recorded = true; }
      for (const change of [...plan.changes].reverse()) {
        const mapPosition = at => at <= change.start ? at : at >= change.end ? at + change.text.length - (change.end - change.start) : change.start + Math.min(at - change.start, change.text.length);
        anchor = mapPosition(anchor); focus = mapPosition(focus);
        model.select(change.start, change.end);
        model.typingFormat = {}; model.typingStyle = null; model.typingDirectCleared = false;
        if (model.text.slice(change.start, change.end) !== change.text) model.replaceResult(change.text, { checkpoint: false });
        const current = bodyFieldRanges(model.paragraphs).find(r => r.field.id === change.field.id), field = current?.field;
        if (!field) throw new Error('Refresh removed the page-reference envelope.');
        cleanDirty(field);
        if (change.link) referenceLink(model.paragraphs, current, change.link);
        model.didChange(); changed.add(field.id);
      }
    }
    throw new Error('Page-reference results did not converge after pagination; the cached results are retained.');
  } catch (error) {
    model.restore(before); model.revision = revision; model.history = history; model.future = future;
    throw error;
  } finally { model.trackChanges = tracking; }
}
