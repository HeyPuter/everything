/**
 * Word Count: pages, words, characters with and without spaces, paragraphs and lines, for the
 * document or the selection, optionally including text boxes and notes.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { textStatistics } from '../lib/readability.js';
import { preference } from './review-ui.js';

const INCLUDE_NOTES = preference('documents:word-count-notes', true);
const paragraphText = p => p.runs.map(r => r.text).join('');

/** Paragraphs held in drawings' text boxes, found anywhere inside the assets' scenes. */
export function textBoxParagraphs(assets = {}) {
  const out = [], seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 24 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node.paragraphs) && node.paragraphs.every(p => Array.isArray(p?.runs))) { out.push(...node.paragraphs); return; }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value, depth + 1);
  };
  for (const asset of Object.values(assets)) walk(asset?.scene, 0);
  return out;
}

/** Extra text from text boxes and footnote stories, as paragraph texts. */
export function supplementaryText(engine) {
  const notes = Object.values(engine.pageStories?.stories || {}).filter(story => story.kind === 'footnote' || story.kind === 'endnote').flatMap(story => story.paragraphs || []);
  return [...textBoxParagraphs(engine.model.assets), ...notes].map(paragraphText).filter(t => t.trim());
}

/** The numbers the dialog shows. */
export function wordCountStatistics(engine, { includeNotes = true } = {}) {
  const [a, b] = engine.model.range, selected = engine.session.path === null && a !== b;
  const body = engine.session.body;
  const text = selected ? body.text.slice(a, b) : body.text;
  const extra = !selected && includeNotes ? supplementaryText(engine) : [];
  const stats = textStatistics([text, ...extra].join('\n'));
  const lines = (engine.layout?.lines || []).filter(line => !selected || line.start < b && line.end > a).length;
  return { selected, pages: engine.layout?.pageCount ?? 1, words: stats.words, characters: stats.characters, charactersNoSpaces: stats.charactersNoSpaces, paragraphs: stats.paragraphs, lines };
}

export function openWordCount(engine, { onClose } = {}) {
  engine.finishComposition();
  const include = el('input', { type: 'checkbox', checked: INCLUDE_NOTES.get(), onchange: () => { INCLUDE_NOTES.set(include.checked); render(); } });
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
  const modal = openModal({ title: 'Word Count', onClose, content: el('div.ed-dialog-body', {},
    intro, table,
    el('label.rv-check', {}, include, 'Include text boxes and footnotes'),
    el('div.modal-actions', {}, el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Close'))) });
  return modal;
}
