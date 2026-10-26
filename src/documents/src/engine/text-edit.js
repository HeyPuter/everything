/**
 * The one span of text that differs between two versions of a document's text: the text from `start` to
 * `end` in the first was replaced by `length` characters. null when the texts are the same. A typed
 * character, a deletion or a paste each change one span; anything else is described as one span covering
 * every change. Equal runs on both sides are found by comparing slices, which the engine does natively,
 * so a keystroke in a long document costs microseconds.
 */
export function textEdit(before, after) {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  let low = 0, high = shorter;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (before.slice(low, mid) === after.slice(low, mid)) low = mid; else high = mid - 1;
  }
  const start = low;
  let same = 0, most = shorter - start;
  while (same < most) {
    const mid = (same + most + 1) >> 1;
    if (before.slice(before.length - mid, before.length - same) === after.slice(after.length - mid, after.length - same)) same = mid; else most = mid - 1;
  }
  return { start, end: before.length - same, length: after.length - same - start };
}

/**
 * Where a position lands after an edit. A position where text was inserted stays before the new text,
 * or with `after` goes past it; a position within replaced text moves to the same side of what replaced it.
 */
export function mapPosition(at, edit, after = false) {
  if (at < edit.start || (at === edit.start && !after)) return at;
  if (at > edit.end || (at === edit.end && after)) return at + edit.length - (edit.end - edit.start);
  return after ? edit.start + edit.length : edit.start;
}

/**
 * Ranges ({ start, end, …}) carried across an edit, keeping their other fields. `endAfter` says whether text
 * inserted at a range's end joins it (a tracked insertion grows as its author types on) or stays outside
 * it (a comment's range). Text inserted at a range's start stays outside it either way. A range the edit
 * emptied is left out.
 */
export function followEdit(ranges, edit, { endAfter = false } = {}) {
  const out = [];
  for (const range of ranges) {
    const start = mapPosition(range.start, edit, true), end = Math.max(start, mapPosition(range.end, edit, endAfter));
    if (end === start && range.end > range.start) continue;
    out.push(start === range.start && end === range.end ? range : { ...range, start, end });
  }
  return out;
}
