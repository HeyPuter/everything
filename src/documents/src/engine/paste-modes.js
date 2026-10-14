import { htmlFragment, carriesFormatting } from './clipboard-fragment.js';

/**
 * Paste options: how clipboard content meets the destination.
 *   keep  – Keep Source Formatting: the clipboard's styles, character formatting and lists.
 *   merge – Merge Formatting: the destination's paragraph and font formatting, keeping only emphasis
 *           (bold, italic, underline) and links from the source.
 *   text  – Keep Text Only: plain text in the destination's formatting.
 */
export const PASTE_MODES = Object.freeze({ keep: 'Keep Source Formatting', merge: 'Merge Formatting', text: 'Keep Text Only' });
const EMPHASIS = ['bold', 'italic', 'underlineStyle'];

/** A fragment reduced to emphasis and links, with no paragraph formatting of its own. */
export function mergedFragment(fragment) {
  if (!fragment) return null;
  return { ...fragment, foreign: true, paragraphs: fragment.paragraphs.map(p => ({
    text: p.text, mark: false, styleId: null, styleName: null, alignment: null, list: null,
    runs: p.runs.map(run => ({ ...run, format: Object.fromEntries(EMPHASIS.filter(key => run.format?.[key] !== undefined && run.format[key] !== null && run.format[key] !== false && run.format[key] !== 'none').map(key => [key, run.format[key]])) })),
  })) };
}

/** The HTML to hand the engine for a mode: the source's own for keep, a merged fragment's for merge. */
export function pastePayload(mode, { text = '', html = '' }, fragmentHtml) {
  if (mode === 'text' || !html) return { text, html: '' };
  if (mode === 'keep') return { text, html };
  const merged = mergedFragment(htmlFragment(html));
  return merged ? { text, html: fragmentHtml(merged) } : { text, html: '' };
}

/** Which modes make a difference for this clipboard content in this document. */
export function availablePasteModes(model, { html = '' } = {}) {
  const formatted = !!html && carriesFormatting(model) && !model.tableContext;
  return Object.keys(PASTE_MODES).filter(mode => mode === 'text' || formatted);
}
