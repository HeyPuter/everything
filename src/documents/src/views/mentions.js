/** @mentions in comment text: names of people taking part in the document's review. */
import { el } from '../ui/dom.js';

/** Split comment text into plain and @mention pieces for display: [{ text, mention }]. */
export function mentionPieces(text, names = []) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pieces = []; let rest = String(text || ''), plain = '';
  while (rest) {
    const at = rest.indexOf('@');
    if (at < 0) { plain += rest; break; }
    plain += rest.slice(0, at);
    const after = rest.slice(at + 1);
    const name = sorted.find(n => after.toLowerCase().startsWith(n.toLowerCase()) && !/[\p{L}\p{N}]/u.test(after[n.length] || ''));
    if (name && (at === 0 && !plain || !/[\p{L}\p{N}]/u.test(plain.at(-1) || ''))) {
      if (plain) pieces.push({ text: plain }); plain = '';
      pieces.push({ text: `@${after.slice(0, name.length)}`, mention: name });
      rest = after.slice(name.length);
    } else { plain += '@'; rest = after; }
  }
  if (plain) pieces.push({ text: plain });
  return pieces;
}
/** People mentioned in a comment's text. */
export const mentionsIn = (text, names) => mentionPieces(text, names).filter(p => p.mention).map(p => p.mention);

export function renderMentions(text, names) {
  return mentionPieces(text, names).map(p => p.mention ? el('span.rv-mention', { title: `Mentions ${p.mention}` }, p.text) : p.text);
}

