import { IDEOGRAPHIC } from './dictionary-breaks.js';

// Display spacing only: source text and run properties never acquire this value.
// Native Canvas word-spacing expands U+0020 and U+00A0 without breaking shaping.
export const justificationSpace = text => text === ' ' || text === '\u00a0';
// Arabic is justified by its word spaces as well. Kashida elongation (U+0640 or stretched joins), which
// the reference application can add, is not drawn: justified Arabic lines fill the measure by their
// spaces alone. Text and source runs never acquire kashida characters.

/**
 * Chinese and Japanese are written without spaces: a justified line of them is filled by widening
 * the gaps between characters where the line could have broken (an ideograph or kana on either
 * side, dictionary-breaks.js), as well as its spaces. The indices of the characters followed by
 * such a gap, within [first, last - 1).
 */
function ideographicGaps(span, first, last) {
  const gaps = new Set();
  for (let i = first; i < last - 1; i++) {
    const c = span[i], next = span[i + 1];
    if (c.wordBreak && !c.image && !next.image && !next.ignoredCellBreak && (IDEOGRAPHIC.test(c.text) || IDEOGRAPHIC.test(next.text))) gaps.add(i);
  }
  return gaps;
}

// Distributed alignment widens the gap after every character of the range alike, spaces included.
function characterGaps(span, first, last) {
  const gaps = new Set();
  for (let i = first; i < last - 1; i++) if (!span[i].image && !span[i + 1].image && !span[i].ignoredCellBreak && !span[i + 1].ignoredCellBreak && span[i].text) gaps.add(i);
  return gaps;
}

export function justificationRange(span, measured, right, tab, distribute = false) {
  let first = span.findLastIndex(c => c.text === '\t') + 1, last = span.length;
  while (first < last && (span[first].ignoredCellBreak || justificationSpace(span[first].text))) first++;
  while (last > first && (span[last - 1].ignoredCellBreak || justificationSpace(span[last - 1].text))) last--;
  const spaces = distribute ? 0 : span.slice(first, last).filter(c => justificationSpace(c.text)).length;
  const extra = right - measured.stops.at(-1).x + measured.ignoredTrailingWidth;
  // Earlier fields stay anchored. Justification can expand the final left tab field. A final
  // center, right or decimal field is aligned on its stop: widening it would move that alignment,
  // so the line keeps its natural spacing (a declared approximation; no reference rule is claimed).
  if (tab && tab.alignment !== 'left') return null;
  const ideographs = distribute ? characterGaps(span, first, last) : ideographicGaps(span, first, last);
  const gaps = spaces + ideographs.size;
  if (!gaps || extra <= 1e-6) return null;
  return { first, last, gaps, spacing: extra / gaps, ideographs, distribute };
}

/** The style of span[index] on a line justified (or distributed) with `spacing` (px) across `range`'s gaps. */
export function justifiedStyle(style, range, index, spacing) {
  // Canvas word spacing widens spaces; an ideograph followed by a gap takes the same width as
  // letter spacing, which character spacing expresses in points.
  const words = range.distribute ? 0 : spacing;
  return range.ideographs.has(index)
    ? { ...style, justificationSpacing: words, characterSpacing: (style.characterSpacing || 0) + spacing * 3 / 4 }
    : { ...style, justificationSpacing: words };
}
