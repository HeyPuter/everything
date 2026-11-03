/**
 * Word Count: pages, words, characters with and without spaces, paragraphs and lines, for the
 * document or the selection, optionally including text boxes and notes.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { textStatistics } from '../lib/readability.js';
import { preference } from './review-ui.js';

import { countWords } from '../core/text.js';
import { revisionView, runRevisionDisplay } from '../engine/revisions.js';
import { noteReferences, footnoteStoryPath, footnoteStoryId } from '../engine/footnotes.js';

const INCLUDE_NOTES = preference('documents:word-count-notes', true);
let includeNotesSetting = null;
/** Whether counts take in text boxes, footnotes and endnotes: the Word Count dialog's box, which the status bar follows. */
export const includeNotesInCount = () => (includeNotesSetting ??= INCLUDE_NOTES.get());
const setIncludeNotes = value => { includeNotesSetting = !!value; INCLUDE_NOTES.set(!!value); };

const paragraphText = p => p.runs.map(r => r.text).join('');
// Text the revision view leaves out: a tracked deletion in Simple Markup, No Markup or balloons, an insertion in
// Original. Desktop word processors count what the view shows, so a deletion shown struck out counts, until hidden.
const viewHides = run => !!(run.revision && runRevisionDisplay(run)?.hidden);

/** The text of `paragraphs` between document positions `start` and `end`, as the revision view shows it. */
export function shownText(paragraphs, start = 0, end = Infinity) {
  let at = 0, out = '';
  for (const p of paragraphs) {
    if (at > end) break;
    for (const run of p.runs) {
      const a = at, b = at + run.text.length; at = b;
      if (b <= start || a >= end || viewHides(run)) continue;
      out += a >= start && b <= end ? run.text : run.text.slice(Math.max(0, start - a), Math.min(run.text.length, end - a));
    }
    if (at >= start && at < end) out += '\n';
    at += 1;
  }
  return out;
}
/** A model's text, or the part of it from `start` to `end`, as the view shows it; its own text while it has no changes. */
const modelText = (model, start = 0, end = Infinity) => model.revisions?.length ? shownText(model.paragraphs, start, end) : end === Infinity && !start ? model.text : model.text.slice(start, end);

/** Paragraphs held in drawings' text boxes, found anywhere inside the assets' scenes. */
export function textBoxParagraphs(assets = {}) {
  const out = [], seen = new Set();
  for (const asset of Object.values(assets)) collectScene(asset?.scene, out, seen);
  return out;
}
function collectScene(scene, out, seen) {
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 24 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.paragraphs) && node.paragraphs.every(p => Array.isArray(p?.runs))) { out.push(...node.paragraphs); return; }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, depth + 1);
  };
  walk(scene, 0);
}
/**
 * Paragraphs in the text boxes of the drawings `paragraphs` show. The assets also keep drawings deleted or replaced
 * since the document was opened (an edited text box keeps its earlier text until saving), which are not counted.
 */
function drawingParagraphs(paragraphs, assets = {}) {
  const out = [], seen = new Set();
  for (const p of paragraphs) for (const run of p.runs) if (run.image && !viewHides(run)) collectScene(assets[run.image.assetId]?.scene, out, seen);
  return out;
}

/** The notes the body's references name, as the view shows them (a note whose reference it hides is left out). */
function noteStories(engine) {
  const stories = engine.pageStories, body = engine.session.body;
  if (!stories?.stories) return [];
  const out = [];
  for (const kind of ['footnote', 'endnote']) {
    const refs = noteReferences(body.paragraphs, kind, true);
    if (!refs.length) continue;
    const part = stories[`${kind}s`]?.part;
    for (const { id } of refs) {
      const path = part ? footnoteStoryPath(part, id) : Object.keys(stories.stories).find(key => stories.stories[key].kind === kind && footnoteStoryId(key) === String(id));
      const story = path && stories.stories[path];
      if (story?.paragraphs && story.kind === kind) out.push(story);
    }
  }
  return out;
}

/** Extra text from text boxes and footnote stories, as paragraph texts. */
export function supplementaryText(engine) {
  const body = engine.session.body;
  return [...drawingParagraphs(body.paragraphs, body.assets).map(paragraphText), ...noteStories(engine).map(story => shownText(story.paragraphs))].filter(t => t.trim());
}

/** The text a whole-document count reads: the body as shown, then text boxes and notes when they are included. */
function wholeText(engine, includeNotes) {
  const body = modelText(engine.session.body);
  return includeNotes ? [body, ...supplementaryText(engine)].join('\n') : body;
}
/** The selected text, as shown, in whichever story the caret is in; null with nothing selected. */
function selectedText(engine) {
  const [a, b] = engine.model.range;
  return a === b ? null : modelText(engine.model, a, b);
}
/** Whether the dialog counts the selection: one in the body. Words selected in a header, footer or note are counted against the document's (the status bar's "1 of 7 words"), so the dialog shows the document's. */
const countsSelection = engine => engine.session.path === null && engine.model.range[0] !== engine.model.range[1];

/**
 * The status bar's count: `total` words in the document (text boxes and notes included as the Word Count dialog's
 * box says), `chosen` words selected or null. `cache`, the previous result, is returned when nothing it was counted
 * from has changed: the status bar is refreshed after every caret move and twice for each keystroke.
 */
export function statusWordCount(engine, { includeNotes = includeNotesInCount(), cache = null } = {}) {
  const body = engine.session.body, model = engine.model, [a, b] = model.range, o = revisionView.options;
  const view = `${revisionView.mode}|${o.showInsDel}|${o.balloons}|${(o.hiddenAuthors || []).join()}`;
  const notes = includeNotes ? `${engine.pageStories?.storiesVersion ?? ''}` : null;
  const key = { body, text: body.text, revision: body.revision, view, notes };
  const same = cache && cache.key.body === body && cache.key.text === key.text && cache.key.revision === key.revision && cache.key.view === view && cache.key.notes === notes;
  const total = same ? cache.total : countWords(wholeText(engine, includeNotes));
  const story = { model, text: model.text, revision: model.revision, a, b };
  const sameSelection = same && cache.story.model === model && cache.story.text === story.text && cache.story.revision === story.revision && cache.story.a === a && cache.story.b === b;
  const chosen = sameSelection ? cache.chosen : a !== b ? countWords(selectedText(engine)) : null;
  return { key, story, total, chosen };
}

/** The numbers the dialog shows. */
export function wordCountStatistics(engine, { includeNotes = true } = {}) {
  const [a, b] = engine.model.range, selected = countsSelection(engine);
  const stats = textStatistics(selected ? selectedText(engine) : wholeText(engine, includeNotes));
  const lines = (engine.layout?.lines || []).filter(line => !selected || line.start < b && line.end > a && !line.pageStory).length;
  return { selected, pages: engine.layout?.pageCount ?? 1, words: stats.words, characters: stats.characters, charactersNoSpaces: stats.charactersNoSpaces, paragraphs: stats.paragraphs, lines };
}

export function openWordCount(engine, { onClose, onChange } = {}) {
  engine.finishComposition();
  const include = el('input', { type: 'checkbox', checked: includeNotesInCount(), onchange: () => { setIncludeNotes(include.checked); render(); onChange?.(); } });
  const table = el('table.ed-stats.rv-word-count');
  const intro = el('p.field-hint');
  function render() {
    const s = wordCountStatistics(engine, { includeNotes: include.checked });
    intro.textContent = s.selected ? 'Statistics for the selected text:' : 'Statistics for the whole document:';
    const row = (label, value) => el('tr', {}, el('th', { scope: 'row' }, label), el('td', {}, value.toLocaleString()));
    table.replaceChildren(el('tbody', {}, ...(s.selected ? [] : [row('Pages', s.pages)]), row('Words', s.words), row('Characters (no spaces)', s.charactersNoSpaces), row('Characters (with spaces)', s.characters), row('Paragraphs', s.paragraphs), row('Lines', s.lines)));
    include.disabled = s.selected;
  }
  render();
  // A form, as the other dialogs are: Enter (on the check box too) presses Close, the default button.
  const modal = openModal({ title: 'Word Count', onClose, content: el('form.ed-dialog-body', { onsubmit: e => { e.preventDefault(); modal.close(); } },
    intro, table,
    el('label.rv-check', {}, include, 'Include text boxes, footnotes and endnotes'),
    el('div.modal-actions', {}, el('button.btn.btn-primary', { type: 'submit' }, 'Close'))) });
  return modal;
}
