import { wordBreaks } from './dictionary-breaks.js';

// Units for word-by-word movement include trailing ordinary/NBSP spaces. Punctuation runs and
// structural breaks are separate units; apostrophes inside words are retained.
// Unicode letters/marks and surrogate pairs stay intact. This is caret movement,
// independent of line wrapping, run formatting and DOCX serialization.
//
// Thai, Lao, Khmer and Myanmar write words without spaces between them: a run of their letters is
// split into words where the dictionary (Intl.Segmenter, as for line breaking) places a boundary
// between two of their characters, as Option word steps and double-click already do.
export function wordPosition(text, position, direction, inclusive = false) {
  const units = /(?:[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\p{L}\p{N}\p{M} \u00a0\t\n\r\v\f\u000e\ufffc]+)[ \u00a0]*|[ \u00a0]+|[\t\n\r\v\f\u000e\ufffc]/gu;
  // Where words start within a unit: its own start and any dictionary boundaries inside it.
  const starts = unit => {
    const inside = wordBreaks(unit[0]);
    return inside ? [unit.index, ...[...inside].sort((a, b) => a - b).map(offset => unit.index + offset)] : [unit.index];
  };
  let previous = null;
  // The last word start before the position (or at it, inclusively), in the unit before the next one.
  const back = () => previous ? starts(previous).findLast(start => start < position || inclusive && start === position) : 0;
  for (const unit of text.matchAll(units)) {
    if (direction < 0 && unit.index >= position) return inclusive && unit.index === position ? position : back();
    if (direction > 0 && (unit.index > position || inclusive && unit.index === position)) return unit.index;
    if (direction > 0 && unit.index + unit[0].length > position) {
      const next = starts(unit).find(start => start > position || inclusive && start === position);
      if (next !== undefined) return next;
    }
    previous = unit;
  }
  return direction > 0 ? text.length : back();
}

// Option+Arrow on macOS moves to the start of the previous word going left and
// to the end of the next word going right. Whitespace is skipped; a run of
// adjacent punctuation is one stop, as in native Mac text fields.
export function optionWordPosition(text, position, direction) {
  const units = [];
  for (const s of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (!/\S/u.test(s.segment)) continue;
    const end = s.index + s.segment.length, last = units.at(-1);
    if (!s.isWordLike && last && !last.word && last.end === s.index) last.end = end;
    else units.push({ start: s.index, end, word: !!s.isWordLike });
  }
  if (direction < 0) return units.findLast(unit => unit.start < position)?.start ?? 0;
  return units.find(unit => unit.end > position)?.end ?? text.length;
}
