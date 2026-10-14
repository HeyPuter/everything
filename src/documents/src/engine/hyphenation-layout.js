// The line-end decision for automatic hyphenation. Layout calls this when a line overflows inside a
// word; the text itself is never changed: the hyphen is a display-only character at the break.
import { hyphenationPoints, hyphenatedLanguage, lineWordAt } from './hyphenation.js';

/** The visible hyphen shown at an automatic break, after `c`. It occupies no text position. */
export const hyphenCharacter = c => ({ text: '-', autoHyphen: true, discretionaryHyphen: true, start: c.end, end: c.end, style: c.style });

/**
 * Where to break the line [start, …) that overflows at chars[end], or null to keep ordinary
 * word wrapping. `lineEnd(to, hyphen)` measures the line ending before chars[to] (with a hyphen,
 * its full advance; without, its content end). A word is split only when breaking before it would
 * leave more than `zone` pixels free at the margin, and at the latest point whose part and hyphen fit.
 */
export function autoHyphenationBreak(chars, start, end, lastBreak, { right, zone = 24, caps = true, limitReached = false, lineEnd }) {
  if (limitReached) return null;
  const word = lineWordAt(chars, end, 0);
  if (!word) return null;
  // Compounds and words with manual hyphens already have their break opportunities.
  if (['-', '­', '‐'].includes(chars[word.from - 1]?.text) || ['-', '­', '‐'].includes(chars[word.to]?.text)) return null;
  if (chars.slice(word.start, word.end).some(c => !hyphenatedLanguage(c.style?.fontLanguage) || c.style?.vanish)) return null;
  const points = hyphenationPoints(word.text, { caps }).map(p => word.start + p).filter(p => p > start && p <= end);
  if (!points.length) return null;
  if (word.from > start && lastBreak > start && right - lineEnd(word.from, false) <= zone + 1e-6) return null;
  for (let i = points.length - 1; i >= 0; i--) if (lineEnd(points[i], true) <= right + 1e-6) return points[i];
  return null;
}
